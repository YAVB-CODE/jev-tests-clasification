/**
 * RemoteEngine — real models through the backend: POST /api/classify with a `ClassifyRequest`.
 *
 * Leakage rule: the item ALWAYS goes through `toConceptInput` (whitelist), so `expected`,
 * `difficulty` and `rationale` never leave the browser even if a `LabeledConcept` is passed in.
 * The task is copied field by field for the same reason.
 */
import {
  API_ROUTES,
  CLASSIFY_STATUSES,
  type Category,
  type ClassificationTask,
  type ClassifyRequest,
  type ClassifyResult,
  type ConceptInput,
  type EngineId,
  type LabeledConcept,
} from '../shared/contracts.ts'
import { toConceptInput } from '../shared/task.ts'
import { abortedResult, failedResult } from './abort.ts'
import { defaultFetch, httpFailureMessage, networkFailureMessage, readErrorDetail, type FetchLike } from './http.ts'
import { SERVER_DEFAULT_MODEL } from './labels.ts'
import type { ClassifyOptions, Engine } from './types.ts'

export interface RemoteEngineOptions {
  /** Defaults to API_ROUTES.classify. */
  endpoint?: string
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: FetchLike
}

/** Whitelisted copy of the task (only the contract fields reach the server). */
function cleanTask(task: ClassificationTask): ClassificationTask {
  return {
    instructions: task.instructions,
    question: task.question,
    categories: task.categories.map((c) => {
      const category: Category = { id: c.id, name: c.name, description: c.description }
      if (c.group !== undefined) category.group = c.group
      return category
    }),
  }
}

/** Builds the exact body sent to the server. Exported for tests and the detail view. */
export function buildClassifyRequest(engine: EngineId, task: ClassificationTask, item: ConceptInput, model?: string): ClassifyRequest {
  // `toConceptInput` only reads ConceptInput fields: safe for plain ConceptInput values too.
  const body: ClassifyRequest = { engine, task: cleanTask(task), item: toConceptInput(item as LabeledConcept) }
  if (model) body.model = model
  return body
}

function looksLikeClassifyResult(value: unknown): value is ClassifyResult {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { status?: unknown; answer?: unknown }
  if (typeof v.status !== 'string' || !(CLASSIFY_STATUSES as readonly string[]).includes(v.status)) return false
  if (typeof v.answer !== 'object' || v.answer === null) return false
  const categoryId = (v.answer as { categoryId?: unknown }).categoryId
  return categoryId === null || categoryId === undefined || typeof categoryId === 'string'
}

export class RemoteEngine implements Engine {
  readonly id: EngineId
  readonly mode = 'live' as const
  private readonly endpoint: string
  private readonly doFetch: FetchLike

  constructor(id: EngineId, options: RemoteEngineOptions = {}) {
    this.id = id
    this.endpoint = options.endpoint ?? API_ROUTES.classify
    this.doFetch = options.fetch ?? defaultFetch
  }

  async classify(task: ClassificationTask, item: ConceptInput, opts: ClassifyOptions): Promise<ClassifyResult> {
    const { signal } = opts
    const model = opts.model || SERVER_DEFAULT_MODEL
    if (signal.aborted) return abortedResult(this.id, 'live', model, signal)

    try {
      const body = buildClassifyRequest(this.id, task, item, opts.model)
      const response = await this.doFetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
      if (!response.ok) {
        const detail = await readErrorDetail(response)
        return failedResult(this.id, 'live', model, 'error', httpFailureMessage(response.status, detail))
      }
      const payload: unknown = await response.json()
      if (!looksLikeClassifyResult(payload)) {
        return failedResult(this.id, 'live', model, 'error', 'La API devolvió una respuesta con formato inesperado')
      }
      return {
        ...payload,
        engine: this.id,
        mode: 'live',
        model: typeof payload.model === 'string' && payload.model ? payload.model : model,
        answer: { ...payload.answer, categoryId: payload.answer.categoryId ?? null },
      }
    } catch (error) {
      if (signal.aborted) return abortedResult(this.id, 'live', model, signal)
      if (error instanceof SyntaxError) {
        return failedResult(this.id, 'live', model, 'error', 'La API devolvió un JSON inválido')
      }
      return failedResult(this.id, 'live', model, 'error', networkFailureMessage(error))
    }
  }
}
