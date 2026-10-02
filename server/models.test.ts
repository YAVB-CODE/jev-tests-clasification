import { describe, expect, it } from 'vitest'
import type { EngineModels } from '../src/shared/contracts.ts'
import { loadConfig } from './env.ts'
import {
  GPT_FALLBACK_MODELS,
  MODEL_LIST_TTL_MS,
  cachedListing,
  gptFallbackModels,
  gptPriceFor,
  isChatGptModel,
  isJevModel,
  isReasoningModel,
  jevFallbackModels,
  jevPriceFor,
  orderModelIds,
  parseModelIds,
  toModelOption,
} from './models.ts'

/** A slice of a real OpenAI /v1/models listing. */
const OPENAI_IDS = [
  'gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14', 'gpt-4o', 'gpt-4o-mini-tts', 'gpt-4o-transcribe', 'gpt-5', 'gpt-5-mini',
  'gpt-5-codex', 'gpt-5-pro', 'gpt-5-chat-latest', 'gpt-5.4-nano', 'gpt-6-sol', 'gpt-image-1', 'gpt-realtime',
  'gpt-audio', 'gpt-3.5-turbo', 'o3', 'o3-deep-research', 'o4-mini', 'text-embedding-3-small', 'whisper-1', 'tts-1',
  'omni-moderation-latest', 'davinci-002', 'gpt-4o-search-preview',
]

describe('isChatGptModel', () => {
  it('keeps chat models with Structured Outputs and drops the rest', () => {
    expect(OPENAI_IDS.filter(isChatGptModel)).toEqual(['gpt-4.1-mini', 'gpt-4o', 'gpt-5', 'gpt-5-mini', 'gpt-5.4-nano', 'gpt-6-sol', 'o3', 'o4-mini'])
  })
})

describe('isReasoningModel', () => {
  it('detects gpt-5*, gpt-6* and the o-series', () => {
    for (const id of ['gpt-5', 'gpt-5-mini', 'gpt-5.4-nano', 'gpt-6-sol', 'o1', 'o3', 'o3-mini', 'o4-mini', 'openai/o3', 'GPT-5']) {
      expect(isReasoningModel(id), id).toBe(true)
    }
  })

  it('leaves chat models and Jev out', () => {
    for (const id of ['gpt-4.1-mini', 'gpt-4o', 'gpt-4.1-nano', 'gpt-5-chat-latest', 'jev-1.13', 'omni-moderation-latest']) {
      expect(isReasoningModel(id), id).toBe(false)
    }
  })
})

describe('isJevModel', () => {
  it('keeps only jev* ids', () => {
    expect(['claude-opus-5-5', 'jev-1.13', 'jev-1.13-free', 'gpt-5'].filter(isJevModel)).toEqual(['jev-1.13', 'jev-1.13-free'])
  })
})

describe('orderModelIds', () => {
  it('puts the default first, dedupes and sorts naturally', () => {
    expect(orderModelIds(['gpt-5.4', 'gpt-4.1', 'gpt-5', 'gpt-4.1'], 'gpt-5')).toEqual(['gpt-5', 'gpt-4.1', 'gpt-5.4'])
    expect(orderModelIds(['jev-1.13'], 'jev-1.13-free')).toEqual(['jev-1.13-free', 'jev-1.13'])
  })

  it('keeps an unlisted default at the front', () => {
    expect(orderModelIds(['b', 'a'], 'zzz')).toEqual(['zzz', 'a', 'b'])
  })
})

describe('prices', () => {
  const gpt = loadConfig({}).gpt

  it('uses .env prices only for OPENAI_MODEL when both are set', () => {
    const fromEnv = { ...gpt, model: 'gpt-4.1-mini', priceInputPerMTok: 9, priceOutputPerMTok: 9, pricesFromEnv: true }
    expect(gptPriceFor('gpt-4.1-mini', fromEnv)).toEqual({ prices: { inputPerMTok: 9, outputPerMTok: 9 }, source: 'env' })
    expect(gptPriceFor('gpt-4o', fromEnv)).toEqual({ prices: { inputPerMTok: 2.5, outputPerMTok: 10 }, source: 'table' })
  })

  it('maps dated snapshots to the table and leaves unknown models unpriced', () => {
    expect(gptPriceFor('gpt-4.1-mini-2025-04-14', gpt)?.prices).toEqual({ inputPerMTok: 0.4, outputPerMTok: 1.6 })
    expect(gptPriceFor('gpt-6-sol', gpt)).toBeUndefined()
  })

  it('prices Jev free models at 0 and paid ones at the configured rate (output free)', () => {
    const jev = loadConfig({}).jev
    expect(jevPriceFor('jev-1.13-free', jev)).toEqual({ prices: { inputPerMTok: 0, outputPerMTok: 0 }, source: 'free' })
    expect(jevPriceFor('jev-1.13', jev)).toEqual({ prices: { inputPerMTok: 0.042, outputPerMTok: 0 }, source: 'env' })
    expect(jevPriceFor('jev-1.13', { priceInputPerMTok: 0.05 }).prices.inputPerMTok).toBe(0.05)
  })
})

describe('toModelOption', () => {
  it('maps prices to the ModelOption contract', () => {
    expect(toModelOption('m', { prices: { inputPerMTok: 1, outputPerMTok: 2 }, source: 'table' }, true)).toEqual({
      id: 'm',
      inputPerMTok: 1,
      outputPerMTok: 2,
      priceSource: 'table',
      reasoning: true,
    })
  })

  it('omits price and reasoning when unknown', () => {
    expect(toModelOption('m', undefined)).toEqual({ id: 'm' })
    expect(toModelOption('m', undefined, false)).toEqual({ id: 'm' })
  })
})

describe('parseModelIds', () => {
  it('reads OpenAI-style listings (OpenAI and OpenCode Zen)', () => {
    expect(parseModelIds({ object: 'list', data: [{ id: 'jev-1.13' }, { id: 'gpt-5' }] })).toEqual(['jev-1.13', 'gpt-5'])
    expect(parseModelIds({ data: [{ name: 'no-id' }, null, { id: '' }] })).toEqual([])
    expect(parseModelIds('nope')).toEqual([])
    expect(parseModelIds(null)).toEqual([])
    expect(parseModelIds({ data: 'x' })).toEqual([])
  })
})

describe('fallback listings', () => {
  it('builds the GPT fallback with the default first, prices and reasoning flags', () => {
    const list = gptFallbackModels(loadConfig({}).gpt)
    expect(list).toMatchObject({ default: 'gpt-4.1-mini', provider: 'OpenAI', source: 'fallback' })
    expect(list.error).toBeUndefined()
    expect(list.models[0]?.id).toBe('gpt-4.1-mini')
    expect(list.models.map((m) => m.id).sort()).toEqual([...GPT_FALLBACK_MODELS].sort())
    expect(list.models.find((m) => m.id === 'gpt-5')).toMatchObject({ reasoning: true, inputPerMTok: 1.25, outputPerMTok: 10, priceSource: 'table' })
    expect(list.models.find((m) => m.id === 'gpt-4o')?.reasoning).toBeUndefined()
  })

  it('puts an OPENAI_MODEL missing from the table first, without price', () => {
    const list = gptFallbackModels({ ...loadConfig({}).gpt, model: 'gpt-6-sol' }, 'boom')
    expect(list.default).toBe('gpt-6-sol')
    expect(list.models[0]).toEqual({ id: 'gpt-6-sol', reasoning: true })
    expect(list.error).toBe('boom')
  })

  it('builds the Jev fallback with free and paid models', () => {
    const list = jevFallbackModels(loadConfig({}).jev)
    expect(list).toMatchObject({ default: 'jev-1.13-free', provider: 'OpenCode Zen', source: 'fallback' })
    expect(list.models).toEqual([
      { id: 'jev-1.13-free', inputPerMTok: 0, outputPerMTok: 0, priceSource: 'free' },
      { id: 'jev-1.13', inputPerMTok: 0.042, outputPerMTok: 0, priceSource: 'env' },
    ])
  })
})

describe('cachedListing', () => {
  it('reuses the result within the TTL unless forced', async () => {
    let t = 0
    let loads = 0
    const list = cachedListing(async () => ({ default: 'm', models: [{ id: `m${++loads}` }], source: 'provider' }) as EngineModels, () => t)
    await list()
    await list()
    expect(loads).toBe(1)
    await list(true)
    expect(loads).toBe(2)
    t += MODEL_LIST_TTL_MS + 1
    await list()
    expect(loads).toBe(3)
  })

  it('has a 10 minute TTL', () => {
    expect(MODEL_LIST_TTL_MS).toBe(600_000)
  })
})
