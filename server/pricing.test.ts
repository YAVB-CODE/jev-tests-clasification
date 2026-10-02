import { describe, expect, it } from 'vitest'
import { loadConfig } from './env.ts'
import { gptPriceFor, jevPriceFor } from './models.ts'
import { costUsd } from './pricing.ts'

describe('costUsd', () => {
  it('prices GPT input and output separately', () => {
    const prices = { inputPerMTok: 0.4, outputPerMTok: 1.6 }
    // 1000 × 0.40/1e6 + 50 × 1.60/1e6 = 0.0004 + 0.00008
    expect(costUsd({ inputTokens: 1000, outputTokens: 50 }, prices)).toBeCloseTo(0.00048, 12)
  })

  it('charges Jev input only (output is free)', () => {
    const prices = jevPriceFor('jev-1.13', { priceInputPerMTok: 0.042 }).prices
    expect(prices.outputPerMTok).toBe(0)
    expect(costUsd({ inputTokens: 392, outputTokens: 65 }, prices)).toBeCloseTo(392 * 0.042e-6, 15)
    expect(costUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, prices)).toBe(0.042)
  })

  it('has no float noise and ignores negative counts', () => {
    const prices = { inputPerMTok: 0.4, outputPerMTok: 1.6 }
    expect(String(costUsd({ inputTokens: 42, outputTokens: 0 }, prices))).toBe('0.0000168')
    expect(costUsd({ inputTokens: -5, outputTokens: 0 }, prices)).toBe(0)
  })

  it('is zero for zero usage or zero prices', () => {
    expect(costUsd({ inputTokens: 0, outputTokens: 0 }, { inputPerMTok: 5, outputPerMTok: 5 })).toBe(0)
    expect(costUsd({ inputTokens: 999, outputTokens: 999 }, { inputPerMTok: 0, outputPerMTok: 0 })).toBe(0)
  })

  it('builds prices from the loaded config', () => {
    const cfg = loadConfig({})
    expect(gptPriceFor(cfg.gpt.model, cfg.gpt)?.prices).toEqual({ inputPerMTok: 0.4, outputPerMTok: 1.6 })
    expect(jevPriceFor('jev-1.13', cfg.jev).prices).toEqual({ inputPerMTok: 0.042, outputPerMTok: 0 })
  })
})
