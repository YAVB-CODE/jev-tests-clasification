/** Pure helpers for the quick test: form → concept, examples, ranking, judging and lane comparison. */
import type {
  ClassifyResult,
  ClassifyStatus,
  ConceptInput,
  EngineId,
  LabeledConcept,
  NativeConfidenceKind,
} from '../../shared/contracts.ts'
import { LIMITS } from '../../shared/task.ts'
import { parseAmount } from '../../data/importDataset.ts'

/** Concept as typed in the form (no id: the store assigns one). */
export interface QuickConcept {
  concept: string
  supplier?: string
  amount?: number
  currency?: string
  notes?: string
}

export interface QuickFormValues {
  concept: string
  supplier: string
  amount: string
  currency: string
  notes: string
}

export const DEFAULT_CURRENCY = 'COP'

export function emptyQuickForm(): QuickFormValues {
  return { concept: '', supplier: '', amount: '', currency: DEFAULT_CURRENCY, notes: '' }
}

/** Form values for a concept (an example, or the last one sent). */
export function formFromConcept(item: Omit<ConceptInput, 'id'> | null | undefined): QuickFormValues {
  if (!item) return emptyQuickForm()
  return {
    concept: item.concept,
    supplier: item.supplier ?? '',
    amount: item.amount === undefined ? '' : String(item.amount).replace('.', ','),
    currency: item.currency ?? DEFAULT_CURRENCY,
    notes: item.notes ?? '',
  }
}

export type BuildQuickResult = { ok: true; input: QuickConcept } | { ok: false; error: string }

/**
 * Builds the concept to classify. Optional fields are sent only when filled; the currency only travels
 * with an amount (and defaults to COP), so an empty value never reaches the models.
 */
export function buildQuickInput(form: QuickFormValues): BuildQuickResult {
  const concept = form.concept.trim()
  if (concept === '') return { ok: false, error: 'Escribe el concepto que quieres clasificar.' }
  if (concept.length > LIMITS.conceptLength) {
    return { ok: false, error: `El concepto admite máximo ${LIMITS.conceptLength} caracteres.` }
  }
  const input: QuickConcept = { concept }
  const supplier = form.supplier.trim()
  if (supplier !== '') input.supplier = supplier
  const amountText = form.amount.trim()
  if (amountText !== '') {
    const amount = parseAmount(amountText)
    if (amount === null) return { ok: false, error: `El valor «${amountText}» no es un monto válido (usa 1234567,89 o 1.234.567,89).` }
    input.amount = amount
    input.currency = form.currency.trim().toUpperCase() || DEFAULT_CURRENCY
  }
  const notes = form.notes.trim()
  if (notes !== '') input.notes = notes
  return { ok: true, input }
}

/**
 * Up to `count` items to try with one click, spread over the difficulties (easy, medium, hard, then
 * unrated) and over each group's list, so the chips show variety. Deterministic.
 */
export function pickExamples(items: readonly LabeledConcept[], count = 5): LabeledConcept[] {
  if (count <= 0 || items.length === 0) return []
  const buckets = [
    items.filter((i) => i.difficulty === 'easy'),
    items.filter((i) => i.difficulty === 'medium'),
    items.filter((i) => i.difficulty === 'hard'),
    items.filter((i) => i.difficulty === undefined),
  ].filter((bucket) => bucket.length > 0)
  const rounds = Math.ceil(count / buckets.length)
  const picked: LabeledConcept[] = []
  const seen = new Set<string>()
  const take = (item: LabeledConcept | undefined): void => {
    if (item !== undefined && picked.length < count && !seen.has(item.id)) {
      seen.add(item.id)
      picked.push(item)
    }
  }
  for (let round = 0; round < rounds; round++) {
    for (const bucket of buckets) take(bucket[Math.floor(((round + 0.5) * bucket.length) / rounds)])
  }
  for (const item of items) take(item) // top up when buckets were too small
  return picked
}

export interface RankedProbability {
  id: string
  p: number
}

/** The `n` most probable categories, highest first (ties by id); ignores non-finite values. */
export function topProbabilities(probabilities: Record<string, number> | undefined, n = 5): RankedProbability[] {
  if (!probabilities) return []
  return Object.entries(probabilities)
    .filter(([, p]) => Number.isFinite(p))
    .map(([id, p]) => ({ id, p }))
    .sort((a, b) => b.p - a.p || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, n))
}

export type Judgement = 'correct' | 'wrong' | 'failed'

/** Did the lane get the local expected answer right? null when no expected answer was picked or there is no result. */
export function judgeAnswer(result: Pick<ClassifyResult, 'status' | 'answer'> | undefined, expected: string): Judgement | null {
  if (expected === '' || result === undefined) return null
  if (result.status !== 'ok' || result.answer.categoryId === null) return 'failed'
  return result.answer.categoryId === expected ? 'correct' : 'wrong'
}

export const STATUS_LABEL: Record<ClassifyStatus, string> = {
  ok: 'Respuesta válida',
  invalid: 'Respuesta inválida',
  error: 'Error',
  timeout: 'Tiempo agotado',
}

/** What `ClassifyAnswer.confidence` means for each engine (it is the comparable signal). */
export const CONFIDENCE_NOTE: Record<EngineId, string> = {
  gpt: 'Probabilidad que GPT declara en su propia respuesta de que la categoría elegida sea correcta.',
  jev: 'Probabilidad que Jev asigna a la categoría elegida dentro de su distribución sobre las categorías.',
}

/** Native confidence: a one-line explanation of each kind (informative, not compared across engines). */
export const NATIVE_CONFIDENCE: Record<NativeConfidenceKind, { label: string; note: string }> = {
  logprob: {
    label: 'logprob',
    note: 'Probabilidad derivada de los logprobs de los tokens de la respuesta de GPT. Es informativa: no se compara con Jev.',
  },
  jev_confidence: {
    label: 'jev_confidence',
    note: 'Estadístico nativo «confidence» de la respuesta Choice de Jev. No es una probabilidad: es informativo.',
  },
}

export interface LaneOutcome {
  engine: EngineId
  categoryId: string | null
  latencyMs: number | undefined
}

export interface LaneComparison {
  /** Both answered with a category: do they agree? null when either has no answer. */
  agree: boolean | null
  /** Faster lane by end-to-end latency and by how many times; null when similar (< 5 %) or unknown. */
  faster: { engine: EngineId; ratio: number } | null
}

export function compareLanes(a: LaneOutcome, b: LaneOutcome): LaneComparison {
  const agree = a.categoryId !== null && b.categoryId !== null ? a.categoryId === b.categoryId : null
  let faster: LaneComparison['faster'] = null
  if (a.latencyMs !== undefined && b.latencyMs !== undefined && a.latencyMs > 0 && b.latencyMs > 0) {
    const ratio = Math.max(a.latencyMs, b.latencyMs) / Math.min(a.latencyMs, b.latencyMs)
    if (ratio >= 1.05) faster = { engine: a.latencyMs < b.latencyMs ? a.engine : b.engine, ratio }
  }
  return { agree, faster }
}
