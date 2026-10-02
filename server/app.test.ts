import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ApiErrorBody,
  ClassificationTask,
  ClassifyResult,
  ConceptInput,
  EngineId,
  HealthResponse,
  ModelsResponse,
} from '../src/shared/contracts.ts'
import { DEFAULT_TASK_INSTRUCTIONS, DEFAULT_TASK_QUESTION } from '../src/shared/task.ts'
import type { Adapters, ClassifyOptions, EngineAdapter } from './adapters/common.ts'
import { createAdapters } from './adapters/index.ts'
import { createApp, hostHeaderName, type AppOptions } from './app.ts'
import { loadConfig } from './env.ts'

type Classify = (task: ClassificationTask, item: ConceptInput, options?: ClassifyOptions) => Promise<ClassifyResult>

interface FakeAdapter extends EngineAdapter {
  tasks: ClassificationTask[]
  items: ConceptInput[]
  options: Array<ClassifyOptions | undefined>
}

const TASK: ClassificationTask = {
  instructions: DEFAULT_TASK_INSTRUCTIONS,
  question: DEFAULT_TASK_QUESTION,
  categories: [
    { id: '513530', name: 'Energía eléctrica', description: 'Servicio de energía', group: '5135 Servicios' },
    { id: '513525', name: 'Acueducto', description: 'Servicio de agua' },
  ],
}
const ITEM: ConceptInput = { id: 'c1', concept: 'Servicio de energía periodo marzo', supplier: 'Enel', amount: 120000, currency: 'COP' }

function requestBody(extra: Record<string, unknown> = {}) {
  return { engine: 'gpt', task: TASK, item: ITEM, ...extra }
}

function okResult(engine: EngineId): ClassifyResult {
  return {
    engine,
    mode: 'live',
    model: `${engine}-test`,
    status: 'ok',
    answer: { categoryId: '513530', confidence: 0.9 },
    providerLatencyMs: 5,
  }
}

function fakeAdapter(engine: EngineId, classify?: Classify): FakeAdapter {
  const tasks: ClassificationTask[] = []
  const items: ConceptInput[] = []
  const options: Array<ClassifyOptions | undefined> = []
  return {
    engine,
    live: true,
    model: `${engine}-test`,
    provider: engine === 'gpt' ? 'OpenAI' : 'OpenCode Zen',
    tasks,
    items,
    options,
    async classify(task, item, opts) {
      tasks.push(task)
      items.push(item)
      options.push(opts)
      return classify ? classify(task, item, opts) : okResult(engine)
    },
    async listModels(force) {
      return { default: `${engine}-test`, models: [{ id: `${engine}-test` }, { id: `${engine}-other` }], source: force ? 'provider' : 'fallback' }
    },
  }
}

function fakeAdapters(): { gpt: FakeAdapter; jev: FakeAdapter } {
  return { gpt: fakeAdapter('gpt'), jev: fakeAdapter('jev') }
}

const servers: Array<{ close: () => void }> = []
afterEach(() => {
  while (servers.length) servers.pop()?.close()
})

async function start(options: Partial<AppOptions> & Pick<AppOptions, 'adapters'>) {
  const lines: string[] = []
  const app = createApp({ log: (line) => lines.push(line), ...options })
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  servers.push({ close: () => server.close() })
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, lines }
}

/** Polls until `check` passes (log lines are written on the response 'close' event, a tick after the client got it). */
async function eventually(check: () => void, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return check()
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise((r) => setTimeout(r, 10))
    }
  }
}

function post(base: string, body: unknown, init: RequestInit = {}) {
  return fetch(`${base}/api/classify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  })
}

describe('GET /api/health', () => {
  it('reports each engine as live with its default model and provider, no warnings by default', async () => {
    const { base } = await start({ adapters: fakeAdapters() })
    const res = await fetch(`${base}/api/health`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect((await res.json()) as HealthResponse).toEqual({
      ok: true,
      engines: {
        gpt: { live: true, model: 'gpt-test', provider: 'OpenAI' },
        jev: { live: true, model: 'jev-test', provider: 'OpenCode Zen' },
      },
      warnings: [],
    })
  })

  it('reads adapters and warnings on every request (hot-reloaded .env)', async () => {
    let current: Adapters = fakeAdapters()
    let warnings: string[] = []
    const { base } = await start({ adapters: () => current, warnings: () => warnings })
    const health = async () => (await (await fetch(`${base}/api/health`)).json()) as HealthResponse
    expect((await health()).engines.jev.live).toBe(true)

    current = { gpt: fakeAdapter('gpt'), jev: { ...fakeAdapter('jev'), live: false, model: 'jev-new' } }
    warnings = ['Falta OPENCODE_API_KEY: Jev solo estará disponible en modo simulado.']
    expect(await health()).toMatchObject({
      engines: { jev: { live: false, model: 'jev-new' } },
      warnings: ['Falta OPENCODE_API_KEY: Jev solo estará disponible en modo simulado.'],
    })
  })
})

describe('GET /api/models', () => {
  it('returns both catalogues directly keyed by engine and forwards ?refresh=1', async () => {
    const { base } = await start({ adapters: fakeAdapters() })
    const cached = (await (await fetch(`${base}/api/models`)).json()) as ModelsResponse
    expect(cached.gpt).toMatchObject({ default: 'gpt-test', source: 'fallback' })
    expect(cached.jev.models.map((m) => m.id)).toEqual(['jev-test', 'jev-other'])
    const fresh = await fetch(`${base}/api/models?refresh=1`)
    expect(fresh.headers.get('cache-control')).toBe('no-store')
    const body = (await fresh.json()) as ModelsResponse
    expect([body.gpt.source, body.jev.source]).toEqual(['provider', 'provider'])
  })

  it('falls back to the default model when an adapter listing throws (no secrets)', async () => {
    const jev = fakeAdapter('jev')
    jev.listModels = async () => {
      throw new Error('boom sk-should-not-leak-123456')
    }
    const { base } = await start({ adapters: { gpt: fakeAdapter('gpt'), jev } })
    const res = await fetch(`${base}/api/models`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ModelsResponse
    expect(body.jev).toMatchObject({ default: 'jev-test', source: 'fallback', models: [{ id: 'jev-test' }] })
    expect(JSON.stringify(body)).not.toContain('sk-should-not-leak')
  })
})

describe('POST /api/classify', () => {
  it('routes to the engine adapter, passes model and signal, and returns the ClassifyResult', async () => {
    const { gpt, jev } = fakeAdapters()
    const { base, lines } = await start({ adapters: { gpt, jev } })
    const res = await post(base, requestBody({ engine: 'jev', model: 'jev-1.13' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(okResult('jev'))
    expect(gpt.items).toHaveLength(0)
    expect(jev.items).toEqual([ITEM])
    expect(jev.tasks).toEqual([TASK])
    expect(jev.options[0]?.model).toBe('jev-1.13')
    expect(jev.options[0]?.signal).toBeInstanceOf(AbortSignal)
    await eventually(() =>
      expect(lines).toContainEqual(expect.stringMatching(/POST \/api\/classify 200 \d+ms engine=jev result=ok model=jev-test provider=5ms/)),
    )
  })

  it('uses the default model (undefined) when the body has none', async () => {
    const gpt = fakeAdapter('gpt')
    const { base } = await start({ adapters: { gpt, jev: fakeAdapter('jev') } })
    expect((await post(base, requestBody())).status).toBe(200)
    expect(gpt.options[0]?.model).toBeUndefined()
  })

  it('never lets the expected label (or other extras) reach the adapter', async () => {
    const { gpt, jev } = fakeAdapters()
    const { base } = await start({ adapters: { gpt, jev } })
    const labeled = { ...ITEM, expected: '513530', difficulty: 'hard', rationale: 'es energía', oracle: 'x' }
    const res = await post(base, requestBody({ item: labeled, expected: '513530' }))
    expect(res.status).toBe(200)
    expect(gpt.items).toEqual([ITEM])
    expect(gpt.items[0]).not.toHaveProperty('expected')
    expect(JSON.stringify([gpt.items, gpt.tasks])).not.toMatch(/expected|rationale|difficulty|oracle/)
  })

  it('serves the same result shape for status invalid / timeout from the adapter', async () => {
    const timeout: ClassifyResult = { ...okResult('gpt'), status: 'timeout', answer: { categoryId: null }, errorMessage: 'Tiempo agotado' }
    const gpt = fakeAdapter('gpt', async () => timeout)
    const { base } = await start({ adapters: { gpt, jev: fakeAdapter('jev') } })
    const res = await post(base, requestBody())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(timeout)
  })

  it('turns an unexpected adapter exception into HTTP 200 status error, without leaking secrets', async () => {
    const gpt = fakeAdapter('gpt', async () => {
      throw new Error('kaboom with sk-should-not-leak-123456')
    })
    const { base } = await start({ adapters: { gpt, jev: fakeAdapter('jev') } })
    const res = await post(base, requestBody())
    expect(res.status).toBe(200)
    const body = (await res.json()) as ClassifyResult
    expect(body).toMatchObject({ engine: 'gpt', status: 'error', answer: { categoryId: null } })
    expect(body.errorMessage).toBeTruthy()
    expect(JSON.stringify(body)).not.toContain('sk-should-not-leak')
  })
})

describe('POST /api/classify validation (400 ApiErrorBody)', () => {
  it.each([
    ['missing engine', { task: TASK, item: ITEM }, 'engine:'],
    ['unknown engine', requestBody({ engine: 'claude' }), 'engine:'],
    ['malformed model', requestBody({ model: 'gpt 4' }), 'model:'],
    ['missing task', { engine: 'gpt', item: ITEM }, 'task:'],
    ['task with one category', requestBody({ task: { ...TASK, categories: [TASK.categories[0]] } }), 'task.categories'],
    ['task with duplicate category ids', requestBody({ task: { ...TASK, categories: [TASK.categories[0], TASK.categories[0]] } }), 'task.categories[1].id'],
    ['missing item', { engine: 'gpt', task: TASK }, 'item:'],
    ['item without concept', requestBody({ item: { id: 'c1' } }), 'item.concept'],
    ['item that is a string', requestBody({ item: 'energía' }), 'item:'],
    ['body is an array', [requestBody()], 'body:'],
  ])('400 when %s', async (_name, body, field) => {
    const { gpt, jev } = fakeAdapters()
    const { base } = await start({ adapters: { gpt, jev } })
    const res = await post(base, body)
    expect(res.status).toBe(400)
    const error = (await res.json()) as ApiErrorBody
    expect(typeof error.error).toBe('string')
    expect(error.details?.some((d) => d.startsWith(field))).toBe(true)
    expect(gpt.items.length + jev.items.length).toBe(0)
  })

  it('400 with a Spanish JSON error for malformed JSON and 400 for a non-JSON body', async () => {
    const { base } = await start({ adapters: fakeAdapters() })
    const malformed = await post(base, '{"engine": "gpt", ')
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: 'JSON inválido en el cuerpo de la solicitud.' })
    const text = await fetch(`${base}/api/classify`, { method: 'POST', body: 'hello', headers: { 'content-type': 'text/plain' } })
    expect(text.status).toBe(400)
    const empty = await fetch(`${base}/api/classify`, { method: 'POST' })
    expect(empty.status).toBe(400)
    // Top-level JSON primitives are rejected by the strict parser.
    for (const primitive of ['null', '"hola"', '42']) expect((await post(base, primitive)).status).toBe(400)
  })

  it('413 JSON error when the body exceeds the limit', async () => {
    const { base } = await start({ adapters: fakeAdapters() })
    const res = await post(base, requestBody({ padding: 'x'.repeat(1_200_000) }))
    expect(res.status).toBe(413)
    const error = (await res.json()) as ApiErrorBody
    expect(error.error).toMatch(/límite/)
    expect(JSON.stringify(error)).not.toMatch(/at \w+|node_modules/)
  })

  it('404 JSON for unknown API routes (and unsupported methods on known paths)', async () => {
    const { base, lines } = await start({ adapters: fakeAdapters() })
    const res = await fetch(`${base}/api/x?q=1`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Ruta de API no encontrada.' })
    await eventually(() => expect(lines).toContainEqual(expect.stringMatching(/^\[api\] GET \/api\/x 404 \d+ms$/)))
    expect((await fetch(`${base}/api/classify`)).status).toBe(404)
    expect((await fetch(`${base}/api`)).status).toBe(404)
  })
})

describe('client disconnect', () => {
  it('aborts the adapter signal when the browser request is aborted', async () => {
    let sawAbort!: () => void
    const aborted = new Promise<void>((resolve) => (sawAbort = resolve))
    let started!: () => void
    const classifyStarted = new Promise<void>((resolve) => (started = resolve))
    const gpt = fakeAdapter('gpt', (_task, _item, options) => {
      started()
      return new Promise((resolve) => {
        options?.signal?.addEventListener('abort', () => {
          sawAbort()
          resolve({ ...okResult('gpt'), status: 'error', errorMessage: 'aborted' })
        })
      })
    })
    const { base, lines } = await start({ adapters: { gpt, jev: fakeAdapter('jev') } })
    const controller = new AbortController()
    const request = post(base, requestBody(), { signal: controller.signal })
    await classifyStarted
    controller.abort()
    await expect(request).rejects.toThrow()
    await aborted
    await eventually(() => expect(lines.some((l) => l.includes('client-closed') && l.includes('engine=gpt'))).toBe(true))
  })

  it('does not abort the signal after a normal response', async () => {
    const gpt = fakeAdapter('gpt')
    const { base } = await start({ adapters: { gpt, jev: fakeAdapter('jev') } })
    expect((await post(base, requestBody())).status).toBe(200)
    await new Promise((r) => setTimeout(r, 20))
    expect(gpt.options[0]?.signal?.aborted).toBe(false)
  })
})

describe('missing keys (real adapters, empty env)', () => {
  it('health shows both engines not live, classify answers fast with status error naming the env var', async () => {
    const adapters = createAdapters(loadConfig({}))
    const { base } = await start({ adapters })
    const health = (await (await fetch(`${base}/api/health`)).json()) as HealthResponse
    expect(health.engines.gpt).toMatchObject({ live: false, model: 'gpt-4.1-mini', provider: 'OpenAI' })
    expect(health.engines.jev).toMatchObject({ live: false, model: 'jev-1.13-free', provider: 'OpenCode Zen' })

    for (const engine of ['gpt', 'jev'] as const) {
      const t0 = performance.now()
      const res = await post(base, requestBody({ engine }))
      expect(performance.now() - t0).toBeLessThan(1000)
      expect(res.status).toBe(200)
      const body = (await res.json()) as ClassifyResult
      expect(body).toMatchObject({ engine, mode: 'live', status: 'error', answer: { categoryId: null } })
      expect(body.errorMessage).toContain(engine === 'gpt' ? 'OPENAI_API_KEY' : 'OPENCODE_API_KEY')
    }
  })
})

describe('static SPA (production)', () => {
  it('serves dist/ files and falls back to index.html, keeping /api 404s as JSON', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jev-classify-dist-'))
    try {
      writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Jev Classify Lab</title>')
      writeFileSync(path.join(dir, 'app.js'), 'console.log(1)')
      const { base } = await start({ adapters: fakeAdapters(), staticDir: dir })
      expect(await (await fetch(`${base}/app.js`)).text()).toBe('console.log(1)')
      expect(await (await fetch(`${base}/dataset/123`)).text()).toContain('Jev Classify Lab')
      const unknown = await fetch(`${base}/api/unknown`)
      expect(unknown.status).toBe(404)
      expect(await unknown.json()).toHaveProperty('error')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('API only (no static handler) when staticDir is missing', async () => {
    const { base } = await start({ adapters: fakeAdapters(), staticDir: path.join(tmpdir(), 'jev-classify-no-such-dir') })
    expect((await fetch(`${base}/`)).status).toBe(404)
    expect((await fetch(`${base}/api/health`)).status).toBe(200)
  })
})

describe('loopbackOnly (DNS-rebinding guard)', () => {
  /** node:http, because fetch does not let the caller choose the Host header. */
  function getWithHost(base: string, path: string, host: string): Promise<{ status: number; body: string }> {
    const url = new URL(path, base)
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET', headers: { host } }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject)
      req.end()
    })
  }

  it('parses Host headers', () => {
    expect(hostHeaderName('localhost:5174')).toBe('localhost')
    expect(hostHeaderName('[::1]:8788')).toBe('[::1]')
    expect(hostHeaderName('Evil.Example')).toBe('evil.example')
    expect(hostHeaderName(undefined)).toBe('')
  })

  it('serves localhost / 127.0.0.1 / [::1] and rejects any other Host with a JSON 403, before the adapters run', async () => {
    const adapters = fakeAdapters()
    const { base } = await start({ adapters, loopbackOnly: true })
    for (const host of ['localhost:5174', '127.0.0.1:8788', '[::1]:8788']) {
      expect((await getWithHost(base, '/api/health', host)).status).toBe(200)
    }
    const rejected = await getWithHost(base, '/api/health', 'evil.example:8788')
    expect(rejected.status).toBe(403)
    expect(JSON.parse(rejected.body) as ApiErrorBody).toMatchObject({ error: expect.stringContaining('Host no permitido') })
    expect(adapters.gpt.items).toHaveLength(0)
  })

  it('is off by default (API exposed on purpose with HOST=0.0.0.0)', async () => {
    const { base } = await start({ adapters: fakeAdapters() })
    expect((await getWithHost(base, '/api/health', 'my-laptop.lan:8788')).status).toBe(200)
  })
})
