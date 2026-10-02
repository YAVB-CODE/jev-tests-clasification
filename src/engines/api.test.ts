import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HealthResponse, ModelsResponse } from '../shared/contracts.ts'
import { fetchHealth, fetchModels } from './api.ts'
import type { FetchLike } from './http.ts'

const HEALTH: HealthResponse = {
  ok: true,
  engines: {
    gpt: { live: true, model: 'gpt-4.1-mini', provider: 'OpenAI' },
    jev: { live: false, model: 'jev-1.13', provider: 'OpenCode Zen' },
  },
  warnings: ['Falta JEV_API_KEY'],
}

const MODELS: ModelsResponse = {
  gpt: { default: 'gpt-4.1-mini', models: [{ id: 'gpt-4.1-mini' }, { id: 'gpt-5-mini', reasoning: true }], source: 'provider' },
  jev: { default: 'jev-1.13', models: [{ id: 'jev-1.13' }], source: 'fallback' },
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

afterEach(() => {
  vi.useRealTimers()
})

describe('fetchHealth', () => {
  it('returns the server health', async () => {
    const fetch = vi.fn<FetchLike>(async () => json(HEALTH))
    expect(await fetchHealth({ fetch })).toEqual(HEALTH)
    expect(fetch.mock.calls[0][0]).toBe('/api/health')
  })

  it('falls back to an offline health (never throws)', async () => {
    const down = vi.fn<FetchLike>(async () => {
      throw new TypeError('Failed to fetch')
    })
    const offline = await fetchHealth({ fetch: down })
    expect(offline.ok).toBe(false)
    expect(offline.engines.gpt.live).toBe(false)
    expect(offline.engines.jev.live).toBe(false)
    expect(offline.warnings[0]).toContain('simulado')

    expect((await fetchHealth({ fetch: async () => json({ error: 'x' }, 500) })).ok).toBe(false)
    expect((await fetchHealth({ fetch: async () => json({ nope: true }) })).ok).toBe(false)
  })

  it('times out', async () => {
    vi.useFakeTimers()
    const hanging: FetchLike = (_url, init) =>
      new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('a', 'AbortError'))))
    const p = fetchHealth({ fetch: hanging, timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    const health = await p
    expect(health.ok).toBe(false)
    expect(health.warnings[0]).toContain('no respondió')
  })
})

describe('fetchModels', () => {
  it('uses ?refresh=1 when forced and returns the models', async () => {
    const fetch = vi.fn<FetchLike>(async () => json(MODELS))
    expect(await fetchModels(false, { fetch })).toEqual({ ok: true, models: MODELS })
    expect(await fetchModels(true, { fetch })).toEqual({ ok: true, models: MODELS })
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(['/api/models', '/api/models?refresh=1'])
  })

  it('returns an error instead of throwing', async () => {
    const r1 = await fetchModels(false, { fetch: async () => json({ error: 'sin key' }, 503) })
    expect(r1).toEqual({ ok: false, error: expect.stringContaining('HTTP 503') })
    const r2 = await fetchModels(false, { fetch: async () => json({ gpt: {} }) })
    expect(r2.ok).toBe(false)
    const r3 = await fetchModels(false, {
      fetch: async () => {
        throw new TypeError('Failed to fetch')
      },
    })
    expect(r3).toEqual({ ok: false, error: expect.stringContaining('No se pudo conectar') })
  })
})
