/**
 * App-wide benchmark store wired to the real datasets, browser storage, engines and API.
 *
 *   const status = useBench((s) => s.status)
 *   const start = useBench((s) => s.start)
 *   const validity = useBench(selectRunValidity)   // memoized selector from store.ts
 *
 * `init()` (health + models) runs once on import in the browser; calling it again is a no-op.
 *
 * Selectors must return stable values (state slices, primitives or the memoized selectors in
 * store.ts); for derived objects use `useShallow` from 'zustand/react/shallow' or `useMemo`.
 */
import { useStore } from 'zustand'
import { DEFAULT_DATASET_ID, SEED_DATASETS } from '../data/datasets.ts'
import { loadCustomDatasets, saveCustomDatasets } from '../data/storage.ts'
import { fetchHealth, fetchModels } from '../engines/api.ts'
import { createEngine } from '../engines/index.ts'
import { createBenchStore, type BenchState } from './store.ts'

export const benchStore = createBenchStore({
  seedDatasets: SEED_DATASETS,
  defaultDatasetId: DEFAULT_DATASET_ID,
  loadCustomDatasets: () => loadCustomDatasets(),
  saveCustomDatasets: (datasets) => saveCustomDatasets(datasets),
  createEngine: (id, mode, opts) => createEngine(id, mode, opts),
  fetchHealth: () => fetchHealth(),
  fetchModels: (refresh) => fetchModels(refresh),
})

if (typeof window !== 'undefined') void benchStore.getState().init()

export function useBench<T>(selector: (state: BenchState) => T): T {
  return useStore(benchStore, selector)
}

export {
  isFailedRecord,
  selectActiveDataset,
  selectCanConfigure,
  selectFailedCount,
  selectLiveAvailable,
  selectRunValidity,
} from './store.ts'
export type { BenchRun, BenchState, BenchStatus, LaneState, QuickInput, QuickLane, QuickState, RunValidity } from './store.ts'
