/**
 * Jev adapter — Jev «System One» served by OpenCode Zen: `POST {OPENCODE_BASE_URL}/v1/systemone`
 * (https://opencode.ai/docs/zen; fields per https://docs.typesafe.ai/api), called with plain fetch.
 *
 * ── Fairness ────────────────────────────────────────────────────────────────────────────────────
 * The request is built ONLY from `buildCanonicalPrompt(task, item)` (src/shared/task.ts):
 *   { model, state: prompt.state,
 *     questions: { category: { type: 'choice',
 *                              instructions: { question: prompt.question, context: prompt.context },
 *                              criteria: prompt.criteria } } }
 *  - `state` = `{ task: instructions, invoice_line: serializeConcept(item) }`: no item id, no label.
 *  - `criteria` = id → criterion text, verbatim. Option keys are the category ids themselves (no
 *    remapping): Zen accepts numeric ("513530"), dotted and dashed keys, i.e. all of
 *    CATEGORY_ID_PATTERN. JSON serialises integer-like keys in ascending numeric order, so Jev
 *    sees the options in `Object.keys(prompt.criteria)` order; the GPT adapter lists them the same way.
 *  - The question id `category` is never shown to the model (TypeSafe docs); option names are.
 *  - Nothing else is added: Jev's typed output needs no output-format instruction.
 *
 * ── Mapping ─────────────────────────────────────────────────────────────────────────────────────
 *  answers.category.choice → `matchCategoryId` (exact; out of set / missing → status 'invalid');
 *  probabilities → filtered to task ids, clamp01; confidence = probabilities[choice] (the signal
 *  compared with GPT); nativeConfidence = answers.category.confidence ('jev_confidence', a spread
 *  statistic, not a probability). Response bodies are untrusted: every field is checked.
 *
 * ── Retries / timeout ───────────────────────────────────────────────────────────────────────────
 * Shared policy from common.ts (same as GPT): up to `cfg.maxRetries` retries on
 * `isRetryableStatus` and network failures, `retryDelayMs` between attempts, a per-attempt timeout
 * of `cfg.timeoutMs` (covers headers and body) that is never retried, and the caller's signal
 * aborting everything (including the backoff wait). Every attempt goes through `instrumentFetch`;
 * `providerLatencyMs` covers the whole call.
 *
 * Observed Zen behaviour (2026-10): validation errors come back as 400 `{ detail }`, a bad key as
 * 401 `{ error: { type: 'AuthError', message } }`, an unsupported model as 401 `ModelError` or
 * 400 `{ error: { message } }`; at most 255 options per Choice (400 "Too many choices").
 */
import type { ClassificationTask, ClassifyAnswer, ClassifyResult, ConceptInput, EngineModels, TokenUsage } from '../../src/shared/contracts.ts'
import { buildCanonicalPrompt, matchCategoryId, type CanonicalPrompt, type CanonicalState } from '../../src/shared/task.ts'
import { OPENCODE_LABEL, type JevConfig } from '../env.ts'
import { cachedListing, isJevModel, jevFallbackModels, jevModelOption, jevPriceFor, orderModelIds, parseModelIds } from '../models.ts'
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
  type AttemptLog,
  type ClassifyOptions,
  type EngineAdapter,
  type FetchLike,
} from './common.ts'

// ─────────────────────────────────── Request ───────────────────────────────────

export const JEV_SYSTEMONE_PATH = '/v1/systemone'
export const JEV_MODELS_PATH = '/v1/models'
/** Question id (not seen by the model); the answer comes back under the same key. */
export const JEV_QUESTION_ID = 'category'
/** API limit: options per Choice question (more → 400 "Too many choices"). */
export const JEV_MAX_CHOICES = 255

export interface JevChoiceQuestion {
  type: 'choice'
  instructions: { question: string; context: string }
  criteria: Record<string, string>
}

export interface JevRequest {
  model: string
  state: CanonicalState
  questions: { [JEV_QUESTION_ID]: JevChoiceQuestion }
}

/** The /v1/systemone body: canonical prompt only, native Choice packaging. */
export function buildJevRequest(prompt: CanonicalPrompt, model: string): JevRequest {
  return {
    model,
    state: prompt.state,
    questions: {
      [JEV_QUESTION_ID]: {
        type: 'choice',
        instructions: { question: prompt.question, context: prompt.context },
        criteria: prompt.criteria,
      },
    },
  }
}

// ─────────────────────────────────── Mapping ───────────────────────────────────

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Own property only: ids such as "constructor" must not read Object.prototype. */
function own(record: JsonRecord, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

export interface MappedJev {
  status: 'ok' | 'invalid'
  answer: ClassifyAnswer
  errorMessage?: string
}

function invalid(errorMessage: string): MappedJev {
  return { status: 'invalid', answer: { ...NULL_ANSWER }, errorMessage }
}

/** Maps a /v1/systemone body to a ClassifyAnswer. Defensive: the body is untrusted JSON. */
export function mapJevResponse(body: unknown, categoryIds: readonly string[]): MappedJev {
  const answers = isRecord(body) ? own(body, 'answers') : undefined
  if (!isRecord(answers)) return invalid('Jev no devolvió respuestas (falta `answers`).')
  const raw = own(answers, JEV_QUESTION_ID)
  if (!isRecord(raw)) return invalid(`Jev no devolvió la respuesta \`${JEV_QUESTION_ID}\`.`)
  const type = own(raw, 'type')
  if (type !== undefined && type !== 'choice') return invalid(`Jev devolvió una respuesta de tipo ${preview(type)} en lugar de choice.`)
  const rawChoice = own(raw, 'choice')
  const categoryId = matchCategoryId(rawChoice, categoryIds)
  if (categoryId === null) {
    return invalid(
      rawChoice === undefined || rawChoice === null
        ? 'Jev no eligió ninguna categoría (falta `choice`).'
        : `Jev eligió una categoría fuera del conjunto: ${preview(rawChoice)}.`,
    )
  }

  const answer: ClassifyAnswer = { categoryId }
  const rawProbabilities = own(raw, 'probabilities')
  if (isRecord(rawProbabilities)) {
    const probabilities: Record<string, number> = {}
    for (const id of categoryIds) {
      const p = clamp01(own(rawProbabilities, id))
      if (p !== undefined) probabilities[id] = p
    }
    if (Object.keys(probabilities).length > 0) answer.probabilities = probabilities
    if (probabilities[categoryId] !== undefined) answer.confidence = probabilities[categoryId]
  }
  const native = clamp01(own(raw, 'confidence'))
  if (native !== undefined) {
    answer.nativeConfidence = native
    answer.nativeConfidenceKind = 'jev_confidence'
  }
  return { status: 'ok', answer }
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** `usage.input_tokens` / `usage.output_tokens`; undefined without a valid input count. */
export function jevUsage(body: unknown): TokenUsage | undefined {
  const usage = isRecord(body) ? own(body, 'usage') : undefined
  if (!isRecord(usage)) return undefined
  const inputTokens = tokenCount(own(usage, 'input_tokens'))
  if (inputTokens === undefined) return undefined
  return { inputTokens, outputTokens: tokenCount(own(usage, 'output_tokens')) ?? 0 }
}

// ─────────────────────────────────── Errors ───────────────────────────────────

const PREFIX = 'OpenCode Zen (Jev)'

/**
 * Readable text from an error body. Handles FastAPI `{ detail: [{ loc, msg }] }`
 * ("questions.category.criteria: field required"), `{ detail: "…" }`, `{ detail: { message } }`,
 * Zen's `{ error: { type, message } }` and plain text.
 */
export function describeDetail(body: unknown): string {
  if (typeof body === 'string') return body.trim()
  if (!isRecord(body)) return body === undefined || body === null ? '' : preview(body)
  const detail = own(body, 'detail') ?? own(body, 'error') ?? own(body, 'message')
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        if (!isRecord(d)) return String(d)
        const loc = Array.isArray(d.loc) ? d.loc.filter((part) => part !== 'body').join('.') : ''
        const msg = typeof d.msg === 'string' ? d.msg : JSON.stringify(d)
        return loc ? `${loc}: ${msg}` : msg
      })
      .join('; ')
  }
  if (isRecord(detail) && typeof detail.message === 'string') return detail.message
  return detail === undefined ? JSON.stringify(body) : JSON.stringify(detail)
}

function errorType(body: unknown): string | undefined {
  const error = isRecord(body) ? own(body, 'error') : undefined
  return isRecord(error) && typeof error.type === 'string' ? error.type : undefined
}

/** Spanish, UI-ready message for a failed HTTP response (not yet redacted). */
export function describeHttpError(status: number, body: unknown, attempts: number): string {
  const tries = attempts > 1 ? ` (tras ${attempts} intentos)` : ''
  const detail = describeDetail(body)
  const suffix = detail ? `: ${detail}` : ''
  if (status === 401) {
    if (errorType(body) === 'ModelError') return `${PREFIX} 401: modelo no disponible en OpenCode Zen${suffix}`
    return `${PREFIX} 401: API key inválida o ausente (revisa OPENCODE_API_KEY)${suffix}`
  }
  if (status === 400 || status === 422) return `${PREFIX} ${status}: solicitud rechazada${suffix}`
  if (status === 429) return `${PREFIX} 429: límite de solicitudes excedido${tries}${suffix}`
  if (status === 529) return `${PREFIX} 529: proveedor sobrecargado${tries}${suffix}`
  return `${PREFIX} ${status}${tries}${suffix}`
}

type FailureKind = 'http' | 'network' | 'timeout' | 'aborted'

/** Failure of one /v1/systemone call. `message` is already redacted. */
class JevCallError extends Error {
  readonly kind: FailureKind
  readonly status: number | null
  readonly body: unknown
  readonly requestId: string | null
  constructor(kind: FailureKind, message: string, status: number | null = null, body: unknown = undefined, requestId: string | null = null) {
    super(message)
    this.name = 'JevCallError'
    this.kind = kind
    this.status = status
    this.body = body
    this.requestId = requestId
  }
}

const ABORTED_MESSAGE = `${PREFIX}: solicitud cancelada (el cliente cerró la conexión o agotó su tiempo).`

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text.slice(0, 500)
  }
}

function requestIdOf(response: Response): string | null {
  return response.headers.get('x-opencode-log-id') ?? response.headers.get('x-request-id') ?? response.headers.get('request-id')
}

// ─────────────────────────────────── Adapter ───────────────────────────────────

export interface JevAdapterDeps {
  /** Injected in tests; defaults to the global fetch. */
  fetch?: FetchLike
}

interface CallOutcome {
  data: unknown
  requestId: string | null
  upstreamModel: string | null
}

export function createJevAdapter(cfg: JevConfig, deps: JevAdapterDeps = {}): EngineAdapter {
  const fetchImpl = deps.fetch ?? defaultFetch
  const clean = (text: string) => redactSecrets(text, [cfg.apiKey])
  const endpoint = `${cfg.baseURL}${JEV_SYSTEMONE_PATH}`

  /** One /v1/systemone call under the shared retry policy. Throws JevCallError. */
  async function callSystemOne(body: string, signal: AbortSignal | undefined, attempts: AttemptLog[]): Promise<CallOutcome> {
    const instrumented = instrumentFetch(fetchImpl, attempts)
    for (let retry = 0; ; retry++) {
      if (signal?.aborted) throw new JevCallError('aborted', ABORTED_MESSAGE)
      const timeout = new AbortController()
      const timer = setTimeout(
        () => timeout.abort(new DOMException(`Timeout after ${cfg.timeoutMs} ms`, 'TimeoutError')),
        cfg.timeoutMs,
      )
      const attemptSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
      let response: Response | null = null
      let data: unknown
      let failed = false
      let failure: unknown
      try {
        response = await instrumented(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body,
          signal: attemptSignal,
        })
        data = await readBody(response) // still under this attempt's timeout
      } catch (error) {
        failed = true
        failure = error
      } finally {
        clearTimeout(timer)
      }

      if (failed || response === null) {
        if (signal?.aborted) throw new JevCallError('aborted', ABORTED_MESSAGE)
        if (timeout.signal.aborted) {
          const last = attempts.at(-1)
          if (last && last.status === null) last.error = `timeout (${cfg.timeoutMs} ms)`
          throw new JevCallError('timeout', `${PREFIX}: tiempo agotado (${cfg.timeoutMs} ms)`)
        }
        if (retry < cfg.maxRetries) {
          await waitOrAbort(retryDelayMs(null, retry + 1), signal)
          continue
        }
        const tries = attempts.length > 1 ? ` (tras ${attempts.length} intentos)` : ''
        const cause = failure instanceof Error && failure.cause instanceof Error ? failure.cause : failure
        throw new JevCallError('network', clean(`${PREFIX}: error de red${tries}: ${errorMessageOf(cause)}`))
      }

      const res = response
      const requestId = requestIdOf(res)
      if (res.ok) return { data, requestId, upstreamModel: res.headers.get('x-opencode-upstream-model-id') }
      if (isRetryableStatus(res.status) && retry < cfg.maxRetries) {
        await waitOrAbort(retryDelayMs(res, retry + 1), signal)
        continue
      }
      throw new JevCallError('http', clean(describeHttpError(res.status, data, attempts.length)), res.status, data, requestId)
    }
  }

  async function waitOrAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
    try {
      await sleep(ms, signal)
    } catch {
      throw new JevCallError('aborted', ABORTED_MESSAGE)
    }
  }

  async function classify(task: ClassificationTask, item: ConceptInput, options: ClassifyOptions = {}): Promise<ClassifyResult> {
    const model = options.model?.trim() || cfg.model
    if (!cfg.apiKey) return missingKeyResult('jev', model, 'OPENCODE_API_KEY')

    let prompt: CanonicalPrompt
    let request: JevRequest
    try {
      prompt = buildCanonicalPrompt(task, item)
      request = buildJevRequest(prompt, model)
    } catch (error) {
      return errorResult('jev', model, clean(`${PREFIX}: tarea inválida: ${errorMessageOf(error)}`))
    }
    if (prompt.categoryIds.length > JEV_MAX_CHOICES) {
      return errorResult(
        'jev',
        model,
        `${PREFIX}: la tarea tiene ${prompt.categoryIds.length} categorías y Jev admite máximo ${JEV_MAX_CHOICES} opciones por pregunta.`,
      )
    }

    const body = JSON.stringify(request)
    const price = jevPriceFor(model, cfg)
    const rawRequest = {
      ...toJsonValue<JevRequest>(request),
      options: {
        endpoint: publicEndpoint(endpoint),
        timeoutMs: cfg.timeoutMs,
        maxRetries: cfg.maxRetries,
        retryHttpStatuses: [...RETRY_HTTP_STATUSES],
      },
    }
    const attempts: AttemptLog[] = []
    const started = performance.now()

    let outcome: CallOutcome
    try {
      outcome = await callSystemOne(body, options.signal, attempts)
    } catch (error) {
      const providerLatencyMs = roundMs(performance.now() - started)
      const failure =
        error instanceof JevCallError ? error : new JevCallError('network', clean(`${PREFIX}: error inesperado: ${errorMessageOf(error)}`))
      const extra: Partial<ClassifyResult> = {
        providerLatencyMs,
        attempts,
        raw: {
          request: rawRequest,
          response:
            failure.status !== null
              ? { status: failure.status, body: clean(JSON.stringify(failure.body) ?? ''), requestId: failure.requestId }
              : { error: failure.kind },
        },
      }
      if (failure.kind === 'timeout') return timeoutResult('jev', model, cfg.timeoutMs, extra)
      return errorResult('jev', model, failure.message, extra)
    }
    const providerLatencyMs = roundMs(performance.now() - started)

    const { data, requestId, upstreamModel } = outcome
    const mapped = mapJevResponse(data, prompt.categoryIds)
    const usage = jevUsage(data)
    const responseModel = isRecord(data) && typeof data.model === 'string' && data.model.trim() ? data.model.trim().slice(0, 100) : undefined
    const result: ClassifyResult = {
      engine: 'jev',
      mode: 'live',
      model: responseModel ?? model,
      status: mapped.status,
      answer: mapped.answer,
      providerLatencyMs,
      attempts,
      raw: {
        request: rawRequest,
        response: {
          model: responseModel ?? null,
          upstreamModel,
          answers: isRecord(data) ? (own(data, 'answers') ?? null) : null,
          usage: isRecord(data) ? (own(data, 'usage') ?? null) : null,
          requestId,
          pricing: { ...price.prices, source: price.source },
          ...(isRecord(data) ? {} : { body: clean(typeof data === 'string' ? data : (JSON.stringify(data) ?? '')) }),
        },
      },
    }
    if (mapped.errorMessage) result.errorMessage = mapped.errorMessage
    if (usage) {
      result.usage = usage
      result.costUsd = costUsd(usage, price.prices)
    }
    return result
  }

  // Zen lists every model (`{ data: [{ id }] }`): keep the jev* ones.
  const listing = cachedListing(async (): Promise<EngineModels> => {
    if (!cfg.apiKey) return jevFallbackModels(cfg)
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new DOMException('Timeout', 'TimeoutError')), cfg.timeoutMs)
    try {
      const response = await fetchImpl(`${cfg.baseURL}${JEV_MODELS_PATH}`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: 'application/json' },
        signal: timeout.signal,
      })
      if (!response.ok) return jevFallbackModels(cfg, `${PREFIX}: GET ${JEV_MODELS_PATH} respondió HTTP ${response.status}.`)
      const ids = parseModelIds(await readBody(response)).filter(isJevModel)
      if (ids.length === 0) return jevFallbackModels(cfg, `${PREFIX}: el listado de modelos no incluye modelos Jev.`)
      return {
        default: cfg.model,
        provider: OPENCODE_LABEL,
        models: orderModelIds(ids, cfg.model).map((id) => jevModelOption(id, cfg)),
        source: 'provider',
      }
    } catch (error) {
      const reason = timeout.signal.aborted ? `tiempo agotado (${cfg.timeoutMs} ms)` : errorMessageOf(error)
      return jevFallbackModels(cfg, clean(`${PREFIX}: no se pudo listar modelos: ${reason}`))
    } finally {
      clearTimeout(timer)
    }
  })

  return {
    engine: 'jev',
    live: Boolean(cfg.apiKey),
    model: cfg.model,
    provider: OPENCODE_LABEL,
    async classify(task, item, options) {
      try {
        return await classify(task, item, options)
      } catch (error) {
        // Last-resort guard: classify never throws.
        return errorResult('jev', options?.model?.trim() || cfg.model, clean(`${PREFIX}: error inesperado: ${errorMessageOf(error)}`))
      }
    },
    listModels: (force = false) => listing(force),
  }
}
