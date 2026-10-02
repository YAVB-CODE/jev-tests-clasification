import { useMemo } from 'react'
import { useBench } from '../../bench/useBench.ts'
import type { LabeledConcept } from '../../shared/contracts.ts'
import { buildCategoryIndex, type CategoryIndex } from './laneView.ts'

export interface RunLookup {
  /** Items of the run by id (concept text, supplier, rationale, difficulty). */
  items: ReadonlyMap<string, LabeledConcept>
  /** Categories of the run's task (the snapshot, not the active dataset). */
  categories: CategoryIndex
}

/** Lookups over the current / last run snapshot, rebuilt only when the run's plan or task changes. */
export function useRunLookup(): RunLookup {
  const plan = useBench((s) => s.run?.plan)
  const task = useBench((s) => s.run?.task)
  return useMemo(
    () => ({
      items: new Map((plan ?? []).map((p) => [p.item.id, p.item] as const)),
      categories: buildCategoryIndex(task?.categories ?? []),
    }),
    [plan, task],
  )
}
