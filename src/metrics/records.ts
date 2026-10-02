/**
 * Record-level conventions shared by every metric. Kept in one place so "answered" and "correct"
 * mean exactly the same thing in scoring, calibration, consistency and the paired test.
 */
import type { ClassificationRecord } from '../shared/contracts.ts'

/** The engine produced a usable answer: status 'ok' with a category id. */
export function isAnswered(r: ClassificationRecord): boolean {
  return r.status === 'ok' && r.predicted !== null
}

/**
 * Graded correctness, recomputed from the record: answered AND predicted === expected (exact,
 * like `matchCategoryId`). Invalid / error / timeout are always wrong. `r.correct` is not
 * trusted, so a stale flag can never disagree with the confusion matrix.
 */
export function isCorrect(r: ClassificationRecord): boolean {
  return isAnswered(r) && r.predicted === r.expected
}

/** Slot of a record inside a lane: same item + same repetition (engine-independent). */
export function slotKey(r: Pick<ClassificationRecord, 'itemId' | 'repetition'>): string {
  return `${r.itemId}\u0000${r.repetition}`
}

/**
 * One record per slot (itemId + repetition); a later record replaces an earlier one (e.g. a
 * re-run of the same slot). Order follows the last occurrence of each slot.
 */
export function dedupeRecords(records: readonly ClassificationRecord[]): {
  records: ClassificationRecord[]
  duplicates: number
} {
  const bySlot = new Map<string, ClassificationRecord>()
  let duplicates = 0
  for (const r of records) {
    const key = slotKey(r)
    if (bySlot.has(key)) {
      duplicates += 1
      bySlot.delete(key)
    }
    bySlot.set(key, r)
  }
  return { records: [...bySlot.values()], duplicates }
}

/** Distinct values in first-seen order. */
export function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)]
}
