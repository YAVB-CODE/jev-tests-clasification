/**
 * Shared adapter plumbing: the adapter interface, an instrumented fetch that records every HTTP
 * attempt (so SDK retries never distort latency silently), secret redaction, result helpers and
 * the retry policy that BOTH engines must follow.
 *
 * ── Shared retry policy (fairness: identical for GPT and Jev) ────────────────────────────────
 *  - At most `cfg.maxRetries` retries (CLASSIFY_MAX_RETRIES) after the first attempt; each attempt
 *    is bounded by `cfg.timeoutMs` (CLASSIFY_TIMEOUT_MS).
 *  - Retry only on `RETRY_HTTP_STATUSES` (see `isRetryableStatus`) and on network failures
 *    (connection reset, DNS…) that are NOT an abort.
 *  - NEVER retry after our own timeout (the attempt's timer fired) or after the caller aborted
 *    (`ClassifyOptions.signal`): the result is `timeoutResult` / aborted, with no second chance.
 *  - Wait `retryDelayMs(response, retry)` between attempts: Retry-After(-ms) when ≤ 2 s, otherwise
 *    exponential backoff 200 ms → 1 s with jitter. `sleep` rejects as soon as the signal aborts.
 *  - Every HTTP attempt (including SDK-internal ones) is recorded in `ClassifyResult.attempts`
 *    via `instrumentFetch`, and `providerLatencyMs` covers all attempts including the waits.
 */
import type {
  AttemptLog,
  ClassificationTask,
  ClassifyAnswer,
  ClassifyResult,
  ConceptInput,
  EngineId,
  EngineModels,
} from '../../src/shared/contracts.ts'

export type { AttemptLog }

export interface ClassifyOptions {
  /** Aborted when the browser request closes (runner timeout / race abort). */
  signal?: AbortSignal
  /** Model picked in the UI for this lane; the adapter's configured default when omitted. */
  model?: string
}

export interface EngineAdapter {
  readonly engine: EngineId
  /** true when the API key is configured. */
  readonly live: boolean
  /** Configured default model name (the response may report a more specific versioned id). */
  readonly model: string
  /** Gateway serving the model, for display (e.g. 'OpenAI', 'OpenCode Zen'). */
  readonly provider: string
  /** Never throws: every failure is a ClassifyResult with status 'invalid' | 'error' | 'timeout'. */
  classify(task: ClassificationTask, item: ConceptInput, options?: ClassifyOptions): Promise<ClassifyResult>
  /** Cached; force re-lists. Never throws: falls back to a built-in list. */
  listModels(force?: boolean): Promise<EngineModels>
}

export type Adapters = Record<EngineId, EngineAdapter>

/** Compatible with the global fetch and OpenAI's `Fetch`. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init)

// ─────────────────────────────── Retry policy ───────────────────────────────

/** HTTP statuses worth a retry: timeout, rate limit, server errors and "overloaded". Same for both engines. */
export const RETRY_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504, 529])

export function isRetryableStatus(status: number): boolean {
  return RETRY_HTTP_STATUSES.has(status)
}

export const RETRY_BACKOFF_INITIAL_MS = 200
export const RETRY_BACKOFF_MAX_MS = 1000
/** A longer Retry-After falls back to the short backoff instead of stalling the lane. */
export const RETRY_AFTER_MAX_MS = 2000

function headerNumber(response: Pick<Response, 'headers'> | null, name: string): number | undefined {
  const raw = response?.headers.get(name)?.trim()
  if (!raw) return undefined // absent header must not read as 0 (Number(null) === 0)
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * ms to wait before a retry. `retry` is 1-based (1 = first retry). Uses `Retry-After-ms` / `Retry-After`
 * (seconds) when ≤ RETRY_AFTER_MAX_MS; otherwise exponential backoff (200 ms → 1 s) with ±25% jitter.
 * `response` is null after a network failure.
 */
export function retryDelayMs(
  response: Pick<Response, 'headers'> | null,
  retry: number,
  random: () => number = Math.random,
): number {
  const afterMs = headerNumber(response, 'retry-after-ms')
  if (afterMs !== undefined && afterMs <= RETRY_AFTER_MAX_MS) return afterMs
  const afterSeconds = headerNumber(response, 'retry-after')
  if (afterSeconds !== undefined && afterSeconds * 1000 <= RETRY_AFTER_MAX_MS) return afterSeconds * 1000
  const base = Math.min(RETRY_BACKOFF_MAX_MS, RETRY_BACKOFF_INITIAL_MS * 2 ** (Math.max(1, retry) - 1))
  return base * (0.75 + random() * 0.5)
}

/** Resolves after `ms`; rejects with `signal.reason` as soon as the signal aborts (no timer left behind). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ─────────────────────────────── Small helpers ───────────────────────────────

export function roundMs(ms: number): number {
  return Math.round(ms)
}

export function clamp01(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(1, Math.max(0, value))
}

/** Wraps fetch so every HTTP attempt made by an SDK (including its retries) is logged. */
export function instrumentFetch(base: FetchLike, log: AttemptLog[]): FetchLike {
  return async (input, init) => {
    const attempt = log.length + 1
    const started = performance.now()
    try {
      const response = await base(input, init)
      log.push({ attempt, status: response.status, ms: roundMs(performance.now() - started) })
      return response
    } catch (error) {
      const aborted = init?.signal?.aborted === true
      log.push({
        attempt,
        status: null,
        ms: roundMs(performance.now() - started),
        error: aborted ? 'aborted' : error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }
}

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_*.-]{6,}/g,
  /\bBearer\s+[^\s"',]+/gi,
  /\b(api[_-]?key|authorization)(["']?\s*[:=]\s*["']?)[^\s"',]+/gi,
]

/** Removes API keys (the configured ones and anything that looks like one) from text sent to the browser. */
export function redactSecrets(text: string, secrets: Array<string | undefined> = []): string {
  let out = text
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('***')
  }
  out = out
    .replace(SECRET_PATTERNS[0], 'sk-***')
    .replace(SECRET_PATTERNS[1], 'Bearer ***')
    .replace(SECRET_PATTERNS[2], (_m, name: string, sep: string) => `${name}${sep}***`)
  return out.length > 400 ? `${out.slice(0, 400)}…` : out
}

/** SDK errors read "429 Rate limit…"; we prefix the status ourselves, so drop theirs. */
export function withoutStatusPrefix(message: string, status: number | undefined): string {
  return status !== undefined && message.startsWith(`${status} `) ? message.slice(String(status).length + 1) : message
}

export function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'Error desconocido'
}

/**
 * Endpoint as shown in `raw.request` (which reaches the browser): without user:password or query
 * string, where a custom OPENAI_BASE_URL / OPENCODE_BASE_URL could carry a credential.
 */
export function publicEndpoint(url: string): string {
  try {
    const u = new URL(url)
    if (!u.username && !u.password && !u.search && !u.hash) return url
    u.username = ''
    u.password = ''
    u.search = ''
    u.hash = ''
    return u.toString()
  } catch {
    return redactSecrets(url)
  }
}

/** JSON round-trip: the exact value both providers receive (drops undefined, same as JSON.stringify). */
export function toJsonValue<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// ─────────────────────────────── Result helpers ───────────────────────────────

export const NULL_ANSWER: ClassifyAnswer = Object.freeze({ categoryId: null })

/** status 'error': HTTP / network / config / provider failure. `extra` may add attempts, latency, raw… */
export function errorResult(
  engine: EngineId,
  model: string,
  errorMessage: string,
  extra: Partial<ClassifyResult> = {},
): ClassifyResult {
  return { engine, mode: 'live', model, status: 'error', answer: { ...NULL_ANSWER }, errorMessage, ...extra }
}

/** status 'timeout': our own per-attempt timeout fired. Never retried (see the policy above). */
export function timeoutResult(
  engine: EngineId,
  model: string,
  timeoutMs: number,
  extra: Partial<ClassifyResult> = {},
): ClassifyResult {
  return errorResult(engine, model, `Tiempo agotado: el proveedor no respondió en ${timeoutMs} ms.`, {
    status: 'timeout',
    ...extra,
  })
}

export function missingKeyResult(engine: EngineId, model: string, envVar: string): ClassifyResult {
  return errorResult(
    engine,
    model,
    `${envVar} no está configurada en el servidor (.env): usa el modo SIMULADO o agrega la key.`,
  )
}
