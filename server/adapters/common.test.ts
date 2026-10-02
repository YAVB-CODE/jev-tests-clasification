import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttemptLog } from '../../src/shared/contracts.ts'
import {
  NULL_ANSWER,
  RETRY_AFTER_MAX_MS,
  RETRY_BACKOFF_INITIAL_MS,
  RETRY_BACKOFF_MAX_MS,
  RETRY_HTTP_STATUSES,
  clamp01,
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
  type FetchLike,
} from './common.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('redactSecrets', () => {
  it('removes the configured secrets wherever they appear', () => {
    const out = redactSecrets('fail with key zen-secret-key and again zen-secret-key', ['zen-secret-key', undefined])
    expect(out).not.toContain('zen-secret-key')
    expect(out).toBe('fail with key *** and again ***')
  })

  it('removes key-looking tokens even when not configured', () => {
    expect(redactSecrets('Incorrect API key provided: sk-proj-abcdef123456 (check it)')).toBe('Incorrect API key provided: sk-*** (check it)')
    expect(redactSecrets('Authorization: Bearer abc.def-123')).not.toContain('abc.def-123')
    expect(redactSecrets('{"api_key":"hunter2hunter2"}')).not.toContain('hunter2')
    expect(redactSecrets('apiKey=hunter2hunter2 next')).toBe('apiKey=*** next')
  })

  it('ignores secrets shorter than 4 chars and truncates long text', () => {
    expect(redactSecrets('abc abc', ['abc'])).toBe('abc abc')
    const long = redactSecrets('x'.repeat(1000))
    expect(long.length).toBe(401)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('publicEndpoint', () => {
  it('keeps plain URLs as they are and drops credentials / query strings', () => {
    expect(publicEndpoint('https://api.openai.com/v1/chat/completions')).toBe('https://api.openai.com/v1/chat/completions')
    expect(publicEndpoint('https://user:s3cret@proxy.example/v1/chat/completions?api-key=abc123')).toBe('https://proxy.example/v1/chat/completions')
    expect(publicEndpoint('not a url api_key=abc12345')).not.toContain('abc12345')
  })
})

describe('instrumentFetch', () => {
  it('logs every attempt with its status and a 1-based attempt number', async () => {
    const log: AttemptLog[] = []
    const responses = [new Response('slow down', { status: 429 }), new Response('{}', { status: 200 })]
    const base: FetchLike = async () => responses.shift() as Response
    const fetch = instrumentFetch(base, log)
    await fetch('http://x')
    await fetch('http://x')
    expect(log.map((a) => [a.attempt, a.status])).toEqual([[1, 429], [2, 200]])
    expect(log.every((a) => Number.isInteger(a.ms) && a.ms >= 0 && a.error === undefined)).toBe(true)
  })

  it('logs network failures with status null and rethrows', async () => {
    const log: AttemptLog[] = []
    const fetch = instrumentFetch(async () => {
      throw new Error('ECONNRESET')
    }, log)
    await expect(fetch('http://x')).rejects.toThrow('ECONNRESET')
    expect(log).toEqual([{ attempt: 1, status: null, ms: expect.any(Number), error: 'ECONNRESET' }])
  })

  it('labels aborted attempts', async () => {
    const log: AttemptLog[] = []
    const controller = new AbortController()
    controller.abort()
    const fetch = instrumentFetch(async () => {
      throw new DOMException('This operation was aborted', 'AbortError')
    }, log)
    await expect(fetch('http://x', { signal: controller.signal })).rejects.toThrow()
    expect(log[0]).toMatchObject({ attempt: 1, status: null, error: 'aborted' })
  })

  it('numbers attempts after those already in the log', async () => {
    const log: AttemptLog[] = [{ attempt: 1, status: 500, ms: 3 }]
    await instrumentFetch(async () => new Response('ok'), log)('http://x')
    expect(log[1]?.attempt).toBe(2)
  })
})

describe('retry policy', () => {
  it('retries the same statuses for both engines', () => {
    expect([...RETRY_HTTP_STATUSES].sort((a, b) => a - b)).toEqual([408, 429, 500, 502, 503, 504, 529])
    for (const status of [408, 429, 500, 502, 503, 504, 529]) expect(isRetryableStatus(status)).toBe(true)
    for (const status of [200, 400, 401, 403, 404, 422]) expect(isRetryableStatus(status)).toBe(false)
  })

  it('honours Retry-After-ms and Retry-After (seconds) up to 2 s', () => {
    expect(retryDelayMs(new Response(null, { headers: { 'retry-after-ms': '350' } }), 1)).toBe(350)
    expect(retryDelayMs(new Response(null, { headers: { 'retry-after': '1' } }), 1)).toBe(1000)
    expect(retryDelayMs(new Response(null, { headers: { 'retry-after': '0' } }), 1)).toBe(0)
    expect(retryDelayMs(new Response(null, { headers: { 'retry-after': '2' } }), 1)).toBe(RETRY_AFTER_MAX_MS)
  })

  it('prefers Retry-After-ms over Retry-After', () => {
    expect(retryDelayMs(new Response(null, { headers: { 'retry-after-ms': '100', 'retry-after': '1' } }), 1)).toBe(100)
  })

  it('falls back to backoff when Retry-After is too long or invalid', () => {
    const mid = () => 0.5 // jitter factor 1.0
    expect(retryDelayMs(new Response(null, { headers: { 'retry-after': '30' } }), 1, mid)).toBe(RETRY_BACKOFF_INITIAL_MS)
    expect(retryDelayMs(new Response(null, { headers: { 'retry-after-ms': '5000' } }), 1, mid)).toBe(RETRY_BACKOFF_INITIAL_MS)
    expect(retryDelayMs(new Response(null, { headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } }), 1, mid)).toBe(RETRY_BACKOFF_INITIAL_MS)
    expect(retryDelayMs(new Response(null, { headers: { 'retry-after': '-1' } }), 1, mid)).toBe(RETRY_BACKOFF_INITIAL_MS)
  })

  it('does not treat a missing header as "retry immediately"', () => {
    expect(retryDelayMs(new Response(null, { status: 429 }), 1, () => 0.5)).toBe(RETRY_BACKOFF_INITIAL_MS)
  })

  it('backs off exponentially from 200 ms and caps at 1 s (no response = network failure)', () => {
    const mid = () => 0.5
    expect([1, 2, 3, 4, 5].map((retry) => retryDelayMs(null, retry, mid))).toEqual([200, 400, 800, 1000, 1000])
    expect(retryDelayMs(null, 0, mid)).toBe(200)
  })

  it('applies ±25% jitter', () => {
    expect(retryDelayMs(null, 1, () => 0)).toBe(RETRY_BACKOFF_INITIAL_MS * 0.75)
    expect(retryDelayMs(null, 1, () => 1)).toBe(RETRY_BACKOFF_INITIAL_MS * 1.25)
    for (let i = 0; i < 50; i++) {
      const delay = retryDelayMs(null, 9)
      expect(delay).toBeGreaterThanOrEqual(RETRY_BACKOFF_MAX_MS * 0.75)
      expect(delay).toBeLessThanOrEqual(RETRY_BACKOFF_MAX_MS * 1.25)
    }
  })
})

describe('sleep', () => {
  it('resolves after the delay', async () => {
    vi.useFakeTimers()
    let done = false
    const pending = sleep(500).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(499)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(done).toBe(true)
  })

  it('rejects immediately when already aborted, and as soon as the signal aborts', async () => {
    const controller = new AbortController()
    controller.abort(new Error('gone'))
    await expect(sleep(10_000, controller.signal)).rejects.toThrow('gone')

    const later = new AbortController()
    const pending = sleep(10_000, later.signal)
    later.abort(new Error('closed'))
    await expect(pending).rejects.toThrow('closed')
  })
})

describe('result helpers', () => {
  it('freezes NULL_ANSWER and never shares it with results', () => {
    expect(NULL_ANSWER).toEqual({ categoryId: null })
    expect(Object.isFrozen(NULL_ANSWER)).toBe(true)
    const result = errorResult('gpt', 'm', 'boom')
    expect(result.answer).toEqual({ categoryId: null })
    expect(result.answer).not.toBe(NULL_ANSWER)
    expect(Object.isFrozen(result.answer)).toBe(false)
  })

  it('errorResult builds a live error result and lets `extra` add detail', () => {
    expect(errorResult('jev', 'jev-1.13', 'HTTP 500')).toEqual({
      engine: 'jev',
      mode: 'live',
      model: 'jev-1.13',
      status: 'error',
      answer: { categoryId: null },
      errorMessage: 'HTTP 500',
    })
    const attempts = [{ attempt: 1, status: 500, ms: 12 }]
    expect(errorResult('jev', 'm', 'x', { attempts, providerLatencyMs: 12 })).toMatchObject({ attempts, providerLatencyMs: 12, status: 'error' })
  })

  it('timeoutResult has status timeout and a Spanish message with the limit', () => {
    const result = timeoutResult('gpt', 'gpt-4.1-mini', 30_000, { providerLatencyMs: 30_001 })
    expect(result).toMatchObject({ engine: 'gpt', mode: 'live', model: 'gpt-4.1-mini', status: 'timeout', answer: { categoryId: null }, providerLatencyMs: 30_001 })
    expect(result.errorMessage).toContain('30000 ms')
    expect(result.errorMessage).toMatch(/Tiempo agotado/)
  })

  it('missingKeyResult names the env var in Spanish', () => {
    const result = missingKeyResult('gpt', 'gpt-4.1-mini', 'OPENAI_API_KEY')
    expect(result.status).toBe('error')
    expect(result.errorMessage).toContain('OPENAI_API_KEY')
    expect(result.errorMessage).toMatch(/no está configurada/)
    expect(result.errorMessage).toMatch(/SIMULADO/)
  })
})

describe('small helpers', () => {
  it('clamp01 clamps and rejects non-numbers', () => {
    expect([clamp01(-1), clamp01(0.4), clamp01(7)]).toEqual([0, 0.4, 1])
    expect(clamp01('0.5')).toBeUndefined()
    expect(clamp01(Number.NaN)).toBeUndefined()
    expect(clamp01(undefined)).toBeUndefined()
  })

  it('roundMs rounds to whole milliseconds', () => {
    expect(roundMs(12.4)).toBe(12)
    expect(roundMs(12.5)).toBe(13)
  })

  it('withoutStatusPrefix drops the SDK status prefix only when it matches', () => {
    expect(withoutStatusPrefix('429 Rate limit reached', 429)).toBe('Rate limit reached')
    expect(withoutStatusPrefix('429 Rate limit reached', 500)).toBe('429 Rate limit reached')
    expect(withoutStatusPrefix('plain', undefined)).toBe('plain')
  })

  it('errorMessageOf handles errors, strings and unknowns', () => {
    expect(errorMessageOf(new Error('x'))).toBe('x')
    expect(errorMessageOf('y')).toBe('y')
    expect(errorMessageOf(42)).toBe('Error desconocido')
  })

  it('toJsonValue is a JSON round trip', () => {
    expect(toJsonValue({ a: 1, b: undefined, c: [undefined, 2] })).toEqual({ a: 1, c: [null, 2] })
  })
})
