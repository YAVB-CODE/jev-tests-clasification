/**
 * GPT adapter — OpenAI Chat Completions with Structured Outputs (strict JSON schema).
 *
 * ── Fairness note (see src/shared/task.ts) ─────────────────────────────────────────────────────
 * The request is built ONLY from `buildCanonicalPrompt(task, item)`; GPT sees exactly what Jev sees:
 *  - user message = `JSON.stringify(prompt.state)` — the same `{ task, invoice_line }` Jev gets as `state`.
 *  - system/developer message = `prompt.question` + `prompt.context` + one line per option
 *    (`- "<id>": <criterion>`) + one short output-format sentence (an LLM needs it; Jev's output
 *    is typed by its API). Nothing else about the task is added.
 *  - Option ORDER: Jev receives `criteria` as a JSON object, and JS/JSON orders integer-like keys
 *    (e.g. PUC codes "513530") ascending. To show both engines the options in the SAME order, the
 *    option list and the schema `enum` follow `Object.keys(prompt.criteria)` (= the order in which
 *    they travel to Jev), not `prompt.categoryIds`. The valid set is still `prompt.categoryIds`,
 *    and answers are matched with `matchCategoryId` (exact, no normalisation), like Jev.
 *  - Neither engine ever sees the expected label: the server never receives it.
 *
 * Schema: `{ category: enum, confidence: number }`, both required, no extra properties, and
 * `category` FIRST so its tokens come before anything else (cleaner logprobs; see below).
 *
 * Model families (`isReasoningModel`): classic models get `temperature: 0` and `logprobs: true`;
 * reasoning models (gpt-5*, o-series) get no temperature / logprobs, the `developer` role,
 * `reasoning_effort` when configured and a larger `max_completion_tokens` (reasoning tokens count).
 *
 * Native confidence (classic models only): `nativeConfidence = exp(Σ logprob)` over the output
 * tokens that overlap the `category` value (its characters plus the closing quote, since ending the
 * id is part of the choice) — the model's own probability of the emitted id. Informative only.
 *
 * Retries / timeout follow the shared policy in common.ts (same as Jev): the SDK runs with
 * `maxRetries: 0` and this file owns the loop, each attempt bounded by `cfg.timeoutMs`.
 */
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from 'openai'
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionTokenLogprob,
} from 'openai/resources/chat/completions'
import type {
  AttemptLog,
  ClassificationTask,
  ClassifyAnswer,
  ClassifyResult,
  ClassifyStatus,
  ConceptInput,
  EngineModels,
  TokenUsage,
} from '../../src/shared/contracts.ts'
import { buildCanonicalPrompt, matchCategoryId, type CanonicalPrompt } from '../../src/shared/task.ts'
import { OPENAI_LABEL, type GptConfig } from '../env.ts'
import { cachedListing, gptFallbackModels, gptModelOption, gptPriceFor, isChatGptModel, isReasoningModel, orderModelIds } from '../models.ts'
import { costUsd } from '../pricing.ts'
import {
  NULL_ANSWER,
  RETRY_HTTP_STATUSES,
  clamp01,
  defaultFetch,
  errorMessageOf,
  errorResult,
  instrumentFetch,
  isRetryableStatus,
  missingKeyResult,
  publicEndpoint,
  redactSecrets,
  retryDelayMs,
  roundMs,
  sleep,
  timeoutResult,
  toJsonValue,
  withoutStatusPrefix,
  type ClassifyOptions,
  type EngineAdapter,
  type FetchLike,
} from './common.ts'

// ─────────────────────────────────── Prompt ───────────────────────────────────

/** Option ids in the order Jev receives them (`criteria` keys; see the header). */
export function gptOptionIds(prompt: Pick<CanonicalPrompt, 'criteria'>): string[] {
  return Object.keys(prompt.criteria)
}

export const GPT_OUTPUT_INSTRUCTION =
  'Responde solo con JSON que cumpla el esquema: "category" es el id de la categoría elegida y "confidence" es tu ' +
  'probabilidad, de 0 a 1, de que esa categoría sea la correcta.'

export function buildGptSystemPrompt(prompt: CanonicalPrompt): string {
  const options = gptOptionIds(prompt).map((id) => `- "${id}": ${prompt.criteria[id]}`)
  return [prompt.question, prompt.context, '', 'Opciones:', ...options, '', GPT_OUTPUT_INSTRUCTION].join('\n')
}

export const GPT_SCHEMA_NAME = 'invoice_line_classification'

export interface GptSchema {
  type: 'object'
  properties: {
    category: { type: 'string'; enum: string[] }
    confidence: { type: 'number' }
  }
  required: ['category', 'confidence']
  additionalProperties: false
}

/** Strict schema; `category` must stay the first property (logprobs). */
export function buildGptSchema(prompt: Pick<CanonicalPrompt, 'criteria'>): GptSchema {
  return {
    type: 'object',
    properties: {
      category: { type: 'string', enum: gptOptionIds(prompt) },
      confidence: { type: 'number' },
    },
    required: ['category', 'confidence'],
    additionalProperties: false,
  }
}

// ───────────────────────────────── Model family ─────────────────────────────────

export interface GptModelProfile {
  /** Reasoning model (gpt-5*, o-series): hidden reasoning tokens, accepts reasoning_effort. */
  reasoning: boolean
  /** Reasoning models and gpt-5/6 chat variants reject a non-default temperature. */
  omitTemperature: boolean
  /** Token logprobs (native confidence): classic models only. */
  logprobs: boolean
  /** Reasoning models take instructions in the `developer` role. */
  instructionRole: 'system' | 'developer'
  defaultMaxCompletionTokens: number
}

export const CLASSIC_MAX_COMPLETION_TOKENS = 256
export const REASONING_MAX_COMPLETION_TOKENS = 4096

export function gptModelProfile(model: string): GptModelProfile {
  const reasoning = isReasoningModel(model)
  const gpt5Family = /^gpt-[56]/.test(model.trim().toLowerCase().replace(/^openai\//, ''))
  return {
    reasoning,
    omitTemperature: reasoning || gpt5Family,
    logprobs: !reasoning,
    instructionRole: reasoning ? 'developer' : 'system',
    defaultMaxCompletionTokens: reasoning ? REASONING_MAX_COMPLETION_TOKENS : CLASSIC_MAX_COMPLETION_TOKENS,
  }
}

export function buildGptRequest(
  prompt: CanonicalPrompt,
  cfg: Pick<GptConfig, 'model' | 'reasoningEffort' | 'maxCompletionTokens'>,
): ChatCompletionCreateParamsNonStreaming {
  const profile = gptModelProfile(cfg.model)
  const params: ChatCompletionCreateParamsNonStreaming = {
    model: cfg.model,
    messages: [
      { role: profile.instructionRole, content: buildGptSystemPrompt(prompt) },
      { role: 'user', content: JSON.stringify(prompt.state) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: GPT_SCHEMA_NAME, strict: true, schema: { ...buildGptSchema(prompt) } },
    },
    max_completion_tokens: cfg.maxCompletionTokens ?? profile.defaultMaxCompletionTokens,
  }
  if (!profile.omitTemperature) params.temperature = 0
  if (profile.logprobs) params.logprobs = true
  if (profile.reasoning && cfg.reasoningEffort) params.reasoning_effort = cfg.reasoningEffort
  return params
}

// ─────────────────────────────────── Parsing ───────────────────────────────────

export interface ParsedGpt {
  status: Extract<ClassifyStatus, 'ok' | 'invalid'>
  answer: ClassifyAnswer
  errorMessage?: string
  /** The JSON object the model produced, when it parsed. */
  parsed?: unknown
}

function invalid(errorMessage: string, parsed?: unknown): ParsedGpt {
  return { status: 'invalid', answer: { ...NULL_ANSWER }, errorMessage, ...(parsed !== undefined ? { parsed } : {}) }
}

function stripCodeFence(text: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text)
  return fenced ? fenced[1] : text
}

function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return (text ?? String(value)).slice(0, 60)
}

/**
 * Parses the assistant message. `category` is matched with `matchCategoryId` (exact, no case folding
 * or trimming): a value outside the set is an invalid answer, which is part of what we measure.
 */
export function parseGptContent(
  content: string | null | undefined,
  categoryIds: readonly string[],
  refusal?: string | null,
  finishReason?: string | null,
): ParsedGpt {
  if (refusal && refusal.trim()) return invalid(`El modelo se negó a responder: ${refusal.trim().slice(0, 200)}`)
  if (finishReason === 'length') {
    return invalid(
      'Respuesta truncada: se agotó max_completion_tokens (finish_reason=length). Sube OPENAI_MAX_COMPLETION_TOKENS.',
    )
  }
  const text = stripCodeFence((content ?? '').trim())
  if (!text) {
    if (finishReason === 'content_filter') return invalid('Respuesta vacía: bloqueada por el filtro de contenido.')
    return invalid('Respuesta vacía del modelo.')
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return invalid(`JSON malformado: ${text.slice(0, 80)}`)
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return invalid('La salida no es un objeto JSON.', data)
  }
  const obj = data as Record<string, unknown>
  const categoryId = matchCategoryId(obj.category, categoryIds)
  if (categoryId === null) {
    return invalid(`"category" fuera del conjunto de categorías: ${preview(obj.category)}`, data)
  }
  const answer: ClassifyAnswer = { categoryId }
  const confidence = clamp01(obj.confidence)
  if (confidence !== undefined) answer.confidence = confidence
  return { status: 'ok', answer, parsed: data }
}

// ─────────────────────────────── Logprob confidence ───────────────────────────────

/** The subset of OpenAI's `ChatCompletionTokenLogprob` we need. */
export type LogprobToken = Pick<ChatCompletionTokenLogprob, 'token' | 'logprob'> & { bytes?: number[] | null }

export interface CategoryLogprob {
  /** The decoded `category` value found in the token stream. */
  value: string
  /** Σ logprob of the tokens overlapping the value (and its closing quote). */
  logprob: number
  /** exp(logprob), in [0, 1]. */
  confidence: number
  /** The overlapping tokens, in order. */
  tokens: Array<{ token: string; logprob: number }>
}

const QUOTE = 0x22
const BACKSLASH = 0x5c
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function isJsonSpace(byte: number | undefined): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09
}

function skipSpace(bytes: Uint8Array, i: number): number {
  while (i < bytes.length && isJsonSpace(bytes[i])) i++
  return i
}

/** `i` is at an opening quote; returns the index of the closing quote, or -1. */
function closingQuote(bytes: Uint8Array, i: number): number {
  for (let j = i + 1; j < bytes.length; j++) {
    if (bytes[j] === BACKSLASH) j++
    else if (bytes[j] === QUOTE) return j
  }
  return -1
}

/** Index just past the JSON value starting at `i` (string, number, literal, object or array), or -1. */
function skipValue(bytes: Uint8Array, i: number): number {
  if (bytes[i] === QUOTE) {
    const end = closingQuote(bytes, i)
    return end < 0 ? -1 : end + 1
  }
  let depth = 0
  for (let j = i; j < bytes.length; j++) {
    const b = bytes[j]
    if (b === QUOTE) {
      j = closingQuote(bytes, j)
      if (j < 0) return -1
    } else if (b === 0x7b || b === 0x5b) depth++ // { [
    else if (b === 0x7d || b === 0x5d) {
      // } ]
      if (depth === 0) return j
      depth--
      if (depth === 0) return j + 1
    } else if (depth === 0 && (b === 0x2c || isJsonSpace(b))) return j // ,
  }
  return depth === 0 ? bytes.length : -1
}

function decodeJsonString(bytes: Uint8Array, start: number, end: number): string | undefined {
  try {
    const value: unknown = JSON.parse(`"${decoder.decode(bytes.subarray(start, end))}"`)
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Byte span of the string value of top-level `key` in a JSON object: `start` = first byte of the
 * value, `end` = index of its closing quote. Scans bytes: JSON's structural characters are ASCII and
 * never occur inside a multi-byte UTF-8 sequence, so this is exact even when tokens split characters.
 */
function topLevelStringSpan(bytes: Uint8Array, key: string): { start: number; end: number } | undefined {
  let i = skipSpace(bytes, 0)
  if (bytes[i] !== 0x7b) return undefined // {
  i++
  for (;;) {
    i = skipSpace(bytes, i)
    if (bytes[i] !== QUOTE) return undefined
    const keyEnd = closingQuote(bytes, i)
    if (keyEnd < 0) return undefined
    const name = decodeJsonString(bytes, i + 1, keyEnd)
    i = skipSpace(bytes, keyEnd + 1)
    if (bytes[i] !== 0x3a) return undefined // :
    i = skipSpace(bytes, i + 1)
    if (name === key) {
      if (bytes[i] !== QUOTE) return undefined
      const end = closingQuote(bytes, i)
      return end < 0 ? undefined : { start: i + 1, end }
    }
    i = skipValue(bytes, i)
    if (i < 0) return undefined
    i = skipSpace(bytes, i)
    if (bytes[i] !== 0x2c) return undefined // , (anything else: end of object or malformed)
    i++
  }
}

/**
 * Native confidence of the chosen category from token logprobs: rebuilds the emitted text from the
 * tokens (their UTF-8 `bytes` when present), finds the value of the top-level `category` key and
 * returns exp(Σ logprob) over the tokens overlapping that value plus its closing quote. Returns
 * undefined when there are no logprobs, the value is not found, or it differs from `expected`.
 */
export function categoryLogprob(
  tokens: readonly LogprobToken[] | null | undefined,
  expected?: string,
  key = 'category',
): CategoryLogprob | undefined {
  if (!tokens || tokens.length === 0) return undefined
  const pieces = tokens.map((t) => (Array.isArray(t.bytes) ? Uint8Array.from(t.bytes) : encoder.encode(t.token)))
  const bytes = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0))
  const offsets: number[] = []
  let at = 0
  for (const piece of pieces) {
    offsets.push(at)
    bytes.set(piece, at)
    at += piece.length
  }

  const span = topLevelStringSpan(bytes, key)
  if (!span) return undefined
  const value = decodeJsonString(bytes, span.start, span.end)
  if (value === undefined || value === '' || (expected !== undefined && value !== expected)) return undefined

  const spanEnd = span.end + 1 // include the closing quote: ending the id is part of the choice
  let logprob = 0
  const overlapping: CategoryLogprob['tokens'] = []
  for (let k = 0; k < tokens.length; k++) {
    const from = offsets[k]
    const to = from + pieces[k].length
    if (from >= spanEnd || to <= span.start || to === from) continue
    const lp = tokens[k].logprob
    if (typeof lp !== 'number' || !Number.isFinite(lp)) return undefined
    logprob += lp
    overlapping.push({ token: tokens[k].token, logprob: lp })
  }
  if (overlapping.length === 0) return undefined
  return { value, logprob, confidence: Math.min(1, Math.max(0, Math.exp(logprob))), tokens: overlapping }
}

// ─────────────────────────────────── Errors ───────────────────────────────────

const PREFIX = 'OpenAI'

/** Same wording as the Jev adapter ("solicitud cancelada …"). */
export const GPT_ABORTED_MESSAGE = `${PREFIX}: solicitud cancelada por el cliente (cerró la conexión o agotó su tiempo).`

/** Spanish, redacted, ready for the UI. `attempts` > 1 adds "(tras N intentos)", like the Jev adapter. */
export function describeGptError(error: unknown, model: string, secrets: Array<string | undefined>, attempts = 1): string {
  const clean = (text: string) => redactSecrets(text, secrets)
  const tries = attempts > 1 ? ` (tras ${attempts} intentos)` : ''
  if (error instanceof APIUserAbortError) return GPT_ABORTED_MESSAGE
  if (error instanceof APIConnectionTimeoutError) return `${PREFIX}: tiempo de conexión agotado.`
  if (error instanceof APIConnectionError) {
    const cause = error.cause instanceof Error && error.cause.cause instanceof Error ? error.cause.cause : (error.cause ?? error)
    return clean(`${PREFIX}: error de red${tries}: ${errorMessageOf(cause)}`)
  }
  if (error instanceof APIError && typeof error.status === 'number') {
    const status = error.status
    const detail = withoutStatusPrefix(error.message, status)
    const suffix = detail ? `: ${detail}` : ''
    let text: string
    if (status === 401) text = `${PREFIX} 401: API key inválida o revocada (revisa OPENAI_API_KEY)`
    else if (status === 403) text = `${PREFIX} 403: acceso denegado para esta key (modelo, organización o región)${suffix}`
    else if (status === 404) text = `${PREFIX} 404: el modelo «${model}» no existe o la key no tiene acceso${suffix}`
    else if (status === 429) text = `${PREFIX} 429: límite de solicitudes excedido o cuota agotada${tries}${suffix}`
    else if (status >= 500) text = `${PREFIX} ${status}: error del proveedor${tries}${suffix}`
    else text = `${PREFIX} ${status}: solicitud rechazada${tries}${suffix}`
    return clean(text)
  }
  return clean(`${PREFIX}: error inesperado: ${errorMessageOf(error)}`)
}

// ─────────────────────────────── Retry loop ───────────────────────────────

type Outcome =
  | { kind: 'ok'; completion: ChatCompletion; requestId: string | null }
  | { kind: 'timeout' }
  | { kind: 'aborted' }
  | { kind: 'error'; error: unknown }

/** Network failure worth a retry (not an abort, not a timeout). */
function isNetworkError(error: unknown): boolean {
  return error instanceof APIConnectionError && !(error instanceof APIConnectionTimeoutError)
}

function statusOf(error: unknown): number | undefined {
  return error instanceof APIError && typeof error.status === 'number' ? error.status : undefined
}

/** One HTTP attempt bounded by `timeoutMs` (headers AND body); the caller's signal aborts it too. */
async function attemptOnce(
  client: OpenAI,
  params: ChatCompletionCreateParamsNonStreaming,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Outcome> {
  const timer = new AbortController()
  const handle = setTimeout(() => timer.abort(new Error('attempt timeout')), timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal
  // Settles on abort even if a body read ignores the signal, so an attempt can never outlive its timer.
  const abortedPromise = new Promise<never>((_resolve, reject) => {
    if (combined.aborted) reject(combined.reason)
    else combined.addEventListener('abort', () => reject(combined.reason), { once: true })
  })
  try {
    const request = client.chat.completions.create(params, { signal: combined }).withResponse()
    const { data, request_id } = await Promise.race([request, abortedPromise])
    return { kind: 'ok', completion: data, requestId: request_id }
  } catch (error) {
    if (signal?.aborted || timer.signal.aborted) {
      // Let the aborted fetch settle so instrumentFetch has logged this attempt before we report it.
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    if (signal?.aborted) return { kind: 'aborted' }
    if (timer.signal.aborted || error instanceof APIConnectionTimeoutError) return { kind: 'timeout' }
    return { kind: 'error', error }
  } finally {
    clearTimeout(handle)
  }
}

/** Shared policy (common.ts): retry 408/429/5xx/529 and network failures; never after a timeout or an abort. */
async function callWithRetries(
  client: OpenAI,
  params: ChatCompletionCreateParamsNonStreaming,
  cfg: Pick<GptConfig, 'timeoutMs' | 'maxRetries'>,
  signal: AbortSignal | undefined,
): Promise<Outcome> {
  for (let retry = 0; ; retry++) {
    if (signal?.aborted) return { kind: 'aborted' }
    const outcome = await attemptOnce(client, params, cfg.timeoutMs, signal)
    if (outcome.kind !== 'error') return outcome
    const status = statusOf(outcome.error)
    const retryable = status !== undefined ? isRetryableStatus(status) : isNetworkError(outcome.error)
    if (!retryable || retry >= cfg.maxRetries) return outcome
    const headers = outcome.error instanceof APIError ? outcome.error.headers : undefined
    try {
      await sleep(retryDelayMs(headers ? { headers } : null, retry + 1), signal)
    } catch {
      return { kind: 'aborted' }
    }
  }
}

// ─────────────────────────────────── Adapter ───────────────────────────────────

export interface GptAdapterDeps {
  /** Injected in tests; defaults to the global fetch. */
  fetch?: FetchLike
}

/** Backstop only: our per-attempt timer (cfg.timeoutMs) fires first and also covers the body. */
const SDK_TIMEOUT_MARGIN_MS = 1_000

function usageOf(completion: ChatCompletion): TokenUsage | undefined {
  const u = completion.usage
  if (!u) return undefined
  return { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 }
}

/** SDK default; passed explicitly so the SDK never falls back to process.env on its own. */
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1'

export function createGptAdapter(cfg: GptConfig, deps: GptAdapterDeps = {}): EngineAdapter {
  const baseFetch = deps.fetch ?? defaultFetch
  const secrets = [cfg.apiKey]
  const baseURL = (cfg.baseURL ?? OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, '')
  const endpoint = `${baseURL}/chat/completions`

  const newClient = (fetch: FetchLike, maxRetries: number) =>
    new OpenAI({
      apiKey: cfg.apiKey,
      baseURL,
      timeout: cfg.timeoutMs + SDK_TIMEOUT_MARGIN_MS,
      maxRetries,
      fetch,
    })

  async function classify(task: ClassificationTask, item: ConceptInput, options: ClassifyOptions = {}): Promise<ClassifyResult> {
    const model = options.model?.trim() || cfg.model
    if (!cfg.apiKey) return missingKeyResult('gpt', model, 'OPENAI_API_KEY')

    const prompt = buildCanonicalPrompt(task, item)
    const params = buildGptRequest(prompt, { ...cfg, model })
    const profile = gptModelProfile(model)
    const price = gptPriceFor(model, cfg)
    // Exact body sent + call options (same shape as the Jev adapter). No secrets.
    const rawRequest = {
      ...toJsonValue<ChatCompletionCreateParamsNonStreaming>(params),
      options: { endpoint: publicEndpoint(endpoint), timeoutMs: cfg.timeoutMs, maxRetries: cfg.maxRetries, retryHttpStatuses: [...RETRY_HTTP_STATUSES] },
    }
    const attempts: AttemptLog[] = []
    const started = performance.now()
    const elapsed = () => roundMs(performance.now() - started)

    if (options.signal?.aborted) {
      return errorResult('gpt', model, GPT_ABORTED_MESSAGE, { attempts, providerLatencyMs: 0, raw: { request: rawRequest } })
    }

    let outcome: Outcome
    try {
      const client = newClient(instrumentFetch(baseFetch, attempts), 0) // retries are ours (shared policy)
      outcome = await callWithRetries(client, params, cfg, options.signal)
    } catch (error) {
      outcome = { kind: 'error', error }
    }
    const providerLatencyMs = elapsed()
    const failure = (response: unknown): Partial<ClassifyResult> => ({
      attempts,
      providerLatencyMs,
      raw: { request: rawRequest, response },
    })

    if (outcome.kind === 'aborted') return errorResult('gpt', model, GPT_ABORTED_MESSAGE, failure({ error: 'aborted' }))
    if (outcome.kind === 'timeout') {
      const last = attempts.at(-1)
      if (last && last.status === null) last.error = `timeout (${cfg.timeoutMs} ms)`
      return timeoutResult('gpt', model, cfg.timeoutMs, failure({ error: 'timeout' }))
    }
    if (outcome.kind === 'error') {
      const { error } = outcome
      const message = describeGptError(error, model, secrets, attempts.length)
      const status = statusOf(error)
      const response =
        error instanceof APIError && status !== undefined
          ? { status, body: redactSecrets(JSON.stringify(error.error) ?? '', secrets), requestId: error.requestID ?? null }
          : { error: isNetworkError(error) ? 'network' : 'unexpected' }
      return errorResult('gpt', model, message, failure(response))
    }

    const { completion, requestId } = outcome
    const choice = completion.choices?.[0]
    const message = choice?.message
    const parsed: ParsedGpt = choice
      ? parseGptContent(message?.content, prompt.categoryIds, message?.refusal, choice.finish_reason)
      : invalid('La respuesta no trae choices.')

    const answer: ClassifyAnswer = { ...parsed.answer }
    const tokens = choice?.logprobs?.content
    const native = profile.logprobs && parsed.status === 'ok' ? categoryLogprob(tokens, answer.categoryId ?? undefined) : undefined
    if (native) {
      answer.nativeConfidence = native.confidence
      answer.nativeConfidenceKind = 'logprob'
    }

    const usage = usageOf(completion)
    const result: ClassifyResult = {
      engine: 'gpt',
      mode: 'live',
      model: completion.model || model,
      status: parsed.status,
      answer,
      providerLatencyMs,
      attempts,
      raw: {
        request: rawRequest,
        response: {
          id: completion.id ?? null,
          model: completion.model ?? null,
          content: message?.content ?? null,
          refusal: message?.refusal ?? null,
          finish_reason: choice?.finish_reason ?? null,
          usage: completion.usage ?? null,
          system_fingerprint: completion.system_fingerprint ?? null,
          requestId,
          logprobs: tokens
            ? {
                tokenCount: tokens.length,
                category: native ? { value: native.value, logprob: native.logprob, tokens: native.tokens } : null,
              }
            : null,
          pricing: price ? { ...price.prices, source: price.source } : null,
        },
      },
    }
    if (parsed.errorMessage) result.errorMessage = parsed.errorMessage
    if (usage) {
      result.usage = usage
      // Unknown price (not in the table, not OPENAI_MODEL with .env prices) → no cost rather than a wrong one.
      if (price) result.costUsd = costUsd(usage, price.prices)
    }
    return result
  }

  const listModels = cachedListing(async (): Promise<EngineModels> => {
    if (!cfg.apiKey) return gptFallbackModels(cfg)
    try {
      const ids: string[] = []
      for await (const m of newClient(baseFetch, cfg.maxRetries).models.list()) ids.push(m.id)
      const chat = ids.filter(isChatGptModel)
      if (chat.length === 0) return gptFallbackModels(cfg, 'OpenAI no listó modelos de chat compatibles.')
      return {
        default: cfg.model,
        provider: OPENAI_LABEL,
        models: orderModelIds(chat, cfg.model).map((id) => gptModelOption(id, cfg)),
        source: 'provider',
      }
    } catch (error) {
      return gptFallbackModels(cfg, describeGptError(error, cfg.model, secrets))
    }
  })

  return {
    engine: 'gpt',
    live: Boolean(cfg.apiKey),
    model: cfg.model,
    provider: OPENAI_LABEL,
    async classify(task, item, options) {
      try {
        return await classify(task, item, options)
      } catch (error) {
        // Last-resort guard: classify never throws.
        return errorResult('gpt', options?.model?.trim() || cfg.model, describeGptError(error, cfg.model, secrets))
      }
    },
    listModels: (force = false) => listModels(force),
  }
}
