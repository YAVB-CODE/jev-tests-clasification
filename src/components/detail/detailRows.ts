/**
 * Pure model of the per-concept detail table: joins the run plan with both lanes' records,
 * then filters, searches and sorts. No React, no I/O, so it is unit tested.
 *
 * One row per planned slot (item + repetition). A slot with no record yet in a lane is "pending"
 * for that lane. Outcomes use the same definition of "correct" as the metrics module.
 */
import {
  ENGINE_IDS,
  type Category,
  type ClassificationRecord,
  type ClassifyStatus,
  type Difficulty,
  type EngineId,
  type LabeledConcept,
} from '../../shared/contracts.ts'
import { isAnswered, isCorrect } from '../../metrics/records.ts'
import type { PlannedItem } from '../../bench/plan.ts'

export const STATUS_LABELS: Record<ClassifyStatus, string> = {
  ok: 'Respuesta válida',
  invalid: 'Respuesta inválida',
  error: 'Error',
  timeout: 'Timeout',
}

export const DIFFICULTY_LABELS: Record<Difficulty, string> = { easy: 'Fácil', medium: 'Media', hard: 'Difícil' }

export type Outcome = 'correct' | 'wrong' | 'failed' | 'pending'

/** correct = right answer; wrong = answered a different category; failed = invalid / error / timeout. */
export function outcomeOf(record: ClassificationRecord | undefined): Outcome {
  if (!record) return 'pending'
  if (isCorrect(record)) return 'correct'
  return isAnswered(record) ? 'wrong' : 'failed'
}

export interface DetailRow {
  /** `${itemId}:${repetition}` */
  key: string
  /** 0-based queue position. */
  index: number
  /** 0-based pass. */
  repetition: number
  item: LabeledConcept
  records: Record<EngineId, ClassificationRecord | undefined>
}

export function rowKey(entry: { itemId: string; repetition: number }): string {
  return `${entry.itemId}:${entry.repetition}`
}

/** One row per planned slot, in queue order. A later record of the same slot replaces an earlier one. */
export function buildDetailRows(
  plan: readonly PlannedItem[],
  records: Record<EngineId, readonly ClassificationRecord[]>,
): DetailRow[] {
  const byLane = {} as Record<EngineId, Map<string, ClassificationRecord>>
  for (const e of ENGINE_IDS) {
    const map = new Map<string, ClassificationRecord>()
    for (const r of records[e]) map.set(rowKey(r), r)
    byLane[e] = map
  }
  return plan.map((p) => {
    const key = rowKey({ itemId: p.item.id, repetition: p.repetition })
    return {
      key,
      index: p.index,
      repetition: p.repetition,
      item: p.item,
      records: { gpt: byLane.gpt.get(key), jev: byLane.jev.get(key) },
    }
  })
}

/** Distinct repetitions present in the rows, ascending (0-based). */
export function repetitionsOf(rows: readonly DetailRow[]): number[] {
  return [...new Set(rows.map((r) => r.repetition))].sort((a, b) => a - b)
}

// ─────────────────────────────── Filters ───────────────────────────────

export type RowFilter = 'all' | 'both_correct' | 'only_gpt' | 'only_jev' | 'both_wrong' | 'failures'

export const ROW_FILTERS: readonly { id: RowFilter; label: string; hint: string }[] = [
  { id: 'all', label: 'Todos', hint: 'Todos los conceptos de la corrida' },
  { id: 'both_correct', label: 'Ambos aciertan', hint: 'GPT y Jev eligieron la categoría esperada' },
  { id: 'only_gpt', label: 'Solo GPT acierta', hint: 'GPT acertó y Jev no' },
  { id: 'only_jev', label: 'Solo Jev acierta', hint: 'Jev acertó y GPT no' },
  { id: 'both_wrong', label: 'Ambos fallan', hint: 'Ninguno acertó (incluye errores y respuestas inválidas)' },
  { id: 'failures', label: 'Con fallos', hint: 'Algún motor devolvió error, timeout o una respuesta inválida' },
]

/** Both lanes have a record for the row (comparison filters ignore half-finished rows). */
function complete(row: DetailRow): boolean {
  return row.records.gpt !== undefined && row.records.jev !== undefined
}

export function matchesFilter(row: DetailRow, filter: RowFilter): boolean {
  if (filter === 'all') return true
  const g = outcomeOf(row.records.gpt)
  const j = outcomeOf(row.records.jev)
  switch (filter) {
    case 'both_correct':
      return complete(row) && g === 'correct' && j === 'correct'
    case 'only_gpt':
      return complete(row) && g === 'correct' && j !== 'correct'
    case 'only_jev':
      return complete(row) && j === 'correct' && g !== 'correct'
    case 'both_wrong':
      return complete(row) && g !== 'correct' && j !== 'correct'
    case 'failures':
      return g === 'failed' || j === 'failed'
  }
}

/** Rows per filter (filters are not mutually exclusive: a failure also counts as a miss). */
export function countFilters(rows: readonly DetailRow[]): Record<RowFilter, number> {
  const counts = { all: 0, both_correct: 0, only_gpt: 0, only_jev: 0, both_wrong: 0, failures: 0 } satisfies Record<RowFilter, number>
  for (const row of rows) {
    for (const f of ROW_FILTERS) if (matchesFilter(row, f.id)) counts[f.id] += 1
  }
  return counts
}

// ─────────────────────────────── Search ───────────────────────────────

/** Lowercase, accent-insensitive. */
export function normalizeText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/** Name lookup for category ids; unknown ids come back as the id itself. */
export function categoryNames(categories: readonly Category[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const c of categories) if (!map.has(c.id)) map.set(c.id, c.name)
  return map
}

function haystack(row: DetailRow, names: ReadonlyMap<string, string>): string {
  const parts: (string | number | undefined | null)[] = [
    row.item.concept,
    row.item.supplier,
    row.item.notes,
    row.item.id,
    row.item.expected,
    names.get(row.item.expected),
  ]
  for (const e of ENGINE_IDS) {
    const predicted = row.records[e]?.predicted
    if (predicted) parts.push(predicted, names.get(predicted))
  }
  return normalizeText(parts.filter((p) => p !== undefined && p !== null && p !== '').join(' \n '))
}

/** Every whitespace-separated term must appear (AND). An empty query matches everything. */
export function matchesQuery(row: DetailRow, query: string, names: ReadonlyMap<string, string>): boolean {
  const terms = normalizeText(query).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const text = haystack(row, names)
  return terms.every((t) => text.includes(t))
}

// ─────────────────────────────── Sorting ───────────────────────────────

export type SortKey = 'queue' | 'disagreement' | 'confidence_gpt' | 'confidence_jev' | 'latency_gpt' | 'latency_jev'

export const SORT_OPTIONS: readonly { id: SortKey; label: string }[] = [
  { id: 'queue', label: 'Cola de ejecución' },
  { id: 'disagreement', label: 'Desacuerdo' },
  { id: 'confidence_gpt', label: 'Confianza GPT' },
  { id: 'confidence_jev', label: 'Confianza Jev' },
  { id: 'latency_gpt', label: 'Latencia GPT' },
  { id: 'latency_jev', label: 'Latencia Jev' },
]

/** Natural direction of each key: the queue goes first → last, everything else biggest first. */
export function defaultDescending(key: SortKey): boolean {
  return key !== 'queue'
}

/**
 * How much the engines disagree on a row: 3 = exactly one is right, 2 = both wrong with different
 * answers, 1 = both wrong with the same answer, 0 = both right. null while a lane is pending.
 */
export function disagreementScore(row: DetailRow): number | null {
  const g = row.records.gpt
  const j = row.records.jev
  if (!g || !j) return null
  const gc = isCorrect(g)
  const jc = isCorrect(j)
  if (gc !== jc) return 3
  if (gc) return 0
  return g.predicted !== j.predicted ? 2 : 1
}

function sortValue(row: DetailRow, key: SortKey): number | null {
  switch (key) {
    case 'queue':
      return row.index
    case 'disagreement':
      return disagreementScore(row)
    case 'confidence_gpt':
      return row.records.gpt?.confidence ?? null
    case 'confidence_jev':
      return row.records.jev?.confidence ?? null
    case 'latency_gpt':
      return row.records.gpt?.latencyMs ?? null
    case 'latency_jev':
      return row.records.jev?.latencyMs ?? null
  }
}

/** Sorted copy. Rows without a value always go last; ties keep queue order. */
export function sortRows(rows: readonly DetailRow[], key: SortKey, descending = defaultDescending(key)): DetailRow[] {
  const sign = descending ? -1 : 1
  return rows.slice().sort((a, b) => {
    const va = sortValue(a, key)
    const vb = sortValue(b, key)
    if (va === null || !Number.isFinite(va)) {
      if (vb !== null && Number.isFinite(vb)) return 1
    } else if (vb === null || !Number.isFinite(vb)) {
      return -1
    } else if (va !== vb) {
      return sign * (va - vb)
    }
    return a.index - b.index || a.repetition - b.repetition
  })
}
