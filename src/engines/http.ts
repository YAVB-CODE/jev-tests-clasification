/** HTTP helpers for the API client (RemoteEngine and api.ts). Messages in Spanish, ready for the UI. */
import type { ApiErrorBody } from '../shared/contracts.ts'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Late-bound global fetch (works with test stubs and avoids "Illegal invocation" in browsers). */
export const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init)

const MAX_DETAIL_LENGTH = 300

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return typeof value === 'object' && value !== null && typeof (value as { error?: unknown }).error === 'string'
}

/** Readable detail of a non-2xx response: `ApiErrorBody.error` (+ first details) or a text snippet. */
export async function readErrorDetail(response: Response): Promise<string> {
  let text = ''
  try {
    text = await response.text()
  } catch {
    return ''
  }
  try {
    const body: unknown = JSON.parse(text)
    if (isApiErrorBody(body)) {
      const details = Array.isArray(body.details) ? body.details.filter((d) => typeof d === 'string').slice(0, 3) : []
      return [body.error, ...details].join(' · ').slice(0, MAX_DETAIL_LENGTH)
    }
  } catch {
    // not JSON: fall through to the raw text
  }
  return text.trim().replace(/\s+/g, ' ').slice(0, MAX_DETAIL_LENGTH)
}

/** Spanish message for an HTTP failure. */
export function httpFailureMessage(status: number, detail: string): string {
  const suffix = detail ? `: ${detail}` : ''
  if (status === 400) return `La API rechazó la solicitud (HTTP 400)${suffix}`
  if (status >= 500) {
    // Vite's proxy answers 5xx with an empty body when the backend is down.
    return detail
      ? `Error del servidor (HTTP ${status})${suffix}`
      : `Error del servidor (HTTP ${status}). ¿Está corriendo el servidor de la API (npm run dev)?`
  }
  return `Respuesta inesperada de la API (HTTP ${status})${suffix}`
}

/** Spanish message for a network failure (fetch rejected without a response). */
export function networkFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `No se pudo conectar con la API (${detail}). ¿Está corriendo el servidor (npm run dev)?`
}
