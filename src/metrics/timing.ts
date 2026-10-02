/**
 * Time pillar and (informative) cost.
 *
 *  - `latency` = `latencyMs` of EVERY completed record (end to end, measured in the browser):
 *    a timeout costs the user its full wait, so failures are not dropped. A lane failing fast is
 *    flagged by the comparison's validity warnings instead.
 *  - `providerLatency` = `providerLatencyMs` where reported (server-side, includes retries).
 *  - Percentiles use linear interpolation (type 7, see `stats.percentile`); std is the sample std.
 *  - Wall time = run.finishedAt − run.startedAt; each missing bound falls back to the records
 *    (min startedAt / max finishedAt), so a running lane reports the time up to its last record.
 *  - Cost: a record "should be billed" when the provider answered (status ok | invalid). The USD
 *    total is undefined when any such record lacks `costUsd`; errors / timeouts without a cost are
 *    assumed unbilled and do not make it incomplete.
 */
import type { ClassificationRecord, LaneRunInfo } from '../shared/contracts.ts'
import { isFiniteNumber, ratio, summarize, type LatencyStats } from './stats.ts'

export interface TimingMetrics {
  /** End-to-end latency (`latencyMs`) over every completed record. */
  latency: LatencyStats | null
  /** Provider latency (`providerLatencyMs`) over the records that report it. */
  providerLatency: LatencyStats | null
  /** Batch wall-clock time, in ms. */
  wallTimeMs: number | null
  /** Completed classifications per minute of wall time. */
  throughputPerMin: number | null
}

export interface CostMetrics {
  inputTokens: number
  outputTokens: number
  /** Records that report token usage. */
  usageRecords: number
  /** Total USD; undefined when some billable record (ok | invalid) has no cost (see `costComplete`). */
  costUsd: number | undefined
  /** Sum of the costs that are known (always defined). */
  knownCostUsd: number
  /** costUsd / completed records. */
  costPerClassificationUsd: number | undefined
  /** Every billable record carries a cost. */
  costComplete: boolean
  /** Records that carry a cost. */
  costedRecords: number
  /** Some usage / cost is an estimate (mock engines). */
  estimated: boolean
}

export function computeTiming(records: readonly ClassificationRecord[], run?: LaneRunInfo): TimingMetrics {
  let minStart = Number.POSITIVE_INFINITY
  let maxEnd = Number.NEGATIVE_INFINITY
  for (const r of records) {
    if (isFiniteNumber(r.startedAt)) minStart = Math.min(minStart, r.startedAt)
    if (isFiniteNumber(r.finishedAt)) maxEnd = Math.max(maxEnd, r.finishedAt)
  }
  const start = isFiniteNumber(run?.startedAt) ? run.startedAt : minStart
  const end = isFiniteNumber(run?.finishedAt) ? run.finishedAt : maxEnd
  const wallTimeMs = Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null

  return {
    latency: summarize(records.map((r) => r.latencyMs)),
    providerLatency: summarize(records.filter((r) => isFiniteNumber(r.providerLatencyMs)).map((r) => r.providerLatencyMs as number)),
    wallTimeMs,
    throughputPerMin: wallTimeMs !== null && wallTimeMs > 0 ? ratio(records.length, wallTimeMs / 60_000) : null,
  }
}

export function computeCost(records: readonly ClassificationRecord[]): CostMetrics {
  let inputTokens = 0
  let outputTokens = 0
  let usageRecords = 0
  let knownCostUsd = 0
  let costedRecords = 0
  let costComplete = true
  let estimated = false
  for (const r of records) {
    if (r.usage) {
      usageRecords += 1
      inputTokens += isFiniteNumber(r.usage.inputTokens) ? r.usage.inputTokens : 0
      outputTokens += isFiniteNumber(r.usage.outputTokens) ? r.usage.outputTokens : 0
    }
    if (isFiniteNumber(r.costUsd)) {
      knownCostUsd += r.costUsd
      costedRecords += 1
    } else if (r.status === 'ok' || r.status === 'invalid') {
      costComplete = false
    }
    if (r.estimated) estimated = true
  }
  const costUsd = costComplete && costedRecords > 0 ? knownCostUsd : undefined
  return {
    inputTokens,
    outputTokens,
    usageRecords,
    costUsd,
    knownCostUsd,
    costPerClassificationUsd: costUsd !== undefined ? (ratio(costUsd, records.length) ?? undefined) : undefined,
    costComplete: costComplete && costedRecords > 0,
    costedRecords,
    estimated,
  }
}
