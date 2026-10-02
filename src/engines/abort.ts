/** Abort / timeout helpers shared by the engines and the runner. */
import type { ClassifyResult, EngineId, EngineMode } from '../shared/contracts.ts'

/** `AbortSignal.reason.name` the runner uses when a call runs out of time. */
export const TIMEOUT_ERROR_NAME = 'TimeoutError'

export function createAbortError(message = 'Clasificación cancelada'): DOMException {
  return new DOMException(message, 'AbortError')
}

export function createTimeoutError(message = 'Tiempo agotado'): DOMException {
  return new DOMException(message, TIMEOUT_ERROR_NAME)
}

function errorName(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? (value as { name?: unknown }).name : undefined
}

export function isAbortError(error: unknown): boolean {
  const name = errorName(error)
  return name === 'AbortError' || name === TIMEOUT_ERROR_NAME
}

/** true when `signal` was aborted because of a timeout (runner) rather than a cancellation. */
export function isTimeoutAbort(signal: AbortSignal): boolean {
  return signal.aborted && errorName(signal.reason) === TIMEOUT_ERROR_NAME
}

/**
 * Resolves after `ms`; rejects with an AbortError as soon as `signal` aborts (clearing the timer)
 * or right away if it already is. A non-positive delay resolves immediately.
 */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(createAbortError())
      return
    }
    if (ms <= 0) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(createAbortError())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** A result without an answer (error / invalid / timeout). */
export function failedResult(
  engine: EngineId,
  mode: EngineMode,
  model: string,
  status: Exclude<ClassifyResult['status'], 'ok'>,
  errorMessage: string,
  extra: Partial<ClassifyResult> = {},
): ClassifyResult {
  return { engine, mode, model, status, answer: { categoryId: null }, errorMessage, ...extra }
}

/** The result an engine returns when its call was aborted: 'timeout' or a cancellation 'error'. */
export function abortedResult(engine: EngineId, mode: EngineMode, model: string, signal: AbortSignal): ClassifyResult {
  return isTimeoutAbort(signal)
    ? failedResult(engine, mode, model, 'timeout', 'Tiempo agotado esperando la respuesta')
    : failedResult(engine, mode, model, 'error', 'Clasificación cancelada')
}
