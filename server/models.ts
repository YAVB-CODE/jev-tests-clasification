/**
 * Model catalogue for GET /api/models and per-model pricing.
 *
 *  - GPT: OpenAI `GET /v1/models` lists everything the key can see (audio, image, embeddings…). We keep
 *    only chat models that support Structured Outputs on Chat Completions, and drop dated snapshots.
 *  - Jev: OpenCode Zen `GET {base}/v1/models` answers `{ data: [{ id }] }` with every Zen model: we keep
 *    the `jev*` ones (`isJevModel`).
 * When there is no key or the listing fails, a built-in fallback list is served (source: 'fallback').
 * `gptFallbackModels` / `jevFallbackModels` build that list so adapters and stubs share one source.
 */
import type { EngineModels, ModelOption } from '../src/shared/contracts.ts'
import { OPENAI_LABEL, OPENCODE_JEV_MODELS, OPENCODE_LABEL, type GptConfig, type JevConfig } from './env.ts'
import type { TokenPrices } from './pricing.ts'

// ─────────────────────────────────── GPT ───────────────────────────────────

const GPT_INCLUDE = /^(gpt-4o|gpt-4\.1|gpt-5|gpt-6|o1|o3|o4)/
/** Not chat / not Chat-Completions-compatible (codex, *-pro, deep-research are Responses-only), or dated snapshots. */
const GPT_EXCLUDE =
  /(audio|tts|transcribe|realtime|image|search|embedding|moderation|codex|-pro\b|deep-research|live|instruct|chat-latest|\d{4}-\d{2}-\d{2})/

export function isChatGptModel(id: string): boolean {
  return GPT_INCLUDE.test(id) && !GPT_EXCLUDE.test(id)
}

/**
 * Reasoning models (gpt-5*, gpt-6*, o1/o3/o4*; `*-chat*` variants excluded): they take instructions in the
 * `developer` role, reject a custom temperature, accept `reasoning_effort` and spend hidden reasoning tokens.
 */
export function isReasoningModel(id: string): boolean {
  const m = id.trim().toLowerCase().replace(/^openai\//, '')
  const oSeries = /^o\d/.test(m)
  const gpt5 = /^gpt-[56]/.test(m) // gpt-5.x and gpt-6.x share the reasoning-model API surface
  return oSeries || (gpt5 && !/-chat/.test(m))
}

/**
 * OpenAI list prices, USD per million tokens (input, output). Built-in and possibly outdated: models not
 * listed here show no cost unless they are OPENAI_MODEL with OPENAI_PRICE_* set in .env.
 */
export const GPT_PRICE_TABLE: Record<string, readonly [number, number]> = {
  'gpt-4o': [2.5, 10],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4.1': [2, 8],
  'gpt-4.1-mini': [0.4, 1.6],
  'gpt-4.1-nano': [0.1, 0.4],
  'gpt-5': [1.25, 10],
  'gpt-5-mini': [0.25, 2],
  'gpt-5-nano': [0.05, 0.4],
  'gpt-5.1': [1.25, 10],
  o1: [15, 60],
  o3: [2, 8],
  'o3-mini': [1.1, 4.4],
  'o4-mini': [1.1, 4.4],
}

/** Strips a dated snapshot suffix: gpt-4.1-mini-2025-04-14 → gpt-4.1-mini. */
function baseModelId(id: string): string {
  return id.replace(/-\d{4}-\d{2}-\d{2}$/, '')
}

export interface ResolvedPrice {
  prices: TokenPrices
  source: NonNullable<ModelOption['priceSource']>
}

export function gptPriceFor(
  model: string,
  cfg: Pick<GptConfig, 'model' | 'priceInputPerMTok' | 'priceOutputPerMTok' | 'pricesFromEnv'>,
): ResolvedPrice | undefined {
  if (model === cfg.model && cfg.pricesFromEnv) {
    return { prices: { inputPerMTok: cfg.priceInputPerMTok, outputPerMTok: cfg.priceOutputPerMTok }, source: 'env' }
  }
  const row = GPT_PRICE_TABLE[baseModelId(model)]
  return row ? { prices: { inputPerMTok: row[0], outputPerMTok: row[1] }, source: 'table' } : undefined
}

export const GPT_FALLBACK_MODELS: readonly string[] = Object.keys(GPT_PRICE_TABLE)

// ─────────────────────────────────── Jev ───────────────────────────────────

/** Output tokens are free; `*-free` models cost nothing at all. */
export function jevPriceFor(model: string, cfg: Pick<JevConfig, 'priceInputPerMTok'>): ResolvedPrice {
  if (model.endsWith('-free')) return { prices: { inputPerMTok: 0, outputPerMTok: 0 }, source: 'free' }
  return { prices: { inputPerMTok: cfg.priceInputPerMTok, outputPerMTok: 0 }, source: 'env' }
}

/** OpenCode Zen lists every provider's models; Jev ones start with `jev`. */
export function isJevModel(id: string): boolean {
  return /^jev/i.test(id)
}

// ─────────────────────────────────── Shared ───────────────────────────────────

/** Model ids from an OpenAI-style listing `{ data: [{ id }] }` (OpenAI and OpenCode Zen). */
export function parseModelIds(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return []
  const items = (body as { data?: unknown }).data
  if (!Array.isArray(items)) return []
  const ids: string[] = []
  for (const item of items) {
    const id = typeof item === 'object' && item !== null ? (item as { id?: unknown }).id : undefined
    if (typeof id === 'string' && id) ids.push(id)
  }
  return ids
}

/** Unique, default first, then natural order (gpt-4.1 < gpt-5 < gpt-5.4 …). */
export function orderModelIds(ids: Iterable<string>, defaultId: string): string[] {
  const unique = [...new Set([defaultId, ...ids])]
  const rest = unique.filter((id) => id !== defaultId).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  return [defaultId, ...rest]
}

export function toModelOption(id: string, price: ResolvedPrice | undefined, reasoning?: boolean): ModelOption {
  const option: ModelOption = { id }
  if (price) {
    option.inputPerMTok = price.prices.inputPerMTok
    option.outputPerMTok = price.prices.outputPerMTok
    option.priceSource = price.source
  }
  if (reasoning) option.reasoning = true
  return option
}

type GptListingConfig = Pick<GptConfig, 'model' | 'priceInputPerMTok' | 'priceOutputPerMTok' | 'pricesFromEnv'>

/** `ModelOption` for a GPT model id: price (env / table / none) and reasoning flag. */
export function gptModelOption(id: string, cfg: GptListingConfig): ModelOption {
  return toModelOption(id, gptPriceFor(id, cfg), isReasoningModel(id))
}

/** `ModelOption` for a Jev model id. */
export function jevModelOption(id: string, cfg: Pick<JevConfig, 'priceInputPerMTok'>): ModelOption {
  return toModelOption(id, jevPriceFor(id, cfg))
}

/** Built-in GPT list (no key, or the provider listing failed). `error` is shown in the UI: never put secrets in it. */
export function gptFallbackModels(cfg: GptListingConfig, error?: string): EngineModels {
  return {
    default: cfg.model,
    provider: OPENAI_LABEL,
    models: orderModelIds(GPT_FALLBACK_MODELS, cfg.model).map((id) => gptModelOption(id, cfg)),
    source: 'fallback',
    ...(error ? { error } : {}),
  }
}

/** Built-in Jev list (no key, or the provider listing failed). */
export function jevFallbackModels(cfg: Pick<JevConfig, 'model' | 'priceInputPerMTok'>, error?: string): EngineModels {
  return {
    default: cfg.model,
    provider: OPENCODE_LABEL,
    models: orderModelIds(OPENCODE_JEV_MODELS, cfg.model).map((id) => jevModelOption(id, cfg)),
    source: 'fallback',
    ...(error ? { error } : {}),
  }
}

export const MODEL_LIST_TTL_MS = 10 * 60_000

/**
 * Caches a listing for MODEL_LIST_TTL_MS. Adapters are rebuilt when .env changes, so a key / provider
 * change starts a fresh cache. Failed listings are cached too (as fallback) to avoid hammering the API.
 */
export function cachedListing(load: () => Promise<EngineModels>, now: () => number = Date.now) {
  let cached: { at: number; value: Promise<EngineModels> } | null = null
  return (force = false): Promise<EngineModels> => {
    if (!force && cached && now() - cached.at < MODEL_LIST_TTL_MS) return cached.value
    cached = { at: now(), value: load() }
    return cached.value
  }
}
