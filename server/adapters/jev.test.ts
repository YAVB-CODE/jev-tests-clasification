import { describe, expect, it } from 'vitest'
import type { ClassificationTask, ConceptInput, LabeledConcept } from '../../src/shared/contracts.ts'
import { DEFAULT_TASK_INSTRUCTIONS, DEFAULT_TASK_QUESTION, buildCanonicalPrompt } from '../../src/shared/task.ts'
import { loadConfig, type JevConfig } from '../env.ts'
import type { FetchLike } from './common.ts'
import { JEV_MAX_CHOICES, buildJevRequest, createJevAdapter, describeDetail, mapJevResponse } from './jev.ts'

// ─────────────────────────────── Fake fetch helpers ───────────────────────────────

interface RecordedCall {
  url: string
  method: string
  headers: Headers
  body: unknown
  rawBody: unknown
}

type Step = Response | Error | ((call: RecordedCall, init?: RequestInit) => Response | Promise<Response>)

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
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
    const rawBody = init?.body
    let body: unknown = rawBody
    if (typeof rawBody === 'string') {
      try {
        body = JSON.parse(rawBody)
      } catch {
        body = rawBody
      }
    }
    const call: RecordedCall = { url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body, rawBody }
    calls.push(call)
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]
    if (step instanceof Error) throw step
    if (typeof step === 'function') return step(call, init)
    return step.clone()
  }
  return Object.assign(fn, { calls })
}

// ─────────────────────────────── Fixtures ───────────────────────────────

const KEY = 'zen-test-SECRET-abcdef123456'

function cfg(overrides: Partial<JevConfig> = {}): JevConfig {
  return { ...loadConfig({ OPENCODE_API_KEY: KEY }).jev, ...overrides }
}

const task: ClassificationTask = {
  instructions: DEFAULT_TASK_INSTRUCTIONS,
  question: DEFAULT_TASK_QUESTION,
  categories: [
    { id: '513530', name: 'Energía eléctrica', description: 'Servicio de energía', group: '5135 Servicios' },
    { id: '513525', name: 'Acueducto y alcantarillado', description: 'Servicio de agua', group: '5135 Servicios' },
    { id: '1635', name: 'Licencias', description: 'Licencias perpetuas' },
  ],
}
const IDS = ['513530', '513525', '1635']

/** The label travels with the item on purpose: the adapter must never send it. */
const labeled: LabeledConcept = {
  id: 'item-secret-id-77',
  concept: 'Servicio de energía periodo marzo',
  supplier: 'Enel Colombia',
  amount: 412_000,
  currency: 'COP',
  expected: '513530',
  difficulty: 'easy',
  rationale: 'RATIONALE-NEVER-SENT',
}
const item: ConceptInput = labeled

/** /v1/systemone body as OpenCode Zen returns it. */
function jevBody(category: unknown = undefined, extra: Record<string, unknown> = {}) {
  return {
    model: 'jev-1.13-free',
    answers: {
      category: category ?? {
        type: 'choice',
        choice: '513530',
        confidence: 0.81,
        probabilities: { '1635': 0.0, '513525': 0.12, '513530': 0.88 },
      },
    },
    usage: { input_tokens: 421, output_tokens: 56 },
    ...extra,
  }
}

const RETRY_NOW = { 'retry-after-ms': '0' }

// ─────────────────────────────── Request ───────────────────────────────

describe('buildJevRequest', () => {
  it('packages the canonical prompt as one Choice question', () => {
    const prompt = buildCanonicalPrompt(task, item)
    expect(buildJevRequest(prompt, 'jev-1.13-free')).toEqual({
      model: 'jev-1.13-free',
      state: prompt.state,
      questions: {
        category: {
          type: 'choice',
          instructions: { question: prompt.question, context: prompt.context },
          criteria: prompt.criteria,
        },
      },
    })
  })
})

describe('createJevAdapter.classify — request', () => {
  it('POSTs exactly the canonical request to /v1/systemone, without label or item id', async () => {
    const fetch = scriptedFetch([jsonResponse(jevBody())])
    await createJevAdapter(cfg(), { fetch }).classify(task, item)

    expect(fetch.calls).toHaveLength(1)
    const call = fetch.calls[0]
    expect(call.url).toBe('https://opencode.ai/zen/v1/systemone')
    expect(call.method).toBe('POST')
    expect(call.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    expect(call.headers.get('content-type')).toBe('application/json')

    const prompt = buildCanonicalPrompt(task, item)
    expect(call.body).toEqual({
      model: 'jev-1.13-free',
      state: prompt.state,
      questions: {
        category: {
          type: 'choice',
          instructions: { question: prompt.question, context: prompt.context },
          criteria: prompt.criteria,
        },
      },
    })
    const sent = call.body as { state: unknown; questions: { category: { criteria: Record<string, string> } } }
    expect(sent.state).toEqual({
      task: DEFAULT_TASK_INSTRUCTIONS,
      invoice_line: { concept: 'Servicio de energía periodo marzo', supplier: 'Enel Colombia', amount: 412_000, currency: 'COP' },
    })
    // Options are the category ids themselves, in JSON (= Object.keys) order.
    expect(Object.keys(sent.questions.category.criteria)).toEqual(Object.keys(prompt.criteria))
    expect(Object.keys(sent.questions.category.criteria)).toEqual(['1635', '513525', '513530'])
    expect(sent.questions.category.criteria['513530']).toBe('Energía eléctrica (grupo: 5135 Servicios): Servicio de energía')

    const text = String(call.rawBody)
    for (const leak of ['expected', 'difficulty', 'rationale', 'RATIONALE-NEVER-SENT', 'item-secret-id-77']) {
      expect(text).not.toContain(leak)
    }
  })

  it('uses the model picked in the UI', async () => {
    const fetch = scriptedFetch([jsonResponse(jevBody(undefined, { model: 'jev-1.13' }))])
    const r = await createJevAdapter(cfg(), { fetch }).classify(task, item, { model: 'jev-1.13' })
    expect((fetch.calls[0].body as { model: string }).model).toBe('jev-1.13')
    expect(r.model).toBe('jev-1.13')
  })

  it('returns missingKeyResult without calling OpenCode Zen when the key is missing', async () => {
    const fetch = scriptedFetch([jsonResponse(jevBody())])
    const adapter = createJevAdapter(cfg({ apiKey: undefined }), { fetch })
    expect(adapter.live).toBe(false)
    const r = await adapter.classify(task, item)
    expect(r).toMatchObject({ engine: 'jev', mode: 'live', status: 'error', model: 'jev-1.13-free', answer: { categoryId: null } })
    expect(r.errorMessage).toContain('OPENCODE_API_KEY')
    expect(fetch.calls).toHaveLength(0)
  })

  it('refuses tasks over the 255-option API limit without calling the API', async () => {
    const fetch = scriptedFetch([jsonResponse(jevBody())])
    const big: ClassificationTask = {
      ...task,
      categories: Array.from({ length: JEV_MAX_CHOICES + 1 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, description: '' })),
    }
    const r = await createJevAdapter(cfg(), { fetch }).classify(big, item)
    expect(r.status).toBe('error')
    expect(r.errorMessage).toContain('255')
    expect(fetch.calls).toHaveLength(0)
  })
})

// ─────────────────────────────── Mapping ───────────────────────────────

describe('createJevAdapter.classify — mapping', () => {
  it('maps choice, probabilities, comparable and native confidence, usage, cost and raw payloads', async () => {
    const fetch = scriptedFetch([
      jsonResponse(jevBody(), 200, { 'x-opencode-log-id': 'log-1', 'x-opencode-upstream-model-id': 'jev-1.13.0' }),
    ])
    const r = await createJevAdapter(cfg(), { fetch }).classify(task, item)

    expect(r).toMatchObject({ engine: 'jev', mode: 'live', model: 'jev-1.13-free', status: 'ok' })
    expect(r.errorMessage).toBeUndefined()
    expect(r.answer).toEqual({
      categoryId: '513530',
      confidence: 0.88,
      probabilities: { '513530': 0.88, '513525': 0.12, '1635': 0 },
      nativeConfidence: 0.81,
      nativeConfidenceKind: 'jev_confidence',
    })
    expect(r.usage).toEqual({ inputTokens: 421, outputTokens: 56 })
    expect(r.costUsd).toBe(0)
    expect(r.providerLatencyMs).toBeGreaterThanOrEqual(0)
    expect(r.attempts).toEqual([expect.objectContaining({ attempt: 1, status: 200 })])

    const raw = r.raw as { request: Record<string, unknown>; response: Record<string, unknown> }
    expect(raw.request).toMatchObject({ model: 'jev-1.13-free', state: buildCanonicalPrompt(task, item).state })
    expect(raw.request.questions).toEqual((fetch.calls[0].body as { questions: unknown }).questions)
    expect(raw.response).toMatchObject({
      model: 'jev-1.13-free',
      upstreamModel: 'jev-1.13.0',
      requestId: 'log-1',
      usage: { input_tokens: 421, output_tokens: 56 },
      answers: jevBody().answers,
      pricing: { inputPerMTok: 0, outputPerMTok: 0, source: 'free' },
    })
    expect(JSON.stringify(r)).not.toContain(KEY)
  })

  it('flags a choice outside the category set as invalid (usage kept)', async () => {
    const fetch = scriptedFetch([
      jsonResponse(jevBody({ type: 'choice', choice: '999999', confidence: 1, probabilities: { '999999': 1 } })),
    ])
    const r = await createJevAdapter(cfg(), { fetch }).classify(task, item)
    expect(r.status).toBe('invalid')
    expect(r.answer).toEqual({ categoryId: null })
    expect(r.errorMessage).toContain('fuera del conjunto')
    expect(r.usage?.inputTokens).toBe(421)
  })

  it('is exact: no trimming or case folding of the choice', () => {
    expect(mapJevResponse(jevBody({ type: 'choice', choice: ' 513530' }), IDS).status).toBe('invalid')
    expect(mapJevResponse(jevBody({ type: 'choice', choice: 513530 }), IDS).status).toBe('invalid')
  })

  it('flags missing answers and malformed bodies as invalid', async () => {
    expect(mapJevResponse({ model: 'jev-1.13' }, IDS)).toMatchObject({ status: 'invalid', answer: { categoryId: null } })
    expect(mapJevResponse(null, IDS).status).toBe('invalid')
    expect(mapJevResponse({ answers: [] }, IDS).status).toBe('invalid')
    expect(mapJevResponse({ answers: { other: { type: 'choice', choice: '513530' } } }, IDS).errorMessage).toContain('`category`')
    expect(mapJevResponse(jevBody({ type: 'choice', confidence: 0.4 }), IDS).errorMessage).toContain('falta `choice`')
    expect(mapJevResponse(jevBody({ type: 'score', score: 1 }), IDS).status).toBe('invalid')

    const fetch = scriptedFetch([jsonResponse('<html>oops</html>', 200, { 'content-type': 'text/html' })])
    const r = await createJevAdapter(cfg(), { fetch }).classify(task, item)
    expect(r.status).toBe('invalid')
    expect(r.answer.categoryId).toBeNull()
    expect(r.errorMessage).toContain('answers')
  })

  it('sanitises odd probabilities: clamps to [0, 1], drops unknown ids and non-numbers', async () => {
    const weird = `{"model":"jev-1.13-free","answers":{"category":{"type":"choice","choice":"513525","confidence":1.7,
      "probabilities":{"513530":-0.2,"513525":1.4,"1635":"0.3","999":0.5,"__proto__":0.9,"constructor":0.1}}},
      "usage":{"input_tokens":-5,"output_tokens":3}}`
    const fetch = scriptedFetch([jsonResponse(weird)])
    const r = await createJevAdapter(cfg(), { fetch }).classify(task, item)
    expect(r.status).toBe('ok')
    expect(r.answer).toEqual({
      categoryId: '513525',
      confidence: 1,
      probabilities: { '513530': 0, '513525': 1 },
      nativeConfidence: 1,
      nativeConfidenceKind: 'jev_confidence',
    })
    expect(r.usage).toBeUndefined() // negative input count is not trusted
    expect(r.costUsd).toBeUndefined()
  })

  it('keeps the answer when probabilities or confidence are missing', () => {
    const r = mapJevResponse(jevBody({ type: 'choice', choice: '1635', probabilities: { '513530': 0.6 } }), IDS)
    expect(r.status).toBe('ok')
    expect(r.answer).toEqual({ categoryId: '1635', probabilities: { '513530': 0.6 } })
    expect(mapJevResponse(jevBody({ choice: '1635', probabilities: 'x', confidence: NaN }), IDS).answer).toEqual({ categoryId: '1635' })
  })

  it('accepts category ids that collide with Object.prototype names', () => {
    const r = mapJevResponse(
      { answers: { category: { type: 'choice', choice: 'constructor', probabilities: { constructor: 0.7, toString: 0.3 } } } },
      ['constructor', 'toString'],
    )
    expect(r.answer).toEqual({ categoryId: 'constructor', confidence: 0.7, probabilities: { constructor: 0.7, toString: 0.3 } })
    expect(mapJevResponse({ answers: { category: { choice: 'constructor' } } }, ['a', 'b']).status).toBe('invalid')
  })
})

describe('cost', () => {
  it('free model costs 0; paid model bills input only', async () => {
    const free = await createJevAdapter(cfg(), { fetch: scriptedFetch([jsonResponse(jevBody())]) }).classify(task, item)
    expect(free.costUsd).toBe(0)

    const paidBody = jevBody(undefined, { model: 'jev-1.13', usage: { input_tokens: 1_000_000, output_tokens: 500_000 } })
    const paid = await createJevAdapter(cfg({ model: 'jev-1.13' }), { fetch: scriptedFetch([jsonResponse(paidBody)]) }).classify(task, item)
    expect(paid.costUsd).toBeCloseTo(0.042, 12)
    expect((paid.raw as { response: { pricing: unknown } }).response.pricing).toEqual({
      inputPerMTok: 0.042,
      outputPerMTok: 0,
      source: 'env',
    })

    const custom = await createJevAdapter(cfg({ model: 'jev-1.13', priceInputPerMTok: 0.1 }), {
      fetch: scriptedFetch([jsonResponse(jevBody(undefined, { usage: { input_tokens: 421, output_tokens: 56 } }))]),
    }).classify(task, item)
    expect(custom.costUsd).toBeCloseTo(421 * 0.1e-6, 15)
  })
})

// ─────────────────────────────── Retries / timeout / abort ───────────────────────────────

describe('createJevAdapter.classify — retries, timeout and abort', () => {
  it('retries a 429 and records both attempts', async () => {
    const fetch = scriptedFetch([jsonResponse({ detail: 'Too many requests' }, 429, RETRY_NOW), jsonResponse(jevBody())])
    const r = await createJevAdapter(cfg(), { fetch }).classify(task, item)
    expect(r.status).toBe('ok')
    expect(fetch.calls).toHaveLength(2)
    expect(r.attempts?.map((a) => a.status)).toEqual([429, 200])
  })

  it('retries a 529 (overloaded) and a 503', async () => {
    for (const status of [529, 503]) {
      const fetch = scriptedFetch([jsonResponse({ detail: 'Overloaded' }, status, RETRY_NOW), jsonResponse(jevBody())])
      const r = await createJevAdapter(cfg(), { fetch }).classify(task, item)
      expect(r.status, String(status)).toBe('ok')
      expect(r.attempts?.map((a) => a.status)).toEqual([status, 200])
    }
  })

  it('gives up after cfg.maxRetries on repeated 529', async () => {
    const fetch = scriptedFetch([jsonResponse({ detail: 'Overloaded' }, 529, RETRY_NOW)])
    const r = await createJevAdapter(cfg({ maxRetries: 2 }), { fetch }).classify(task, item)
    expect(fetch.calls).toHaveLength(3)
    expect(r.status).toBe('error')
    expect(r.errorMessage).toBe('OpenCode Zen (Jev) 529: proveedor sobrecargado (tras 3 intentos): Overloaded')
    expect(r.attempts?.map((a) => a.status)).toEqual([529, 529, 529])
  })

  it('does not retry when maxRetries is 0', async () => {
    const fetch = scriptedFetch([jsonResponse({ detail: 'slow down' }, 429, RETRY_NOW), jsonResponse(jevBody())])
    const r = await createJevAdapter(cfg({ maxRetries: 0 }), { fetch }).classify(task, item)
    expect(fetch.calls).toHaveLength(1)
    expect(r.status).toBe('error')
    expect(r.errorMessage).toContain('429')
  })

  it('retries a network failure, then reports it in Spanish', async () => {
    const recovered = scriptedFetch([new TypeError('fetch failed'), jsonResponse(jevBody())])
    const ok = await createJevAdapter(cfg(), { fetch: recovered }).classify(task, item)
    expect(ok.status).toBe('ok')
    expect(ok.attempts?.map((a) => a.status)).toEqual([null, 200])

    const down = scriptedFetch([new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND opencode.ai') })])
    const r = await createJevAdapter(cfg(), { fetch: down }).classify(task, item)
    expect(down.calls).toHaveLength(2)
    expect(r.status).toBe('error')
    expect(r.errorMessage).toBe('OpenCode Zen (Jev): error de red (tras 2 intentos): getaddrinfo ENOTFOUND opencode.ai')
  })

  it('reports our per-attempt timeout as status timeout, without retrying', async () => {
    const fetch = scriptedFetch([hangUntilAborted, jsonResponse(jevBody())])
    const r = await createJevAdapter(cfg({ timeoutMs: 30, maxRetries: 2 }), { fetch }).classify(task, item)
    expect(fetch.calls).toHaveLength(1)
    expect(r.status).toBe('timeout')
    expect(r.answer.categoryId).toBeNull()
    expect(r.errorMessage).toContain('30 ms')
    expect(r.attempts).toEqual([expect.objectContaining({ attempt: 1, status: null, error: 'timeout (30 ms)' })])
    expect(r.providerLatencyMs).toBeGreaterThanOrEqual(25)
  })

  it('aborts the upstream call when the caller signal fires', async () => {
    const fetch = scriptedFetch([hangUntilAborted])
    const controller = new AbortController()
    const pending = createJevAdapter(cfg(), { fetch }).classify(task, item, { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    const r = await pending
    expect(r.status).toBe('error')
    expect(r.errorMessage).toContain('cancelada')
    expect(fetch.calls).toHaveLength(1)
    expect(r.attempts).toEqual([expect.objectContaining({ status: null, error: 'aborted' })])
  })

  it('never calls the API when the signal is already aborted', async () => {
    const fetch = scriptedFetch([jsonResponse(jevBody())])
    const controller = new AbortController()
    controller.abort()
    const r = await createJevAdapter(cfg(), { fetch }).classify(task, item, { signal: controller.signal })
    expect(r.status).toBe('error')
    expect(fetch.calls).toHaveLength(0)
  })

  it('stops during the backoff wait when the caller aborts', async () => {
    const fetch = scriptedFetch([jsonResponse({ detail: 'busy' }, 429, { 'retry-after-ms': '1000' }), jsonResponse(jevBody())])
    const controller = new AbortController()
    const pending = createJevAdapter(cfg(), { fetch }).classify(task, item, { signal: controller.signal })
    setTimeout(() => controller.abort(), 30)
    const started = performance.now()
    const r = await pending
    expect(performance.now() - started).toBeLessThan(500)
    expect(r.status).toBe('error')
    expect(r.errorMessage).toContain('cancelada')
    expect(fetch.calls).toHaveLength(1)
  })
})

// ─────────────────────────────── HTTP errors ───────────────────────────────

describe('createJevAdapter.classify — HTTP errors', () => {
  it('401: names OPENCODE_API_KEY, no retry, key redacted', async () => {
    const fetch = scriptedFetch([
      jsonResponse({ type: 'error', error: { type: 'AuthError', message: `Invalid API key ${KEY}` } }, 401, { 'content-type': 'text/plain' }),
    ])
    const r = await createJevAdapter(cfg(), { fetch }).classify(task, item)
    expect(fetch.calls).toHaveLength(1)
    expect(r.status).toBe('error')
    expect(r.errorMessage).toMatch(/^OpenCode Zen \(Jev\) 401: API key inválida/)
    expect(r.errorMessage).toContain('OPENCODE_API_KEY')
    expect(JSON.stringify(r)).not.toContain(KEY)
  })

  it('401 ModelError: says the model is not available', async () => {
    const fetch = scriptedFetch([jsonResponse({ type: 'error', error: { type: 'ModelError', message: 'Model jev-9 is not supported' } }, 401)])
    const r = await createJevAdapter(cfg(), { fetch }).classify(task, item, { model: 'jev-9' })
    expect(r.errorMessage).toBe('OpenCode Zen (Jev) 401: modelo no disponible en OpenCode Zen: Model jev-9 is not supported')
    expect(r.model).toBe('jev-9')
  })

  it('422 / 400: readable detail, no retry', async () => {
    const detail = [{ loc: ['body', 'questions', 'category', 'criteria'], msg: 'field required', type: 'missing' }]
    const fetch422 = scriptedFetch([jsonResponse({ detail }, 422)])
    const r422 = await createJevAdapter(cfg(), { fetch: fetch422 }).classify(task, item)
    expect(fetch422.calls).toHaveLength(1)
    expect(r422.status).toBe('error')
    expect(r422.errorMessage).toBe('OpenCode Zen (Jev) 422: solicitud rechazada: questions.category.criteria: field required')
    expect(r422.raw?.response).toMatchObject({ status: 422 })

    const fetch400 = scriptedFetch([jsonResponse({ detail: 'Too many choices. Must have at most 255 choices.' }, 400)])
    const r400 = await createJevAdapter(cfg(), { fetch: fetch400 }).classify(task, item)
    expect(r400.errorMessage).toBe('OpenCode Zen (Jev) 400: solicitud rechazada: Too many choices. Must have at most 255 choices.')
  })

  it('5xx after retries: status and provider message', async () => {
    const fetch = scriptedFetch([jsonResponse({ error: { type: 'server_error', message: 'Upstream request failed' } }, 500, RETRY_NOW)])
    const r = await createJevAdapter(cfg(), { fetch }).classify(task, item)
    expect(fetch.calls).toHaveLength(2)
    expect(r.errorMessage).toBe('OpenCode Zen (Jev) 500 (tras 2 intentos): Upstream request failed')
  })

  it('describeDetail handles every body shape', () => {
    expect(describeDetail({ detail: 'x' })).toBe('x')
    expect(describeDetail({ detail: { error_type: 'api_usage_error', message: 'Invalid request.' } })).toBe('Invalid request.')
    expect(describeDetail({ error: 'nope' })).toBe('nope')
    expect(describeDetail({ message: 'm' })).toBe('m')
    expect(describeDetail(' plain text ')).toBe('plain text')
    expect(describeDetail(undefined)).toBe('')
    expect(describeDetail({ detail: [{ loc: ['body', 'model'], msg: 'required' }, 'other'] })).toBe('model: required; other')
  })
})

// ─────────────────────────────── listModels ───────────────────────────────

describe('createJevAdapter.listModels', () => {
  const listing = {
    object: 'list',
    data: [{ id: 'big-pickle' }, { id: 'jev-1.13' }, { id: 'gpt-5' }, { id: 'jev-1.13-free' }, { id: 'jev-2.0' }],
  }

  it('lists the jev* models from GET /v1/models, default first, and caches them', async () => {
    const fetch = scriptedFetch([jsonResponse(listing)])
    const adapter = createJevAdapter(cfg(), { fetch })
    const list = await adapter.listModels()
    expect(fetch.calls[0].url).toBe('https://opencode.ai/zen/v1/models')
    expect(fetch.calls[0].headers.get('authorization')).toBe(`Bearer ${KEY}`)
    expect(list).toMatchObject({ default: 'jev-1.13-free', provider: 'OpenCode Zen', source: 'provider' })
    expect(list.models.map((m) => m.id)).toEqual(['jev-1.13-free', 'jev-1.13', 'jev-2.0'])
    expect(list.models[0]).toMatchObject({ inputPerMTok: 0, outputPerMTok: 0, priceSource: 'free' })
    expect(list.models[1]).toMatchObject({ inputPerMTok: 0.042, outputPerMTok: 0, priceSource: 'env' })

    await adapter.listModels()
    expect(fetch.calls).toHaveLength(1)
    await adapter.listModels(true)
    expect(fetch.calls).toHaveLength(2)
  })

  it('falls back to the built-in list on HTTP errors, network errors, empty listings or no key', async () => {
    const http = await createJevAdapter(cfg(), { fetch: scriptedFetch([jsonResponse({}, 503)]) }).listModels()
    expect(http).toMatchObject({ source: 'fallback', default: 'jev-1.13-free' })
    expect(http.error).toContain('503')

    const net = await createJevAdapter(cfg(), { fetch: scriptedFetch([new TypeError(`boom ${KEY}`)]) }).listModels()
    expect(net.source).toBe('fallback')
    expect(net.error).toContain('boom')
    expect(JSON.stringify(net)).not.toContain(KEY)

    const empty = await createJevAdapter(cfg(), { fetch: scriptedFetch([jsonResponse({ data: [{ id: 'gpt-5' }] })]) }).listModels()
    expect(empty.source).toBe('fallback')

    const noKeyFetch = scriptedFetch([jsonResponse(listing)])
    const noKey = await createJevAdapter(cfg({ apiKey: undefined }), { fetch: noKeyFetch }).listModels()
    expect(noKey.source).toBe('fallback')
    expect(noKey.models.map((m) => m.id)).toEqual(['jev-1.13-free', 'jev-1.13'])
    expect(noKeyFetch.calls).toHaveLength(0)
  })

  it('falls back when the listing times out', async () => {
    const list = await createJevAdapter(cfg({ timeoutMs: 20 }), { fetch: scriptedFetch([hangUntilAborted]) }).listModels()
    expect(list.source).toBe('fallback')
    expect(list.error).toContain('tiempo agotado')
  })
})
