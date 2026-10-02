import { useEffect, useRef } from 'react'
import { benchStore, useBench } from '../../bench/useBench.ts'
import { ENGINE_IDS } from '../../shared/contracts.ts'
import { queryToConfigPatch, type AppQuery } from './query.ts'

/**
 * Applies the QA switches of the URL once: `?mock=1` (both lanes SIMULADO), `?limit=` and `?seed=`.
 * `?autostart=1` then starts the run as soon as health and models have loaded.
 */
export function useQueryBootstrap(query: AppQuery): void {
  const applied = useRef(false)
  const started = useRef(false)

  useEffect(() => {
    if (applied.current) return
    applied.current = true
    const state = benchStore.getState()
    if (query.mock) for (const engine of ENGINE_IDS) state.setLaneMode(engine, 'mock')
    const patch = queryToConfigPatch(query)
    if (Object.keys(patch).length > 0) state.setConfig(patch)
  }, [query])

  // Ready = health answered (even offline) and the models request settled (loaded or failed).
  const ready = useBench((s) => s.health !== null && !s.healthLoading && !s.modelsLoading && (s.models !== null || s.modelsError !== null))

  useEffect(() => {
    if (!query.autostart || started.current || !ready) return
    started.current = true
    const state = benchStore.getState()
    if (state.status === 'idle') state.start()
  }, [query.autostart, ready])
}
