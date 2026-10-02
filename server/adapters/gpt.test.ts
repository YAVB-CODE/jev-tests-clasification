import { describe, expect, it } from 'vitest'
import type { AttemptLog, ClassificationTask, ConceptInput } from '../../src/shared/contracts.ts'
import { CANONICAL_CONTEXT, buildCanonicalPrompt } from '../../src/shared/task.ts'
import { loadConfig, type GptConfig } from '../env.ts'
import type { FetchLike } from './common.ts'
import {
  CLASSIC_MAX_COMPLETION_TOKENS,
  GPT_OUTPUT_INSTRUCTION,
  GPT_SCHEMA_NAME,
  REASONING_MAX_COMPLETION_TOKENS,
  buildGptRequest,
  buildGptSchema,
  buildGptSystemPrompt,
  categoryLogprob,
  createGptAdapter,
  gptModelProfile,
  parseGptContent,
  type LogprobToken,
} from './gpt.ts'

// ─────────────────────────────── Fake OpenAI (no network) ───────────────────────────────

interface RecordedCall {
  url: string
  method: string
  headers: Headers
  body: unknown
}

type Step = Response | Error | ((call: RecordedCall, init?: RequestInit) => Response | Promise<Response>)

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

/** Rejects like a real fetch when the request's signal aborts; otherwise never settles. */
function hangUntilAborted(_call: RecordedCall, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal
    const fail = () => reject(signal?.reason ?? new DOMException('This operation was aborted', 'AbortError'))
    if (signal?.aborted) return fail()
    signal?.addEventListener('abort', fail, { once: true })
  })
}

/** Plays `steps` in order (the last one repeats). Errors are thrown as network failures. */
function scriptedFetch(steps: Step[]): FetchLike & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let body: unknown = init?.body
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body)
      } catch {
        // keep the raw text
      }
    }
    const call: RecordedCall = { url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body }
    calls.push(call)
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]
    if (step instanceof Error) throw step
    if (typeof step === 'function') return step(call, init)
    return step.clone()
  }
  return Object.assign(fn, { calls })
}

const encoder = new TextEncoder()

/** OpenAI-shaped logprobs content: one entry per [token, logprob]. */
function tokens(pieces: Array<[string, number]>): LogprobToken[] & Array<{ top_logprobs: [] }> {
  return pieces.map(([token, logprob]) => ({ token, logprob, bytes: [...encoder.encode(token)], top_logprobs: [] }))
}

/** Splits `text` into single-character tokens with logprob 0 except the overrides. */
function charTokens(text: string, overrides: Record<number, number> = {}) {
  return tokens([...text].map((ch, i) => [ch, overrides[i] ?? 0] as [string, number]))
}

interface CompletionExtra {
  refusal?: string | null
  finish_reason?: string
  logprobs?: unknown[] | null
  model?: string
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null
}

function completion(content: string | null, extra: CompletionExtra = {}) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: extra.model ?? 'gpt-4.1-mini-2025-04-14',
    system_fingerprint: 'fp_test',
    choices: [
      {
        index: 0,
        finish_reason: extra.finish_reason ?? 'stop',
        logprobs: extra.logprobs === undefined || extra.logprobs === null ? null : { content: extra.logprobs, refusal: null },
        message: { role: 'assistant', content, refusal: extra.refusal ?? null },
      },
    ],
    usage: extra.usage === undefined ? { prompt_tokens: 812, completion_tokens: 15, total_tokens: 827 } : extra.usage,
  }
}

// ─────────────────────────────── Fixtures ───────────────────────────────

const KEY = 'sk-test-SECRET-1234567890abcdef'

function cfg(overrides: Partial<GptConfig> = {}): GptConfig {
  return { ...loadConfig({}).gpt, apiKey: KEY, ...overrides }
}

/** Integer-like ids in non-ascending order: `Object.keys(criteria)` reorders them (1635 < 513525 < 513530). */
const task: ClassificationTask = {
  instructions: 'Clasifica la línea de factura en una subcuenta del PUC.',
  question: '¿En qué subcuenta del PUC se registra esta línea?',
  categories: [
    { id: '513530', name: 'Energía eléctrica', group: '5135 Servicios', description: 'Servicio de energía.' },
    { id: '1635', name: 'Licencias', description: 'Licencias perpetuas de software.' },
    { id: '513525', name: 'Acueducto y alcantarillado', group: '5135 Servicios', description: '' },
    { id: 'otros-gastos', name: 'Otros', description: 'Lo que no encaja en otra categoría.' },
  ],
}
const CRITERIA_ORDER = ['1635', '513525', '513530', 'otros-gastos']

/** A labeled concept smuggled in as a ConceptInput: the label must never reach OpenAI. */
const item = {
  id: 'item-secret-id-42',
  concept: 'Servicio de energía periodo marzo',
  supplier: 'Enel Colombia',
  amount: 350_000,
  currency: 'COP',
  expected: '513530',
  difficulty: 'easy',
  rationale: 'RATIONALE-NO-DEBE-SALIR',
} as ConceptInput

const prompt = buildCanonicalPrompt(task, item)

const VALID = '{"category":"513530","confidence":0.92}'
/** How gpt-4.1 typically tokenises VALID. */
const VALID_TOKENS = tokens([
  ['{"', 0],
  ['category', 0],
  ['":"', 0],
  ['513', -0.1],
  ['530', -0.2],
  ['","', -0.01],
  ['confidence', 0],
  ['":', 0],
  ['0', 0],
  ['.', 0],
  ['92', -0.5],
  ['}', 0],
])

// ─────────────────────────────── Prompt & request ───────────────────────────────

describe('buildGptRequest', () => {
  it('sends question, context and options (in Jev order) as system, and the canonical state as user', () => {
    const params = buildGptRequest(prompt, cfg())
    const [system, user] = params.messages
    expect(system.role).toBe('system')
    const text = system.content as string
    expect(text).toBe(buildGptSystemPrompt(prompt))
    expect(text.startsWith(`${prompt.question}\n${CANONICAL_CONTEXT}\n`)).toBe(true)
    expect(text.endsWith(GPT_OUTPUT_INSTRUCTION)).toBe(true)

    const optionLines = text.split('\n').filter((line) => line.startsWith('- "'))
    expect(optionLines).toEqual(CRITERIA_ORDER.map((id) => `- "${id}": ${prompt.criteria[id]}`))
    expect(CRITERIA_ORDER).toEqual(Object.keys(prompt.criteria))
    expect(CRITERIA_ORDER).not.toEqual(prompt.categoryIds) // the reorder is real
    expect(optionLines[2]).toBe('- "513530": Energía eléctrica (grupo: 5135 Servicios): Servicio de energía.')
    expect(optionLines[1]).toBe('- "513525": Acueducto y alcantarillado (grupo: 5135 Servicios)')

    // The task instructions travel once, inside the state (same as Jev), never duplicated in the system text.
    expect(text).not.toContain(task.instructions)
    expect(user).toEqual({ role: 'user', content: JSON.stringify(prompt.state) })
    expect(JSON.parse(user.content as string)).toEqual({
      task: task.instructions,
      invoice_line: { concept: item.concept, supplier: 'Enel Colombia', amount: 350_000, currency: 'COP' },
    })
  })

  it('never leaks the label, the item id or the rationale', () => {
    const wire = JSON.stringify(buildGptRequest(prompt, cfg()))
    expect(wire).not.toContain('expected')
    expect(wire).not.toContain('item-secret-id-42')
    expect(wire).not.toContain('RATIONALE-NO-DEBE-SALIR')
    expect(wire).not.toContain('difficulty')
  })

  it('uses a strict schema: category (enum, in Jev order) first, then confidence', () => {
    const params = buildGptRequest(prompt, cfg())
    const schema = buildGptSchema(prompt)
    expect(params.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: GPT_SCHEMA_NAME, strict: true, schema },
    })
    expect(schema).toEqual({
      type: 'object',
      properties: { category: { type: 'string', enum: CRITERIA_ORDER }, confidence: { type: 'number' } },
      required: ['category', 'confidence'],
      additionalProperties: false,
    })
    expect(Object.keys(schema.properties)).toEqual(['category', 'confidence'])
    expect([...schema.properties.category.enum].sort()).toEqual([...prompt.categoryIds].sort())
  })

  it('classic models: temperature 0 and logprobs, no reasoning_effort', () => {
    const params = buildGptRequest(prompt, cfg({ model: 'gpt-4.1-mini', reasoningEffort: 'low' }))
    expect(params.temperature).toBe(0)
    expect(params.logprobs).toBe(true)
    expect(params.max_completion_tokens).toBe(CLASSIC_MAX_COMPLETION_TOKENS)
    expect(params).not.toHaveProperty('reasoning_effort')
    expect(params.messages[0].role).toBe('system')
  })

  it('reasoning models: no temperature nor logprobs, developer role, reasoning_effort and a larger budget', () => {
    for (const model of ['gpt-5', 'gpt-5-mini', 'gpt-5.5', 'o3', 'o4-mini', 'o1']) {
      const params = buildGptRequest(prompt, cfg({ model, reasoningEffort: 'minimal' }))
      expect(params, model).not.toHaveProperty('temperature')
      expect(params, model).not.toHaveProperty('logprobs')
      expect(params.max_completion_tokens).toBe(REASONING_MAX_COMPLETION_TOKENS)
      expect(params.reasoning_effort).toBe('minimal')
      expect(params.messages[0].role).toBe('developer')
    }
    const custom = buildGptRequest(prompt, cfg({ model: 'o4-mini', maxCompletionTokens: 1500 }))
    expect(custom.max_completion_tokens).toBe(1500)
    expect(custom).not.toHaveProperty('reasoning_effort')
  })

  it('classifies model families', () => {
    expect(gptModelProfile('gpt-4o-mini')).toMatchObject({ reasoning: false, omitTemperature: false, logprobs: true })
    expect(gptModelProfile('gpt-5-chat-latest')).toMatchObject({ reasoning: false, omitTemperature: true, logprobs: true })
    expect(gptModelProfile('o3-mini')).toMatchObject({ reasoning: true, omitTemperature: true, logprobs: false })
  })
})

// ─────────────────────────────── Parsing ───────────────────────────────

describe('parseGptContent', () => {
  const ids = prompt.categoryIds

  it('parses a valid answer', () => {
    const r = parseGptContent(VALID, ids, null, 'stop')
    expect(r).toMatchObject({ status: 'ok', answer: { categoryId: '513530', confidence: 0.92 } })
    expect(r.errorMessage).toBeUndefined()
  })

  it('rejects categories outside the set without normalising them', () => {
    for (const bad of ['999999', 'OTROS-GASTOS', ' 513530', 513530]) {
      const r = parseGptContent(JSON.stringify({ category: bad, confidence: 1 }), ids)
      expect(r.status, String(bad)).toBe('invalid')
      expect(r.answer).toEqual({ categoryId: null })
      expect(r.errorMessage).toMatch(/fuera del conjunto/)
    }
  })

  it('flags malformed and non-object JSON', () => {
    expect(parseGptContent('{"category":"513530",', ids)).toMatchObject({ status: 'invalid', errorMessage: expect.stringMatching(/^JSON malformado/) })
    expect(parseGptContent('["513530"]', ids).errorMessage).toMatch(/no es un objeto JSON/)
  })

  it('flags refusals, truncation (finish_reason=length) and empty output', () => {
    const refused = parseGptContent(null, ids, "I'm sorry, I can't help with that.")
    expect(refused.status).toBe('invalid')
    expect(refused.errorMessage).toMatch(/se negó a responder/)
    expect(parseGptContent('{"category":"5135', ids, null, 'length').errorMessage).toMatch(/truncada.*length/)
    expect(parseGptContent(VALID, ids, null, 'length').status).toBe('invalid')
    expect(parseGptContent('', ids, null, 'stop').errorMessage).toMatch(/vacía/)
    expect(parseGptContent(null, ids, null, 'content_filter').errorMessage).toMatch(/filtro de contenido/)
  })

  it('clamps the confidence to [0, 1] and drops non-numeric ones', () => {
    expect(parseGptContent('{"category":"1635","confidence":1.7}', ids).answer.confidence).toBe(1)
    expect(parseGptContent('{"category":"1635","confidence":-0.2}', ids).answer.confidence).toBe(0)
    const s = parseGptContent('{"category":"1635","confidence":"alta"}', ids)
    expect(s.status).toBe('ok')
    expect(s.answer).toEqual({ categoryId: '1635' })
  })

  it('tolerates a markdown code fence', () => {
    expect(parseGptContent('```json\n' + VALID + '\n```', ids).status).toBe('ok')
  })
})

// ─────────────────────────────── Logprob confidence ───────────────────────────────

describe('categoryLogprob', () => {
  it('sums the logprobs of the value tokens and its closing quote', () => {
    const r = categoryLogprob(VALID_TOKENS, '513530')
    expect(r?.value).toBe('513530')
    expect(r?.tokens.map((t) => t.token)).toEqual(['513', '530', '","'])
    expect(r?.logprob).toBeCloseTo(-0.31, 12)
    expect(r?.confidence).toBeCloseTo(Math.exp(-0.31), 12)
  })

  it('handles tokens that straddle the quotes and the key', () => {
    const r = categoryLogprob(
      tokens([
        ['{"category', -0.3],
        ['":"5', -0.2],
        ['135', -0.1],
        ['30"', -0.05],
        [',"confidence":0.9}', -0.4],
      ]),
    )
    expect(r?.value).toBe('513530')
    expect(r?.tokens.map((t) => t.token)).toEqual(['":"5', '135', '30"'])
    expect(r?.confidence).toBeCloseTo(Math.exp(-0.35), 12)
  })

  it('works one character at a time (only value chars and the closing quote count)', () => {
    const text = '{"category":"1635","confidence":0.5}'
    const start = text.indexOf('1635')
    const r = categoryLogprob(charTokens(text, { [start]: -0.5, [start + 3]: -0.25, [start + 4]: -0.125, [start - 1]: -9 }), '1635')
    expect(r?.tokens.map((t) => t.token).join('')).toBe('1635"')
    expect(r?.logprob).toBeCloseTo(-0.875, 12)
  })

  it('finds the top-level key even after other fields, escaped quotes and whitespace', () => {
    const text = '{\n  "note": "dijo \\"category\\":\\"999\\"",\n  "confidence": 0.5,\n  "nested": {"category": "x"},\n  "category" : "otros-gastos"\n}'
    const r = categoryLogprob(charTokens(text, { [text.lastIndexOf('otros')]: -1 }), 'otros-gastos')
    expect(r?.value).toBe('otros-gastos')
    expect(r?.logprob).toBeCloseTo(-1, 12)
  })

  it('uses the token bytes when a multi-byte character is split across tokens', () => {
    // "é" = C3 A9, emitted as two byte-tokens whose `token` text is a replacement character.
    const content: LogprobToken[] = [
      { token: '{"nota":"', logprob: 0, bytes: [...encoder.encode('{"nota":"')] },
      { token: '�', logprob: 0, bytes: [0xc3] },
      { token: '�', logprob: 0, bytes: [0xa9] },
      { token: '","category":"', logprob: 0, bytes: [...encoder.encode('","category":"')] },
      { token: '1635', logprob: -0.7, bytes: [...encoder.encode('1635')] },
      { token: '"}', logprob: -0.1, bytes: [...encoder.encode('"}')] },
    ]
    const r = categoryLogprob(content, '1635')
    expect(r?.tokens.map((t) => t.token)).toEqual(['1635', '"}'])
    expect(r?.logprob).toBeCloseTo(-0.8, 12)
    // Without bytes the token text is used (here: still correct for ASCII-only output).
    expect(categoryLogprob(VALID_TOKENS.map(({ token, logprob }) => ({ token, logprob })), '513530')?.logprob).toBeCloseTo(-0.31, 12)
  })

  it('returns undefined without logprobs, without the key, on a mismatch or on truncated output', () => {
    expect(categoryLogprob(undefined)).toBeUndefined()
    expect(categoryLogprob(null)).toBeUndefined()
    expect(categoryLogprob([])).toBeUndefined()
    expect(categoryLogprob(charTokens('{"confidence":0.5}'))).toBeUndefined()
    expect(categoryLogprob(VALID_TOKENS, '1635')).toBeUndefined()
    expect(categoryLogprob(charTokens('{"category":"5135'))).toBeUndefined()
    expect(categoryLogprob(charTokens('not json'))).toBeUndefined()
    expect(categoryLogprob(tokens([['{"category":"1635"}', Number.NaN]]))).toBeUndefined()
  })
})

// ─────────────────────────────── Adapter ───────────────────────────────

describe('createGptAdapter.classify', () => {
  it('returns missingKeyResult without calling OpenAI when the key is missing', async () => {
    const fetch = scriptedFetch([jsonResponse(completion(VALID))])
    const adapter = createGptAdapter(cfg({ apiKey: undefined }), { fetch })
    expect(adapter.live).toBe(false)
    const r = await adapter.classify(task, item)
    expect(r).toMatchObject({ engine: 'gpt', mode: 'live', status: 'error', answer: { categoryId: null } })
    expect(r.errorMessage).toContain('OPENAI_API_KEY')
    expect(fetch.calls).toHaveLength(0)
  })

  it('maps a successful completion: answer, native confidence, usage, cost, attempts and raw payloads', async () => {
    const fetch = scriptedFetch([jsonResponse(completion(VALID, { logprobs: VALID_TOKENS }), 200, { 'x-request-id': 'req_123' })])
    const adapter = createGptAdapter(cfg(), { fetch })
    expect(adapter).toMatchObject({ engine: 'gpt', live: true, model: 'gpt-4.1-mini', provider: 'OpenAI' })
    const r = await adapter.classify(task, item)

    expect(r.status).toBe('ok')
    expect(r.mode).toBe('live')
    expect(r.model).toBe('gpt-4.1-mini-2025-04-14')
    expect(r.answer).toEqual({
      categoryId: '513530',
      confidence: 0.92,
      nativeConfidence: expect.closeTo(Math.exp(-0.31), 12),
      nativeConfidenceKind: 'logprob',
    })
    expect(r.answer).not.toHaveProperty('probabilities')
    expect(r.usage).toEqual({ inputTokens: 812, outputTokens: 15 })
    expect(r.costUsd).toBeCloseTo((812 * 0.4 + 15 * 1.6) / 1e6, 12)
    expect(r.providerLatencyMs).toBeGreaterThanOrEqual(0)
    expect(r.attempts).toEqual([expect.objectContaining({ attempt: 1, status: 200 })])
    expect(r.errorMessage).toBeUndefined()

    // What went over the wire
    expect(fetch.calls).toHaveLength(1)
    const call = fetch.calls[0]
    expect(call.url).toMatch(/\/chat\/completions$/)
    expect(call.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    const sent = call.body as Record<string, unknown>
    expect(sent).toMatchObject({ model: 'gpt-4.1-mini', temperature: 0, logprobs: true })
    expect(sent.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } })
    expect(JSON.stringify(sent)).not.toContain('RATIONALE-NO-DEBE-SALIR')

    // raw: request + response, never the key
    const raw = r.raw as { request: Record<string, unknown>; response: Record<string, unknown> }
    expect(raw.request.messages).toEqual(sent.messages)
    expect(raw.request.options).toEqual({
      endpoint: 'https://api.openai.com/v1/chat/completions',
      timeoutMs: 30_000,
      maxRetries: 1,
      retryHttpStatuses: [408, 429, 500, 502, 503, 504, 529],
    })
    const { options: _options, ...body } = raw.request
    expect(body).toEqual(sent) // exact body on the wire
    expect(raw.response).toMatchObject({
      content: VALID,
      finish_reason: 'stop',
      requestId: 'req_123',
      model: 'gpt-4.1-mini-2025-04-14',
      usage: { prompt_tokens: 812, completion_tokens: 15 },
      logprobs: { tokenCount: VALID_TOKENS.length, category: { value: '513530', logprob: expect.closeTo(-0.31, 12) } },
      pricing: { inputPerMTok: 0.4, outputPerMTok: 1.6, source: 'table' },
    })
    expect(JSON.stringify(r)).not.toContain(KEY)
  })

  it('omits the native confidence when there are no logprobs', async () => {
    const fetch = scriptedFetch([jsonResponse(completion(VALID))])
    const r = await createGptAdapter(cfg(), { fetch }).classify(task, item)
    expect(r.status).toBe('ok')
    expect(r.answer).toEqual({ categoryId: '513530', confidence: 0.92 })
    expect((r.raw as { response: { logprobs: unknown } }).response.logprobs).toBeNull()
  })

  it('reasoning model picked in the UI: no temperature/logprobs on the wire and no native confidence', async () => {
    const fetch = scriptedFetch([jsonResponse(completion(VALID, { model: 'o4-mini-2025-04-16', logprobs: VALID_TOKENS }))])
    const r = await createGptAdapter(cfg({ reasoningEffort: 'low' }), { fetch }).classify(task, item, { model: 'o4-mini' })
    const sent = fetch.calls[0].body as Record<string, unknown>
    expect(sent).toMatchObject({ model: 'o4-mini', reasoning_effort: 'low', max_completion_tokens: REASONING_MAX_COMPLETION_TOKENS })
    expect(sent).not.toHaveProperty('temperature')
    expect(sent).not.toHaveProperty('logprobs')
    expect((sent.messages as Array<{ role: string }>)[0].role).toBe('developer')
    expect(r.status).toBe('ok')
    expect(r.model).toBe('o4-mini-2025-04-16')
    expect(r.answer).toEqual({ categoryId: '513530', confidence: 0.92 })
    expect(r.costUsd).toBeCloseTo((812 * 1.1 + 15 * 4.4) / 1e6, 12)
  })

  it('cost: env prices for OPENAI_MODEL, none for a model without a known price', async () => {
    const fetch = scriptedFetch([jsonResponse(completion(VALID))])
    const env = { OPENAI_API_KEY: KEY, OPENAI_MODEL: 'gpt-4.1-mini', OPENAI_PRICE_INPUT_PER_MTOK: '1', OPENAI_PRICE_OUTPUT_PER_MTOK: '10' }
    const adapter = createGptAdapter(loadConfig(env).gpt, { fetch })
    const priced = await adapter.classify(task, item)
    expect(priced.costUsd).toBeCloseTo((812 * 1 + 15 * 10) / 1e6, 12)

    const unknown = await adapter.classify(task, item, { model: 'gpt-4.5-preview' })
    expect(unknown.status).toBe('ok')
    expect(unknown.usage).toEqual({ inputTokens: 812, outputTokens: 15 })
    expect(unknown.costUsd).toBeUndefined()
    expect((unknown.raw as { response: { pricing: unknown } }).response.pricing).toBeNull()
  })

  it('maps a refusal and an out-of-set answer to invalid, keeping usage and cost', async () => {
    const refusal = scriptedFetch([jsonResponse(completion(null, { refusal: 'No puedo ayudar con eso.' }))])
    const r = await createGptAdapter(cfg(), { fetch: refusal }).classify(task, item)
    expect(r.status).toBe('invalid')
    expect(r.answer).toEqual({ categoryId: null })
    expect(r.errorMessage).toMatch(/se negó/)
    expect(r.usage).toBeDefined()
    expect(r.costUsd).toBeGreaterThan(0)

    const outOfSet = scriptedFetch([jsonResponse(completion('{"category":"519530","confidence":0.8}'))])
    const o = await createGptAdapter(cfg(), { fetch: outOfSet }).classify(task, item)
    expect(o.status).toBe('invalid')
    expect(o.errorMessage).toMatch(/fuera del conjunto.*519530/)

    const truncated = scriptedFetch([jsonResponse(completion('', { finish_reason: 'length' }))])
    const t = await createGptAdapter(cfg(), { fetch: truncated }).classify(task, item, { model: 'gpt-5-mini' })
    expect(t.status).toBe('invalid')
    expect(t.errorMessage).toMatch(/OPENAI_MAX_COMPLETION_TOKENS/)
  })

  it('retries a 429 under the shared policy and logs every attempt', async () => {
    const fetch = scriptedFetch([
      jsonResponse({ error: { message: 'Rate limit reached', type: 'requests' } }, 429, { 'retry-after-ms': '60' }),
      jsonResponse(completion(VALID)),
    ])
    const r = await createGptAdapter(cfg({ maxRetries: 1 }), { fetch }).classify(task, item)
    expect(r.status).toBe('ok')
    expect(fetch.calls).toHaveLength(2)
    expect(r.attempts?.map((a) => [a.attempt, a.status])).toEqual([
      [1, 429],
      [2, 200],
    ])
    expect(r.providerLatencyMs).toBeGreaterThanOrEqual(50) // includes the Retry-After wait
  })

  it('stops after cfg.maxRetries retries and reports the attempts', async () => {
    const fetch = scriptedFetch([jsonResponse({ error: { message: 'Bad gateway' } }, 502, { 'retry-after-ms': '0' })])
    const r = await createGptAdapter(cfg({ maxRetries: 2 }), { fetch }).classify(task, item)
    expect(r.status).toBe('error')
    expect(fetch.calls).toHaveLength(3)
    expect(r.errorMessage).toMatch(/^OpenAI 502: error del proveedor \(tras 3 intentos\): Bad gateway/)
    expect(r.raw).toMatchObject({ response: { status: 502, body: expect.stringContaining('Bad gateway') } })
    expect(r.attempts?.map((a) => a.status)).toEqual([502, 502, 502])

    const noRetry = scriptedFetch([jsonResponse({ error: { message: 'Rate limit' } }, 429, { 'retry-after-ms': '0' })])
    const n = await createGptAdapter(cfg({ maxRetries: 0 }), { fetch: noRetry }).classify(task, item)
    expect(n.status).toBe('error')
    expect(n.errorMessage).toMatch(/^OpenAI 429: límite de solicitudes excedido o cuota agotada: Rate limit/)
    expect(noRetry.calls).toHaveLength(1)
  })

  it('retries a network failure, but never a 400', async () => {
    const flaky = scriptedFetch([new TypeError('fetch failed'), jsonResponse(completion(VALID))])
    const r = await createGptAdapter(cfg({ maxRetries: 1 }), { fetch: flaky }).classify(task, item)
    expect(r.status).toBe('ok')
    expect(r.attempts?.map((a) => a.status)).toEqual([null, 200])

    const down = scriptedFetch([new TypeError('fetch failed')])
    const d = await createGptAdapter(cfg({ maxRetries: 0 }), { fetch: down }).classify(task, item)
    expect(d.status).toBe('error')
    expect(d.errorMessage).toMatch(/^OpenAI: error de red: fetch failed/)
    expect(d.raw).toMatchObject({ response: { error: 'network' } })

    const body = { error: { message: "Unsupported parameter: 'temperature' is not supported with this model.", type: 'invalid_request_error' } }
    const bad = scriptedFetch([jsonResponse(body, 400)])
    const b = await createGptAdapter(cfg({ maxRetries: 2 }), { fetch: bad }).classify(task, item)
    expect(b.status).toBe('error')
    expect(b.errorMessage).toMatch(/^OpenAI 400: solicitud rechazada: Unsupported parameter/)
    expect(bad.calls).toHaveLength(1)
  })

  it('maps 401 / 403 / 404 to Spanish errors without leaking the key and without retrying', async () => {
    const leak = { error: { message: `Incorrect API key provided: ${KEY}.`, type: 'invalid_request_error', code: 'invalid_api_key' } }
    const unauthorized = scriptedFetch([jsonResponse(leak, 401)])
    const r = await createGptAdapter(cfg({ maxRetries: 2 }), { fetch: unauthorized }).classify(task, item)
    expect(r.status).toBe('error')
    expect(r.errorMessage).toMatch(/^OpenAI 401: API key inválida/)
    expect(r.errorMessage).toContain('OPENAI_API_KEY')
    expect(unauthorized.calls).toHaveLength(1)
    expect(JSON.stringify(r)).not.toContain(KEY)

    const forbidden = scriptedFetch([jsonResponse({ error: { message: `Project does not have access, key ${KEY}` } }, 403)])
    const f = await createGptAdapter(cfg(), { fetch: forbidden }).classify(task, item)
    expect(f.errorMessage).toMatch(/^OpenAI 403: acceso denegado/)
    expect(JSON.stringify(f)).not.toContain(KEY)

    const missing = scriptedFetch([jsonResponse({ error: { message: 'The model `gpt-x` does not exist', code: 'model_not_found' } }, 404)])
    const m = await createGptAdapter(cfg(), { fetch: missing }).classify(task, item, { model: 'gpt-x' })
    expect(m.status).toBe('error')
    expect(m.model).toBe('gpt-x')
    expect(m.errorMessage).toMatch(/^OpenAI 404: el modelo «gpt-x» no existe/)
  })

  it('times out per attempt and never retries after a timeout', async () => {
    const fetch = scriptedFetch([hangUntilAborted])
    const r = await createGptAdapter(cfg({ timeoutMs: 50, maxRetries: 2 }), { fetch }).classify(task, item)
    expect(r.status).toBe('timeout')
    expect(r.answer).toEqual({ categoryId: null })
    expect(r.errorMessage).toMatch(/50 ms/)
    expect(fetch.calls).toHaveLength(1)
    expect(r.attempts).toEqual([expect.objectContaining({ attempt: 1, status: null, error: 'timeout (50 ms)' })])
    expect(r.raw).toMatchObject({ response: { error: 'timeout' } })
    expect(r.providerLatencyMs).toBeGreaterThanOrEqual(45)
  })

  it('times out when the body never finishes, too', async () => {
    const slowBody = () =>
      new Response(new ReadableStream({ start: (c) => c.enqueue(encoder.encode('{"id":')) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    const fetch = scriptedFetch([slowBody])
    const r = await createGptAdapter(cfg({ timeoutMs: 50, maxRetries: 1 }), { fetch }).classify(task, item)
    expect(r.status).toBe('timeout')
    expect(fetch.calls).toHaveLength(1)
  })

  it('the client signal aborts the call (in flight, during the backoff, or before it starts)', async () => {
    const hang = scriptedFetch([hangUntilAborted])
    const controller = new AbortController()
    const pending = createGptAdapter(cfg(), { fetch: hang }).classify(task, item, { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    const r = await pending
    expect(r.status).toBe('error')
    expect(r.errorMessage).toMatch(/solicitud cancelada por el cliente/)
    expect(hang.calls).toHaveLength(1)

    const limited = scriptedFetch([jsonResponse({ error: { message: 'Rate limit' } }, 429, { 'retry-after-ms': '1500' }), jsonResponse(completion(VALID))])
    const c2 = new AbortController()
    const waiting = createGptAdapter(cfg({ maxRetries: 1 }), { fetch: limited }).classify(task, item, { signal: c2.signal })
    setTimeout(() => c2.abort(), 30)
    const w = await waiting
    expect(w.errorMessage).toMatch(/solicitud cancelada por el cliente/)
    expect(limited.calls).toHaveLength(1)
    expect(w.providerLatencyMs).toBeLessThan(1000)

    const never = scriptedFetch([jsonResponse(completion(VALID))])
    const aborted = new AbortController()
    aborted.abort()
    const a = await createGptAdapter(cfg(), { fetch: never }).classify(task, item, { signal: aborted.signal })
    expect(a.errorMessage).toMatch(/solicitud cancelada por el cliente/)
    expect(never.calls).toHaveLength(0)
  })

  it('never throws, even on a malformed task that skipped validation', async () => {
    const fetch = scriptedFetch([jsonResponse(completion(VALID))])
    const broken = { question: 'x', categories: [] } as unknown as ClassificationTask
    const r = await createGptAdapter(cfg(), { fetch }).classify(broken, item, { model: ' gpt-4o ' })
    expect(r).toMatchObject({ engine: 'gpt', status: 'error', model: 'gpt-4o', answer: { categoryId: null } })
    expect(r.errorMessage).toMatch(/^OpenAI: error inesperado/)
    expect(fetch.calls).toHaveLength(0)
  })

  it('records attempts consistently with the AttemptLog contract', async () => {
    const fetch = scriptedFetch([jsonResponse({}, 503, { 'retry-after-ms': '0' }), jsonResponse(completion(VALID))])
    const r = await createGptAdapter(cfg({ maxRetries: 1 }), { fetch }).classify(task, item)
    const attempts = r.attempts as AttemptLog[]
    expect(attempts.every((a) => Number.isInteger(a.ms) && a.ms >= 0)).toBe(true)
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2])
  })
})

describe('createGptAdapter.listModels', () => {
  const listing = {
    object: 'list',
    data: [
      { id: 'gpt-4.1-mini', object: 'model' },
      { id: 'gpt-4o-2024-08-06', object: 'model' },
      { id: 'whisper-1', object: 'model' },
      { id: 'o4-mini', object: 'model' },
      { id: 'gpt-4o', object: 'model' },
      { id: 'text-embedding-3-small', object: 'model' },
    ],
  }

  it('lists chat models from the provider (default first, prices and reasoning flag) and caches them', async () => {
    const fetch = scriptedFetch([jsonResponse(listing)])
    const adapter = createGptAdapter(cfg(), { fetch })
    const list = await adapter.listModels()
    expect(list).toMatchObject({ default: 'gpt-4.1-mini', provider: 'OpenAI', source: 'provider' })
    expect(list.models.map((m) => m.id)).toEqual(['gpt-4.1-mini', 'gpt-4o', 'o4-mini'])
    expect(list.models[0]).toMatchObject({ inputPerMTok: 0.4, outputPerMTok: 1.6, priceSource: 'table' })
    expect(list.models[2]).toMatchObject({ reasoning: true })
    expect(fetch.calls[0].url).toMatch(/\/models$/)
    await adapter.listModels()
    expect(fetch.calls).toHaveLength(1)
    await adapter.listModels(true)
    expect(fetch.calls).toHaveLength(2)
  })

  it('falls back to the built-in list without a key or when the listing fails (redacted error)', async () => {
    const none = await createGptAdapter(cfg({ apiKey: undefined })).listModels()
    expect(none.source).toBe('fallback')
    expect(none.error).toBeUndefined()

    const fetch = scriptedFetch([jsonResponse({ error: { message: `Incorrect API key provided: ${KEY}` } }, 401)])
    const failed = await createGptAdapter(cfg({ maxRetries: 0 }), { fetch }).listModels()
    expect(failed.source).toBe('fallback')
    expect(failed.error).toMatch(/^OpenAI 401/)
    expect(failed.models.map((m) => m.id)).toContain('gpt-4.1-mini')
    expect(JSON.stringify(failed)).not.toContain(KEY)

    const empty = scriptedFetch([jsonResponse({ object: 'list', data: [{ id: 'whisper-1' }] })])
    const e = await createGptAdapter(cfg(), { fetch: empty }).listModels()
    expect(e.source).toBe('fallback')
    expect(e.error).toMatch(/no listó modelos/)
  })
})
