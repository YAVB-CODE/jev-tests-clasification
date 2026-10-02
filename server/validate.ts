/**
 * POST /api/classify body validation.
 *
 * Fairness: the result is a NEW object built from an allow-list (`validateTask` and
 * `validateConceptInput` in src/shared/task.ts), so the expected label (`expected`, `difficulty`,
 * `rationale`) and any other extra field a client might send never reach the adapters or the models.
 */
import { ENGINE_IDS, isEngineId, type ClassifyRequest } from '../src/shared/contracts.ts'
import { LIMITS, validateConceptInput, validateTask } from '../src/shared/task.ts'

/** Model ids look like gpt-4.1-mini, o4-mini, jev-1.13-free, openai/gpt-5 … (no spaces or control characters). */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/

export type ParseResult = { ok: true; value: ClassifyRequest } | { ok: false; errors: string[] }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validates an untrusted body. Collects every error (Spanish, with field paths) instead of stopping at the first. */
export function parseClassifyRequest(body: unknown): ParseResult {
  if (!isPlainObject(body)) {
    return { ok: false, errors: ['body: debe ser un objeto JSON { engine, task, item }'] }
  }
  const errors: string[] = []

  const { engine, model } = body
  if (!isEngineId(engine)) errors.push(`engine: debe ser uno de ${ENGINE_IDS.join(', ')}`)

  if (model !== undefined && (typeof model !== 'string' || !MODEL_ID_PATTERN.test(model))) {
    errors.push('model: debe ser un id de modelo como "gpt-4.1-mini" o "jev-1.13" (sin espacios, máximo 100 caracteres)')
  }

  const task = validateTask(body.task, 'task')
  if (!task.ok) errors.push(...task.errors)
  const item = validateConceptInput(body.item, 'item')
  if (!item.ok) errors.push(...item.errors)

  if (errors.length > 0 || !isEngineId(engine) || !task.ok || !item.ok) {
    // Same cap as the shared validators (a bad task plus a bad item could exceed it).
    const capped =
      errors.length > LIMITS.maxErrors
        ? [...errors.slice(0, LIMITS.maxErrors), `… y ${errors.length - LIMITS.maxErrors} errores más`]
        : errors
    return { ok: false, errors: capped }
  }

  const value: ClassifyRequest = { engine, task: task.value, item: item.value }
  if (typeof model === 'string') value.model = model
  return { ok: true, value }
}
