/**
 * Shared React hooks over the pure metrics module, used by lanes, comparison and detail views.
 * Results are memoized per engine by input identity (records / run info / run task), so every
 * component that asks for the same lane gets the same object and the work is done once per update.
 * Categories come from the run snapshot (`run.task`), never from the active dataset, which the
 * user may edit after the run.
 */
import { useMemo } from 'react'
import { useBench } from '../../bench/useBench.ts'
import { compareLanes, computeLaneMetrics, type Comparison, type LaneMetrics } from '../../metrics/index.ts'
import type { ClassificationRecord, ClassificationTask, EngineId, LaneRunInfo } from '../../shared/contracts.ts'

interface LaneMemo {
  records: readonly ClassificationRecord[]
  info: LaneRunInfo
  task: ClassificationTask
  metrics: LaneMetrics
}

const laneMemo: Partial<Record<EngineId, LaneMemo>> = {}

function laneMetricsFor(
  engine: EngineId,
  records: readonly ClassificationRecord[],
  info: LaneRunInfo,
  task: ClassificationTask,
): LaneMetrics {
  const memo = laneMemo[engine]
  if (memo && memo.records === records && memo.info === info && memo.task === task) return memo.metrics
  const metrics = computeLaneMetrics(records, { categories: task.categories, run: info })
  laneMemo[engine] = { records, info, task, metrics }
  return metrics
}

/** Metrics of one lane for the current / last run; null before the first run. */
export function useLaneMetrics(engine: EngineId): LaneMetrics | null {
  const records = useBench((s) => s.lanes[engine].records)
  const info = useBench((s) => s.lanes[engine].info)
  const task = useBench((s) => s.run?.task)
  return useMemo(() => (task ? laneMetricsFor(engine, records, info, task) : null), [engine, records, info, task])
}

/** GPT vs Jev comparison (rows, pillar verdicts, overall verdict, paired test, validity); null until both lanes have records. */
export function useComparison(): Comparison | null {
  const gpt = useLaneMetrics('gpt')
  const jev = useLaneMetrics('jev')
  const gptRecords = useBench((s) => s.lanes.gpt.records)
  const jevRecords = useBench((s) => s.lanes.jev.records)
  return useMemo(() => {
    if (!gpt || !jev || gptRecords.length === 0 || jevRecords.length === 0) return null
    return compareLanes({ gpt: { metrics: gpt, records: gptRecords }, jev: { metrics: jev, records: jevRecords } })
  }, [gpt, jev, gptRecords, jevRecords])
}
