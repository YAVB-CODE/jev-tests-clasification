/**
 * Typed server configuration, read from process.env (loaded from `.env` by server/index.ts).
 * Variable names match .env.example. Read lazily (call `loadConfig()`), never at import time,
 * so tests can pass their own env and the dotenv load order does not matter.
 *
 * Fairness: timeout and retries are NOT per-engine settings. `CLASSIFY_TIMEOUT_MS` (per HTTP
 * attempt) and `CLASSIFY_MAX_RETRIES` fill both `gpt.*` and `jev.*`, so both lanes run under the
 * same rules (see the shared retry policy in adapters/common.ts).
 */

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningEffortSetting = (typeof REASONING_EFFORTS)[number]

/** Gateway label shown in the UI for the GPT lane. */
export const OPENAI_LABEL = 'OpenAI'

export interface GptConfig {
  /** OPENAI_API_KEY — undefined when blank. Never log or echo it. */
  apiKey: string | undefined
  /** OPENAI_MODEL (default gpt-4.1-mini). */
  model: string
  /** OPENAI_BASE_URL (optional; SDK default otherwise). */
  baseURL: string | undefined
  /** OPENAI_PRICE_INPUT_PER_MTOK / OPENAI_PRICE_OUTPUT_PER_MTOK (USD per million tokens; defaults match gpt-4.1-mini). */
  priceInputPerMTok: number
  priceOutputPerMTok: number
  /** true when both OPENAI_PRICE_* are set in the env: they then apply to OPENAI_MODEL (other models use server/models.ts). */
  pricesFromEnv: boolean
  /** OPENAI_REASONING_EFFORT — only sent to reasoning models (gpt-5*, o-series). */
  reasoningEffort: ReasoningEffortSetting | undefined
  /** OPENAI_MAX_COMPLETION_TOKENS — default depends on the model family (see adapters/gpt.ts). */
  maxCompletionTokens: number | undefined
  /** CLASSIFY_TIMEOUT_MS — per HTTP attempt, identical for both engines (default 30000). */
  timeoutMs: number
  /** CLASSIFY_MAX_RETRIES — identical for both engines (default 1). Never retried after our own timeout. */
  maxRetries: number
}

/** Jev is served only through OpenCode Zen (https://opencode.ai/docs/zen): `POST {base}/v1/systemone`. */
export const OPENCODE_LABEL = 'OpenCode Zen'
export const OPENCODE_DEFAULT_BASE_URL = 'https://opencode.ai/zen'

/** Jev model ids listed by OpenCode Zen. */
export const OPENCODE_JEV_MODELS: readonly string[] = ['jev-1.13', 'jev-1.13-free']

export interface JevConfig {
  /** OPENCODE_API_KEY — undefined when blank. Never log or echo it. */
  apiKey: string | undefined
  /** JEV_MODEL (default jev-1.13-free). */
  model: string
  /** OPENCODE_BASE_URL (default https://opencode.ai/zen). */
  baseURL: string
  /** JEV_PRICE_INPUT_PER_MTOK for paid models (default 0.042). `*-free` models always cost 0. Output tokens are free. */
  priceInputPerMTok: number
  /** CLASSIFY_TIMEOUT_MS — same value as `gpt.timeoutMs`. */
  timeoutMs: number
  /** CLASSIFY_MAX_RETRIES — same value as `gpt.maxRetries`. */
  maxRetries: number
}

export interface ServerConfig {
  port: number
  /**
   * HOST — interface the API listens on (default 127.0.0.1: this machine only). The API spends the
   * user's paid API keys, so exposing it (0.0.0.0, a LAN IP) is an explicit opt-in. Read at listen
   * time: changing it needs a restart (like PORT).
   */
  host: string
  gpt: GptConfig
  jev: JevConfig
}

type Env = Record<string, string | undefined>

function str(env: Env, name: string): string | undefined {
  const value = env[name]?.trim()
  return value ? value : undefined
}

function num(env: Env, name: string, fallback: number, { min = 0, max = Infinity, integer = false } = {}): number {
  const raw = str(env, name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) return fallback
  return value
}

function optionalInt(env: Env, name: string, min: number): number | undefined {
  const raw = str(env, name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value >= min ? value : undefined
}

function reasoningEffort(env: Env): ReasoningEffortSetting | undefined {
  const raw = str(env, 'OPENAI_REASONING_EFFORT')?.toLowerCase()
  return (REASONING_EFFORTS as readonly string[]).includes(raw ?? '') ? (raw as ReasoningEffortSetting) : undefined
}

export const DEFAULTS = {
  PORT: 8788,
  /** Loopback only: nobody else on the network can spend the keys through the API. */
  HOST: '127.0.0.1',
  OPENAI_MODEL: 'gpt-4.1-mini',
  OPENAI_PRICE_INPUT_PER_MTOK: 0.4,
  OPENAI_PRICE_OUTPUT_PER_MTOK: 1.6,
  JEV_MODEL: 'jev-1.13-free',
  JEV_PRICE_INPUT_PER_MTOK: 0.042,
  /** Per HTTP attempt, both engines. */
  CLASSIFY_TIMEOUT_MS: 30_000,
  /** Both engines. */
  CLASSIFY_MAX_RETRIES: 1,
} as const

export function loadConfig(env: Env = process.env): ServerConfig {
  // Fairness: one timeout and one retry budget, copied to both engines.
  const timeoutMs = num(env, 'CLASSIFY_TIMEOUT_MS', DEFAULTS.CLASSIFY_TIMEOUT_MS, { min: 1, integer: true })
  const maxRetries = num(env, 'CLASSIFY_MAX_RETRIES', DEFAULTS.CLASSIFY_MAX_RETRIES, { integer: true })
  return {
    port: num(env, 'PORT', DEFAULTS.PORT, { max: 65_535, integer: true }),
    host: str(env, 'HOST') ?? DEFAULTS.HOST,
    gpt: {
      apiKey: str(env, 'OPENAI_API_KEY'),
      model: str(env, 'OPENAI_MODEL') ?? DEFAULTS.OPENAI_MODEL,
      baseURL: str(env, 'OPENAI_BASE_URL'),
      priceInputPerMTok: num(env, 'OPENAI_PRICE_INPUT_PER_MTOK', DEFAULTS.OPENAI_PRICE_INPUT_PER_MTOK),
      priceOutputPerMTok: num(env, 'OPENAI_PRICE_OUTPUT_PER_MTOK', DEFAULTS.OPENAI_PRICE_OUTPUT_PER_MTOK),
      pricesFromEnv: str(env, 'OPENAI_PRICE_INPUT_PER_MTOK') !== undefined && str(env, 'OPENAI_PRICE_OUTPUT_PER_MTOK') !== undefined,
      reasoningEffort: reasoningEffort(env),
      maxCompletionTokens: optionalInt(env, 'OPENAI_MAX_COMPLETION_TOKENS', 16),
      timeoutMs,
      maxRetries,
    },
    jev: {
      apiKey: str(env, 'OPENCODE_API_KEY'),
      model: str(env, 'JEV_MODEL') ?? DEFAULTS.JEV_MODEL,
      baseURL: (str(env, 'OPENCODE_BASE_URL') ?? OPENCODE_DEFAULT_BASE_URL).replace(/\/+$/, ''),
      priceInputPerMTok: num(env, 'JEV_PRICE_INPUT_PER_MTOK', DEFAULTS.JEV_PRICE_INPUT_PER_MTOK),
      timeoutMs,
      maxRetries,
    },
  }
}

/** Hostnames that only reach this machine (Host header / listen address). */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** true when `host` (a listen address or a Host-header hostname) is loopback-only: localhost, 127.x.x.x, ::1. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  return LOOPBACK_HOSTNAMES.has(h) || h.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(h)
}

/** Human-readable startup warnings (Spanish) for configurations that will likely fail. Never includes secrets. */
export function configWarnings(cfg: ServerConfig): string[] {
  const warnings: string[] = []
  if (!cfg.gpt.apiKey) {
    warnings.push('Falta OPENAI_API_KEY: GPT solo estará disponible en modo simulado.')
  }
  if (!cfg.jev.apiKey) {
    warnings.push('Falta OPENCODE_API_KEY: Jev solo estará disponible en modo simulado.')
  }
  if (!isLoopbackHost(cfg.host)) {
    warnings.push(
      `HOST=${cfg.host}: el API (que usa tus API keys de pago) acepta conexiones de otros equipos de la red. Usa HOST=127.0.0.1 salvo que lo necesites.`,
    )
  }
  if (!OPENCODE_JEV_MODELS.includes(cfg.jev.model)) {
    warnings.push(
      `JEV_MODEL=${cfg.jev.model} no aparece en OpenCode Zen (usa ${OPENCODE_JEV_MODELS.join(' o ')}, o borra JEV_MODEL para usar ${DEFAULTS.JEV_MODEL}).`,
    )
  }
  return warnings
}
