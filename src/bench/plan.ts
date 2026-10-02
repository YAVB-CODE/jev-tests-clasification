/**
 * Run plan: the exact queue of classifications a run executes. It is built ONCE per run and shared
 * by both lanes, so GPT and Jev see the same items in the same order (fairness rule).
 *
 * Order: filter by difficulty → seeded shuffle (if `shuffle`) → `limit` → repetitions
 * (pass 0 over every item, then pass 1, …). `index` is the 0-based position in that queue.
 */
import type { BenchConfig, Dataset, LabeledConcept } from '../shared/contracts.ts'
import { createRng, hashSeed, seededShuffle } from './rng.ts'

export interface PlannedItem {
  /** The labeled item. Only the MockEngine oracle and the grader read the label. */
  item: LabeledConcept
  /** 0-based position in the lane queue (same in both lanes). */
  index: number
  /** 0-based pass number. */
  repetition: number
}

/** Items selected for a run (filtered, shuffled and limited), before repetitions. */
export function selectPlanItems(dataset: Dataset, config: BenchConfig): LabeledConcept[] {
  const difficulties = config.difficulties ?? []
  // With a difficulty filter, items without difficulty are left out.
  let items =
    difficulties.length > 0
      ? dataset.items.filter((item) => item.difficulty !== undefined && difficulties.includes(item.difficulty))
      : dataset.items.slice()
  if (config.shuffle) items = seededShuffle(items, createRng(hashSeed('plan', config.seed)))
  if (config.limit !== undefined && Number.isFinite(config.limit)) {
    items = items.slice(0, Math.max(0, Math.floor(config.limit)))
  }
  return items
}

/** Builds the run queue: `selectPlanItems` × `config.repetitions` passes. Deterministic for a given seed. */
export function buildRunPlan(dataset: Dataset, config: BenchConfig): PlannedItem[] {
  const items = selectPlanItems(dataset, config)
  const passes = Math.max(1, Math.floor(config.repetitions))
  const plan: PlannedItem[] = []
  for (let repetition = 0; repetition < passes; repetition++) {
    for (const item of items) plan.push({ item, index: plan.length, repetition })
  }
  return plan
}

/** Key of a planned classification within a lane: `${itemId}:${repetition}`. */
export function plannedKey(entry: { itemId: string; repetition: number }): string {
  return `${entry.itemId}:${entry.repetition}`
}
