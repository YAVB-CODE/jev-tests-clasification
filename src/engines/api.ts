/**
 * Read-only API client: GET /api/health and GET /api/models. Neither function throws.
 * - `fetchHealth` falls back to an "offline" response (ok: false, no live engine, Spanish warning),
 *   so the UI keeps working in SIMULADO mode when the backend is down.
 * - `fetchModels` returns `{ ok: false, error }` instead of throwing.
 */
import {
  API_ROUTES,
  ENGINE_IDS,
  type EngineHealth,
  type EngineId,
  type EngineModels,
  type HealthResponse,
  type ModelsResponse,
} from '../shared/contracts.ts'
import { defaultFetch, httpFailureMessage, networkFailureMessage, readErrorDetail, type FetchLike } from './http.ts'

export interface ApiOptions {
  fetch?: FetchLike
  timeoutMs?: number
  /** Extra cancellation (e.g. component unmount). */
  signal?: AbortSignal
}

export const HEALTH_TIMEOUT_MS = 5_000
/** Listing the providers' catalogues can take a few seconds. */
export const MODELS_TIMEOUT_MS = 20_000

export const DEFAULT_PROVIDERS: Readonly<Record<EngineId, string>> = { gpt: 'OpenAI', jev: 'OpenCode Zen' }

export type ModelsResult = { ok: true; models: ModelsResponse } | { ok: false; error: string }

type JsonResult = { ok: true; data: unknown } | { ok: false; error: string }

async function getJson(url: string, opts: ApiOptions, defaultTimeoutMs: number): Promise<JsonResult> {
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onOuterAbort = (): void => controller.abort()
  if (opts.signal?.aborted) controller.abort()
  else opts.signal?.addEventListener('abort', onOuterAbort, { once: true })
  try {
    const response = await (opts.fetch ?? defaultFetch)(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
    if (!response.ok) return { ok: false, error: httpFailureMessage(response.status, await readErrorDetail(response)) }
    return { ok: true, data: await response.json() }
  } catch (error) {
    if (timedOut) return { ok: false, error: `La API no respondió en ${Math.round(timeoutMs / 1000)} s` }
    if (controller.signal.aborted) return { ok: false, error: 'Solicitud cancelada' }
    if (error instanceof SyntaxError) return { ok: false, error: 'La API devolvió un JSON inválido' }
    return { ok: false, error: networkFailureMessage(error) }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onOuterAbort)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Health with no live engine: what the UI assumes when the backend cannot be reached. */
export function offlineHealth(reason: string): HealthResponse {
  const engine = (id: EngineId): EngineHealth => ({ live: false, model: '', provider: DEFAULT_PROVIDERS[id] })
  return {
    ok: false,
    engines: { gpt: engine('gpt'), jev: engine('jev') },
    warnings: [`Sin conexión con la API: ${reason}. Ambos motores quedan solo en modo simulado.`],
  }
}

function parseHealth(value: unknown): HealthResponse | null {
  if (!isRecord(value) || !isRecord(value.engines)) return null
  const engines = {} as Record<EngineId, EngineHealth>
  for (const id of ENGINE_IDS) {
    const e = value.engines[id]
    if (!isRecord(e) || typeof e.live !== 'boolean') return null
    engines[id] = {
      live: e.live,
      model: typeof e.model === 'string' ? e.model : '',
      provider: typeof e.provider === 'string' ? e.provider : DEFAULT_PROVIDERS[id],
    }
  }
  const warnings = Array.isArray(value.warnings) ? value.warnings.filter((w): w is string => typeof w === 'string') : []
  return { ok: value.ok !== false, engines, warnings }
}

function parseModels(value: unknown): ModelsResponse | null {
  if (!isRecord(value)) return null
  const out = {} as Record<EngineId, EngineModels>
  for (const id of ENGINE_IDS) {
    const e = value[id]
    if (!isRecord(e) || typeof e.default !== 'string' || !Array.isArray(e.models)) return null
    const models = e.models.filter((m): m is EngineModels['models'][number] => isRecord(m) && typeof m.id === 'string')
    const entry: EngineModels = { ...(e as unknown as EngineModels), models }
    if (entry.source !== 'provider' && entry.source !== 'fallback') entry.source = 'fallback'
    out[id] = entry
  }
  return out
}

/** GET /api/health. Never throws (see `offlineHealth`). */
export async function fetchHealth(opts: ApiOptions = {}): Promise<HealthResponse> {
  const result = await getJson(API_ROUTES.health, opts, HEALTH_TIMEOUT_MS)
  if (!result.ok) return offlineHealth(result.error)
  return parseHealth(result.data) ?? offlineHealth('respuesta de /api/health con formato inesperado')
}

/** GET /api/models (`refresh` → `?refresh=1`, ignores the server cache). Never throws. */
export async function fetchModels(refresh = false, opts: ApiOptions = {}): Promise<ModelsResult> {
  const url = refresh ? `${API_ROUTES.models}?refresh=1` : API_ROUTES.models
  const result = await getJson(url, opts, MODELS_TIMEOUT_MS)
  if (!result.ok) return result
  const models = parseModels(result.data)
  return models ? { ok: true, models } : { ok: false, error: 'Respuesta de /api/models con formato inesperado' }
}
