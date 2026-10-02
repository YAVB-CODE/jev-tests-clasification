/**
 * Pure view-model helpers for the lane panels (feed rows, status copy, elapsed time).
 * No React and no I/O so they can be unit tested in node.
 */
import type {
  Category,
  ClassificationRecord,
  ClassifyStatus,
  LaneRunInfo,
  LaneStatus,
  NativeConfidenceKind,
} from '../../shared/contracts.ts'
import { isAnswered, isCorrect } from '../../metrics/records.ts'

export type Outcome = 'correct' | 'wrong' | 'failed'

/** ✓ correct, ✗ answered wrong, ! no usable answer (invalid / error / timeout). */
export function recordOutcome(record: ClassificationRecord): Outcome {
  if (!isAnswered(record)) return 'failed'
  return isCorrect(record) ? 'correct' : 'wrong'
}

export const STATUS_TEXT: Readonly<Record<ClassifyStatus, string>> = {
  ok: 'Respuesta válida',
  invalid: 'Respuesta inválida',
  error: 'Error',
  timeout: 'Timeout',
}

/** Short label for a record that has no predicted category. */
export const NO_ANSWER_TEXT: Readonly<Record<ClassifyStatus, string>> = {
  ok: 'Sin categoría',
  invalid: 'Inválida',
  error: 'Error',
  timeout: 'Timeout',
}

export const NATIVE_CONFIDENCE_TEXT: Readonly<Record<NativeConfidenceKind, string>> = {
  logprob: 'logprobs del id elegido',
  jev_confidence: 'confianza nativa de Jev',
}

export type CategoryIndex = ReadonlyMap<string, Category>

export function buildCategoryIndex(categories: readonly Category[]): CategoryIndex {
  return new Map(categories.map((c) => [c.id, c]))
}

/** "513530 · Energía eléctrica"; just the id when the category is unknown. */
export function categoryText(index: CategoryIndex, id: string): string {
  const category = index.get(id)
  return category && category.name ? `${id} · ${category.name}` : id
}

export interface TopProbability {
  id: string
  p: number
}

/** The `n` most likely categories (probability desc, then id); non-finite / negative values are dropped. */
export function topProbabilities(probabilities: Record<string, number> | undefined, n = 3): TopProbability[] {
  if (!probabilities || typeof probabilities !== 'object') return []
  return Object.entries(probabilities)
    .filter(([, p]) => typeof p === 'number' && Number.isFinite(p) && p > 0)
    .map(([id, p]) => ({ id, p: Math.min(1, p) }))
    .sort((a, b) => b.p - a.p || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, n))
}

/** Confidence clamped to [0, 1]; undefined when missing or not finite. */
export function clampConfidence(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined
}

/** Newest first. Records arrive in completion order, so the newest is the last one. */
export function feedWindow(records: readonly ClassificationRecord[], limit: number): ClassificationRecord[] {
  const size = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : records.length
  const tail = size >= records.length ? records : records.slice(records.length - size)
  return tail.slice().reverse()
}

export type Tone = 'neutral' | 'info' | 'ok' | 'warn'

export const LANE_STATUS_VIEW: Readonly<Record<LaneStatus, { text: string; tone: Tone }>> = {
  idle: { text: 'En espera', tone: 'neutral' },
  running: { text: 'En curso', tone: 'info' },
  done: { text: 'Terminado', tone: 'ok' },
  aborted: { text: 'Detenido', tone: 'warn' },
}

/**
 * Elapsed time of a lane in ms: from its start to its end, or to `nowMs` while it runs. A lane that
 * re-runs its failures keeps the original end time (the store does not reset it). null before a start.
 */
export function elapsedMs(info: Pick<LaneRunInfo, 'startedAt' | 'finishedAt'>, nowMs: number): number | null {
  if (info.startedAt === undefined) return null
  const end = info.finishedAt ?? nowMs
  return Math.max(0, end - info.startedAt)
}

export interface GlobalProgress {
  completed: number
  total: number
  /** 0..1, or null without a plan. */
  fraction: number | null
}

/** Sum of both lanes: classifications finished vs scheduled. */
export function globalProgress(lanes: ReadonlyArray<{ completed: number; total: number }>): GlobalProgress {
  let completed = 0
  let total = 0
  for (const lane of lanes) {
    completed += lane.completed
    total += lane.total
  }
  return { completed, total, fraction: total > 0 ? Math.min(1, completed / total) : null }
}
