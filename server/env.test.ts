import { describe, expect, it } from 'vitest'
import { DEFAULTS, OPENCODE_DEFAULT_BASE_URL, OPENCODE_JEV_MODELS, configWarnings, isLoopbackHost, loadConfig } from './env.ts'

describe('loadConfig defaults', () => {
  it('uses the documented defaults when env is empty', () => {
    const cfg = loadConfig({})
    expect(cfg.port).toBe(8788)
    expect(cfg.host).toBe('127.0.0.1')
    expect(cfg.gpt).toEqual({
      apiKey: undefined,
      model: 'gpt-4.1-mini',
      baseURL: undefined,
      priceInputPerMTok: 0.4,
      priceOutputPerMTok: 1.6,
      pricesFromEnv: false,
      reasoningEffort: undefined,
      maxCompletionTokens: undefined,
      timeoutMs: 30_000,
      maxRetries: 1,
    })
    expect(cfg.jev).toEqual({
      apiKey: undefined,
      model: 'jev-1.13-free',
      baseURL: OPENCODE_DEFAULT_BASE_URL,
      priceInputPerMTok: DEFAULTS.JEV_PRICE_INPUT_PER_MTOK,
      timeoutMs: 30_000,
      maxRetries: 1,
    })
  })

  it('does not read process.env at import time and defaults to it only when called', () => {
    const before = process.env.PORT
    process.env.PORT = '9123'
    try {
      expect(loadConfig().port).toBe(9123)
    } finally {
      if (before === undefined) delete process.env.PORT
      else process.env.PORT = before
    }
  })
})

describe('loadConfig parsing', () => {
  it('reads GPT values and ignores blank or invalid ones', () => {
    const cfg = loadConfig({
      PORT: '9000',
      OPENAI_API_KEY: '  sk-test  ',
      OPENAI_MODEL: 'gpt-5-mini',
      OPENAI_BASE_URL: 'http://localhost:1234/v1',
      OPENAI_PRICE_INPUT_PER_MTOK: '0.25',
      OPENAI_PRICE_OUTPUT_PER_MTOK: 'abc',
      OPENAI_REASONING_EFFORT: 'LOW',
      OPENAI_MAX_COMPLETION_TOKENS: '2000',
    })
    expect(cfg.port).toBe(9000)
    expect(cfg.gpt).toMatchObject({
      apiKey: 'sk-test',
      model: 'gpt-5-mini',
      baseURL: 'http://localhost:1234/v1',
      priceInputPerMTok: 0.25,
      priceOutputPerMTok: 1.6,
      pricesFromEnv: true,
      reasoningEffort: 'low',
      maxCompletionTokens: 2000,
    })
  })

  it('rejects invalid reasoning effort, tiny token budgets and bad ports', () => {
    expect(loadConfig({ OPENAI_REASONING_EFFORT: 'turbo' }).gpt.reasoningEffort).toBeUndefined()
    expect(loadConfig({ OPENAI_MAX_COMPLETION_TOKENS: '3' }).gpt.maxCompletionTokens).toBeUndefined()
    expect(loadConfig({ PORT: 'abc' }).port).toBe(8788)
    expect(loadConfig({ PORT: '70000' }).port).toBe(8788)
    expect(loadConfig({ PORT: '80.5' }).port).toBe(8788)
  })

  it('knows whether GPT prices come from the env (both must be set)', () => {
    expect(loadConfig({}).gpt.pricesFromEnv).toBe(false)
    expect(loadConfig({ OPENAI_PRICE_INPUT_PER_MTOK: '1' }).gpt.pricesFromEnv).toBe(false)
    expect(loadConfig({ OPENAI_PRICE_INPUT_PER_MTOK: '1', OPENAI_PRICE_OUTPUT_PER_MTOK: '2' }).gpt.pricesFromEnv).toBe(true)
  })

  it('reads OPENCODE_API_KEY with Zen defaults', () => {
    const { jev } = loadConfig({ OPENCODE_API_KEY: 'zen-key' })
    expect(jev).toMatchObject({ apiKey: 'zen-key', model: 'jev-1.13-free', baseURL: 'https://opencode.ai/zen', priceInputPerMTok: 0.042 })
  })

  it('honours JEV_MODEL, JEV_PRICE_INPUT_PER_MTOK and OPENCODE_BASE_URL (trailing slashes trimmed)', () => {
    const { jev } = loadConfig({
      OPENCODE_API_KEY: 'k',
      JEV_MODEL: 'jev-1.13',
      JEV_PRICE_INPUT_PER_MTOK: '0.05',
      OPENCODE_BASE_URL: 'http://localhost:9000/zen//',
    })
    expect(jev).toMatchObject({ model: 'jev-1.13', priceInputPerMTok: 0.05, baseURL: 'http://localhost:9000/zen' })
  })

  it('treats blank keys as missing', () => {
    expect(loadConfig({ OPENCODE_API_KEY: '   ' }).jev.apiKey).toBeUndefined()
    expect(loadConfig({ OPENAI_API_KEY: '' }).gpt.apiKey).toBeUndefined()
  })
})

describe('fairness: shared timeout and retries', () => {
  it('fills both engines from CLASSIFY_TIMEOUT_MS / CLASSIFY_MAX_RETRIES', () => {
    const cfg = loadConfig({ CLASSIFY_TIMEOUT_MS: '12000', CLASSIFY_MAX_RETRIES: '3' })
    expect(cfg.gpt.timeoutMs).toBe(12_000)
    expect(cfg.jev.timeoutMs).toBe(12_000)
    expect(cfg.gpt.maxRetries).toBe(3)
    expect(cfg.jev.maxRetries).toBe(3)
  })

  it('accepts zero retries and falls back to defaults on invalid values', () => {
    expect(loadConfig({ CLASSIFY_MAX_RETRIES: '0' }).jev.maxRetries).toBe(0)
    const bad = loadConfig({ CLASSIFY_TIMEOUT_MS: '-5', CLASSIFY_MAX_RETRIES: '-1' })
    expect([bad.gpt.timeoutMs, bad.jev.timeoutMs]).toEqual([30_000, 30_000])
    expect([bad.gpt.maxRetries, bad.jev.maxRetries]).toEqual([1, 1])
    expect(loadConfig({ CLASSIFY_TIMEOUT_MS: '1.5', CLASSIFY_MAX_RETRIES: 'x' }).gpt).toMatchObject({ timeoutMs: 30_000, maxRetries: 1 })
  })

  it('ignores the removed per-engine variables', () => {
    const cfg = loadConfig({ OPENAI_TIMEOUT_MS: '1000', JEV_TIMEOUT_MS: '2000', OPENAI_MAX_RETRIES: '5', JEV_MAX_RETRIES: '4' })
    expect(cfg.gpt).toMatchObject({ timeoutMs: 30_000, maxRetries: 1 })
    expect(cfg.jev).toMatchObject({ timeoutMs: 30_000, maxRetries: 1 })
  })
})

describe('configWarnings', () => {
  it('flags missing keys in Spanish and says the lane is simulated-only', () => {
    const warnings = configWarnings(loadConfig({}))
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toBe('Falta OPENAI_API_KEY: GPT solo estará disponible en modo simulado.')
    expect(warnings[1]).toBe('Falta OPENCODE_API_KEY: Jev solo estará disponible en modo simulado.')
  })

  it('flags a JEV_MODEL that OpenCode Zen does not list', () => {
    const warnings = configWarnings(loadConfig({ OPENAI_API_KEY: 'sk-x', OPENCODE_API_KEY: 'k', JEV_MODEL: 'jev-9000' }))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('JEV_MODEL=jev-9000')
    for (const id of OPENCODE_JEV_MODELS) expect(warnings[0]).toContain(id)
  })

  it('stays quiet for valid setups', () => {
    const keys = { OPENAI_API_KEY: 'sk-test-key', OPENCODE_API_KEY: 'zen-key' }
    expect(configWarnings(loadConfig(keys))).toEqual([])
    expect(configWarnings(loadConfig({ ...keys, JEV_MODEL: 'jev-1.13' }))).toEqual([])
  })

  it('never includes secrets', () => {
    const secrets = { OPENAI_API_KEY: 'sk-super-secret-123', OPENCODE_API_KEY: 'zen-super-secret-456' }
    const text = configWarnings(loadConfig({ ...secrets, JEV_MODEL: 'jev-9000' })).join('\n')
    expect(text).not.toContain('super-secret')
    // Even the key-less warnings only name the variable.
    expect(configWarnings(loadConfig({})).join('\n')).not.toMatch(/sk-/)
  })
})

describe('HOST (listen address)', () => {
  it('defaults to loopback and accepts an explicit value', () => {
    expect(loadConfig({ HOST: '  ' }).host).toBe('127.0.0.1')
    expect(loadConfig({ HOST: '0.0.0.0' }).host).toBe('0.0.0.0')
    expect(loadConfig({ HOST: '::1' }).host).toBe('::1')
  })

  it('isLoopbackHost: only names / addresses that stay on this machine', () => {
    for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]', 'app.localhost']) expect(isLoopbackHost(h)).toBe(true)
    for (const h of ['0.0.0.0', '::', '192.168.1.10', 'evil.example', 'localhost.evil.example', '127.0.0.1.evil.example', '']) {
      expect(isLoopbackHost(h)).toBe(false)
    }
  })

  it('warns (no secrets) when the API is exposed beyond loopback', () => {
    const exposed = configWarnings(loadConfig({ HOST: '0.0.0.0', OPENAI_API_KEY: 'sk-a', OPENCODE_API_KEY: 'zen-b' }))
    expect(exposed).toHaveLength(1)
    expect(exposed[0]).toContain('HOST=0.0.0.0')
    expect(exposed[0]).not.toContain('sk-a')
    expect(configWarnings(loadConfig({ OPENAI_API_KEY: 'sk-a', OPENCODE_API_KEY: 'zen-b' }))).toEqual([])
  })
})
