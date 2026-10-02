/**
 * Pure metrics engine for ONE lane: ClassificationRecord[] (+ the lane's run info) → LaneMetrics.
 * No React, no I/O, no clock: safe to call on every streamed record and to unit test.
 *
 * Conventions
 *  - Records are deduplicated by slot (itemId + repetition; the later one wins).
 *  - Rates are fractions in [0, 1]; a metric with an empty denominator is `null` (never NaN).
 *  - "Answered" = status 'ok' with a category id; "correct" is recomputed (see records.ts).
 */
import type { Category, ClassificationRecord, EngineId, EngineMode, LaneRunInfo, LaneStatus } from '../shared/contracts.ts'
import { computeReliability, type ReliabilityMetrics } from './calibration.ts'
import { dedupeRecords, isAnswered, isCorrect, unique } from './records.ts'
import { computeScore, type ScoreMetrics } from './score.ts'
import { ratio } from './stats.ts'
import { computeCost, computeTiming, type CostMetrics, type TimingMetrics } from './timing.ts'

export interface LaneCounts {
  /** Classifications scheduled (`run.total`), or `completed` without run info. */
  scheduled: number
  /** Records received (after deduplication). */
  completed: number
  /** scheduled − completed (≥ 0). */
  pending: number
  /** completed / scheduled. */
  progress: number | null
  ok: number
  invalid: number
  error: number
  timeout: number
  /** status 'ok' with a category id. */
  answered: number
  correct: number
  /** answered / completed. */
  validRate: number | null
  /** (error + timeout) / completed: operational failures (not the model's answer). */
  failureRate: number | null
  /** Distinct items / distinct repetitions seen. */
  items: number
  repetitions: number
  /** Records dropped because their slot (itemId + repetition) appeared again. */
  duplicates: number
  /**
   * Records started after the lane's first pass ended (`run.finishedAt`, which «Reintentar fallidos»
   * keeps): second chances, timed under other load conditions. 0 without run info.
   */
  rerun: number
}

export interface LaneMetrics {
  engine: EngineId | null
  /** Lane mode; 'mixed' when records (or run info) disagree. */
  mode: EngineMode | 'mixed' | null
  /** Configured model (`run.model`), else the first record's. */
  model: string | null
  /** Distinct models that answered (from the records). */
  models: string[]
  runStatus: LaneStatus | null
  counts: LaneCounts
  score: ScoreMetrics
  reliability: ReliabilityMetrics
  timing: TimingMetrics
  cost: CostMetrics
}

export interface LaneMetricsContext {
  categories: readonly Category[]
  run?: LaneRunInfo
}

/**
 * Distinct models that actually answered. Records that never got a provider answer (client-side
 * timeout / cancelled / network or HTTP error) carry the REQUESTED model id (e.g. "gpt-4.1-mini"),
 * while real answers carry the id the provider resolved (e.g. "gpt-4.1-mini-2025-04-14"): counting
 * both would report two models for one lane. Falls back to every record when none answered.
 */
function respondingModels(records: readonly ClassificationRecord[]): string[] {
  const answeredByProvider = records.filter((r) => r.status === 'ok' || r.status === 'invalid')
  return unique((answeredByProvider.length > 0 ? answeredByProvider : records).map((r) => r.model))
}

export function computeLaneMetrics(input: readonly ClassificationRecord[], ctx: LaneMetricsContext): LaneMetrics {
  const { records, duplicates } = dedupeRecords(input)
  const run = ctx.run
  const completed = records.length

  let ok = 0
  let invalid = 0
  let error = 0
  let timeout = 0
  let answered = 0
  let correct = 0
  for (const r of records) {
    if (r.status === 'ok') ok += 1
    else if (r.status === 'invalid') invalid += 1
    else if (r.status === 'error') error += 1
    else if (r.status === 'timeout') timeout += 1
    if (isAnswered(r)) answered += 1
    if (isCorrect(r)) correct += 1
  }
  const scheduled = run && Number.isFinite(run.total) && run.total > 0 ? run.total : completed
  const firstPassEnd = run?.finishedAt
  const rerun = typeof firstPassEnd === 'number' && Number.isFinite(firstPassEnd) ? records.filter((r) => r.startedAt > firstPassEnd).length : 0

  const modes = unique([...(run ? [run.mode] : []), ...records.map((r) => r.mode)])

  return {
    engine: run?.engine ?? records[0]?.engine ?? null,
    mode: modes.length === 0 ? null : modes.length === 1 ? modes[0] : 'mixed',
    model: run?.model ?? records[0]?.model ?? null,
    models: respondingModels(records),
    runStatus: run?.status ?? null,
    counts: {
      scheduled,
      completed,
      pending: Math.max(0, scheduled - completed),
      progress: ratio(completed, scheduled),
      ok,
      invalid,
      error,
      timeout,
      answered,
      correct,
      validRate: ratio(answered, completed),
      failureRate: ratio(error + timeout, completed),
      items: new Set(records.map((r) => r.itemId)).size,
      repetitions: new Set(records.map((r) => r.repetition)).size,
      duplicates,
      rerun,
    },
    score: computeScore(records, ctx.categories),
    reliability: computeReliability(records, ctx.categories),
    timing: computeTiming(records, run),
    cost: computeCost(records),
  }
}
