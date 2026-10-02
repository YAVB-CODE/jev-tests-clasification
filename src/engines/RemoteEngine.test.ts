import { describe, expect, it, vi } from 'vitest'
import type { ClassifyResult, LabeledConcept } from '../shared/contracts.ts'
import { TASK, makeItems, okResult } from '../bench/testFixtures.ts'
import { createTimeoutError } from './abort.ts'
import { RemoteEngine } from './RemoteEngine.ts'
import type { FetchLike } from './http.ts'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function fakeFetch(response: Response | (() => Promise<Response>)) {
  return vi.fn<FetchLike>(async () => (typeof response === 'function' ? response() : response))
}

const signal = (): AbortSignal => new AbortController().signal
const labeled: LabeledConcept = makeItems(1)[0]

describe('RemoteEngine', () => {
  it('POSTs a ClassifyRequest without the label, even when given a LabeledConcept', async () => {
    const fetch = fakeFetch(json(okResult('gpt', '513525')))
    const engine = new RemoteEngine('gpt', { fetch })
    const taskWithExtras = { ...TASK, secret: 'x', categories: TASK.categories.map((c) => ({ ...c, hint: 'y' })) }

    const result = await engine.classify(taskWithExtras, labeled, { signal: signal(), model: 'gpt-4.1-mini' })

    expect(result.status).toBe('ok')
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('/api/classify')
    expect(init?.method).toBe('POST')
    const raw = init?.body as string
    const sent = JSON.parse(raw) as Record<string, unknown>
    expect(Object.keys(sent).sort()).toEqual(['engine', 'item', 'model', 'task'])
    expect(sent.engine).toBe('gpt')
    expect(sent.model).toBe('gpt-4.1-mini')
    expect(sent.item).toEqual({ id: 'item-0', concept: labeled.concept, supplier: labeled.supplier, amount: labeled.amount, currency: 'COP' })
    expect(sent.task).toEqual(TASK)
    for (const forbidden of ['expected', 'difficulty', 'rationale', 'Porque sí', 'secret', 'hint']) expect(raw).not.toContain(forbidden)
  })

  it('omits the model when none was picked and normalizes engine / mode', async () => {
    const fetch = fakeFetch(json({ ...okResult('gpt', '513530'), engine: 'gpt', mode: 'mock' }))
    const result = await new RemoteEngine('jev', { fetch }).classify(TASK, labeled, { signal: signal() })
    const sent = JSON.parse(fetch.mock.calls[0][1]?.body as string) as Record<string, unknown>
    expect(sent).not.toHaveProperty('model')
    expect(result).toMatchObject({ engine: 'jev', mode: 'live', status: 'ok', answer: { categoryId: '513530' } })
  })

  it('maps HTTP 400 (ApiErrorBody) to an error result with the details', async () => {
    const fetch = fakeFetch(json({ error: 'Solicitud inválida', details: ['task.categories[1].id: duplicado'] }, 400))
    const result = await new RemoteEngine('gpt', { fetch }).classify(TASK, labeled, { signal: signal(), model: 'm' })
    expect(result).toMatchObject({ status: 'error', engine: 'gpt', mode: 'live', model: 'm', answer: { categoryId: null } })
    expect(result.errorMessage).toContain('HTTP 400')
    expect(result.errorMessage).toContain('Solicitud inválida')
    expect(result.errorMessage).toContain('duplicado')
  })

  it('maps 5xx with an empty body to a server error with a hint', async () => {
    const fetch = fakeFetch(new Response('', { status: 502 }))
    const result = await new RemoteEngine('jev', { fetch }).classify(TASK, labeled, { signal: signal() })
    expect(result.status).toBe('error')
    expect(result.errorMessage).toContain('HTTP 502')
    expect(result.errorMessage).toContain('npm run dev')
  })

  it('maps network failures and malformed payloads to errors (never throws)', async () => {
    const down = vi.fn<FetchLike>(async () => {
      throw new TypeError('Failed to fetch')
    })
    const r1 = await new RemoteEngine('gpt', { fetch: down }).classify(TASK, labeled, { signal: signal() })
    expect(r1.status).toBe('error')
    expect(r1.errorMessage).toContain('No se pudo conectar')

    const r2 = await new RemoteEngine('gpt', { fetch: fakeFetch(json({ hello: 'world' })) }).classify(TASK, labeled, { signal: signal() })
    expect(r2.status).toBe('error')
    expect(r2.errorMessage).toContain('formato inesperado')

    const r3 = await new RemoteEngine('gpt', { fetch: fakeFetch(new Response('<html>', { status: 200 })) }).classify(TASK, labeled, { signal: signal() })
    expect(r3.status).toBe('error')
  })

  it('returns timeout / cancellation results when the signal aborts', async () => {
    const hanging = (init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    const fetch = vi.fn<FetchLike>((_url, init) => hanging(init))

    const timeout = new AbortController()
    const p1 = new RemoteEngine('gpt', { fetch }).classify(TASK, labeled, { signal: timeout.signal })
    timeout.abort(createTimeoutError())
    expect((await p1).status).toBe('timeout')

    const cancel = new AbortController()
    const p2 = new RemoteEngine('gpt', { fetch }).classify(TASK, labeled, { signal: cancel.signal })
    cancel.abort()
    const r2: ClassifyResult = await p2
    expect(r2.status).toBe('error')
    expect(r2.errorMessage).toContain('cancelada')

    const before = fetch.mock.calls.length
    const r3 = await new RemoteEngine('gpt', { fetch }).classify(TASK, labeled, { signal: AbortSignal.abort() })
    expect(r3.status).toBe('error')
    expect(fetch.mock.calls.length).toBe(before)
  })
})
