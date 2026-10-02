/**
 * Lane runner: executes a run plan against one engine with a small concurrency pool.
 *
 * Fairness: both lanes get the same plan, the same `concurrency` (1–3: two lanes × 3 = 6, the
 * browser's HTTP/1.1 connections per origin, so no request waits in the browser queue and
 * inflates latency) and the same `timeoutMs`. `runLane` starts its first calls synchronously,
 * so two lanes launched back to back start in the same tick.
 *
 * Each call gets its own AbortController linked to the run signal plus a timeout. Latency is
 * end to end, measured with `performance.now()` around `engine.classify`. Calls cut by the run
 * abort produce NO record; calls cut by the timeout produce a 'timeout' record.
 */
import {
  BENCH_LIMITS,
  CONCURRENCY_OPTIONS,
  type BenchConcurrency,
  type Category,
  type ClassificationRecord,
  type ClassificationTask,
  type ClassifyResult,
  type ConceptInput,
} from '../shared/contracts.ts'
import { matchCategoryId, toConceptInput } from '../shared/task.ts'
import { createAbortError, createTimeoutError, failedResult } from '../engines/abort.ts'
import { SERVER_DEFAULT_MODEL } from '../engines/labels.ts'
import type { Engine } from '../engines/types.ts'
import type { PlannedItem } from './plan.ts'

export const MAX_LANE_CONCURRENCY: BenchConcurrency = CONCURRENCY_OPTIONS[CONCURRENCY_OPTIONS.length - 1]

/** Clamps to the allowed per-lane concurrency (1..3). */
export function clampConcurrency(value: number): BenchConcurrency {
  const n = Number.isFinite(value) ? Math.floor(value) : 1
  return Math.min(MAX_LANE_CONCURRENCY, Math.max(1, n)) as BenchConcurrency
}

/** Clamps a per-call timeout to BENCH_LIMITS. */
export function clampTimeoutMs(value: number): number {
  const n = Number.isFinite(value) ? Math.round(value) : BENCH_LIMITS.maxTimeoutMs
  return Math.min(BENCH_LIMITS.maxTimeoutMs, Math.max(BENCH_LIMITS.minTimeoutMs, n))
}

function formatSeconds(ms: number): string {
  const s = Math.round(ms / 100) / 10
  return `${String(s).replace('.', ',')} s`
}

export function timeoutMessage(timeoutMs: number): string {
  return `Tiempo agotado: sin respuesta en ${formatSeconds(timeoutMs)}`
}

// ─────────────────────────────── Grading ────────────────────────────────

export interface GradeTiming {
  /** End to end, in ms. */
  latencyMs: number
  /** epoch ms */
  startedAt: number
  /** epoch ms */
  finishedAt: number
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/**
 * Turns an engine result into a graded record. `correct` = predicted === expected (only for
 * status 'ok'); `groupCorrect` compares `Category.group` (undefined if either side has no group
 * or there is no prediction). An 'ok' answer outside the category set becomes 'invalid'.
 * Confidence / probabilities are kept only when there is a prediction; usage / cost always.
 */
export function gradeResult(
  result: ClassifyResult,
  planned: PlannedItem,
  categories: readonly Category[],
  timing: GradeTiming,
): ClassificationRecord {
  const { item } = planned
  const ids = categories.map((c) => c.id)
  let status = result.status
  let errorMessage = result.errorMessage
  let predicted: string | null = null
  if (status === 'ok') {
    predicted = matchCategoryId(result.answer?.categoryId, ids)
    if (predicted === null) {
      status = 'invalid'
      errorMessage = errorMessage ?? 'La respuesta no es una de las categorías de la tarea'
    }
  }

  const record: ClassificationRecord = {
    engine: result.engine,
    mode: result.mode,
    model: result.model,
    itemId: item.id,
    index: planned.index,
    repetition: planned.repetition,
    expected: item.expected,
    predicted,
    correct: predicted !== null && predicted === item.expected,
    status,
    latencyMs: Math.max(0, timing.latencyMs),
    startedAt: timing.startedAt,
    finishedAt: timing.finishedAt,
  }

  if (predicted !== null) {
    const predictedGroup = categories.find((c) => c.id === predicted)?.group
    const expectedGroup = categories.find((c) => c.id === item.expected)?.group
    if (predictedGroup && expectedGroup) record.groupCorrect = predictedGroup === expectedGroup
    const answer = result.answer
    if (isProbability(answer.confidence)) record.confidence = answer.confidence
    if (answer.probabilities !== undefined) record.probabilities = { ...answer.probabilities }
    if (isProbability(answer.nativeConfidence)) record.nativeConfidence = answer.nativeConfidence
    if (answer.nativeConfidenceKind !== undefined) record.nativeConfidenceKind = answer.nativeConfidenceKind
  }
  if (result.providerLatencyMs !== undefined) record.providerLatencyMs = result.providerLatencyMs
  if (result.usage !== undefined) record.usage = { ...result.usage }
  if (result.costUsd !== undefined) record.costUsd = result.costUsd
  if (result.estimated !== undefined) record.estimated = result.estimated
  if (errorMessage !== undefined && status !== 'ok') record.errorMessage = errorMessage
  if (item.difficulty !== undefined) record.difficulty = item.difficulty
  if (result.attempts !== undefined) record.attempts = result.attempts.map((a) => ({ ...a }))
  if (result.raw !== undefined) record.raw = result.raw
  return record
}

// ─────────────────────────────── One call ────────────────────────────────

export interface ClassifyOnceOptions {
  engine: Engine
  task: ClassificationTask
  item: ConceptInput
  timeoutMs: number
  model?: string
  repetition?: number
  /** Cancels the call (run stopped / superseded). */
  signal: AbortSignal
  /** epoch ms clock. Defaults to Date.now. */
  now?: () => number
  /** Monotonic clock for latency. Defaults to performance.now. */
  perfNow?: () => number
}

export interface TimedResult {
  result: ClassifyResult
  latencyMs: number
  startedAt: number
  finishedAt: number
  /** Why the call was cut short: 'timeout' (→ status 'timeout'), 'abort' (outer signal) or null. */
  cut: 'timeout' | 'abort' | null
}

const defaultPerfNow = (): number => performance.now()

/**
 * One timed classification with timeout. Never throws. Also guards against engines that ignore
 * the signal (the call is raced against its own abort).
 */
export async function classifyOnce(opts: ClassifyOnceOptions): Promise<TimedResult> {
  const { engine, signal, timeoutMs } = opts
  const now = opts.now ?? Date.now
  const perfNow = opts.perfNow ?? defaultPerfNow
  const fallbackModel = engine.model ?? (opts.model || SERVER_DEFAULT_MODEL)
  const startedAt = now()
  const t0 = perfNow()

  if (signal.aborted) {
    const result = failedResult(engine.id, engine.mode, fallbackModel, 'error', 'Clasificación cancelada')
    return { result, latencyMs: 0, startedAt, finishedAt: startedAt, cut: 'abort' }
  }

  const controller = new AbortController()
  // `as` keeps TS from narrowing to null: the closures below assign it.
  let cut = null as TimedResult['cut']
  const onOuterAbort = (): void => {
    if (cut !== null) return
    cut = 'abort'
    controller.abort(createAbortError())
  }
  signal.addEventListener('abort', onOuterAbort, { once: true })
  const timer = setTimeout(() => {
    if (cut !== null) return
    cut = 'timeout'
    controller.abort(createTimeoutError(timeoutMessage(timeoutMs)))
  }, timeoutMs)
  const cutShort = new Promise<null>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve(null), { once: true })
  })

  let result: ClassifyResult | null
  try {
    const call = engine.classify(opts.task, opts.item, { signal: controller.signal, model: opts.model, repetition: opts.repetition })
    // A late rejection (after the race settled) must not surface as unhandled.
    call.catch(() => undefined)
    result = await Promise.race([call, cutShort])
  } catch (error) {
    // Engines must not throw; keep the lane going anyway.
    const detail = error instanceof Error ? error.message : String(error)
    result = failedResult(engine.id, engine.mode, fallbackModel, 'error', `Error inesperado del motor: ${detail}`)
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onOuterAbort)
  }

  const latencyMs = perfNow() - t0
  const finishedAt = now()
  const model = result?.model || fallbackModel
  if (cut === 'timeout') {
    result = failedResult(engine.id, engine.mode, model, 'timeout', timeoutMessage(timeoutMs), {
      ...(result?.attempts ? { attempts: result.attempts } : {}),
    })
  } else if (cut === 'abort' || result === null) {
    result = failedResult(engine.id, engine.mode, model, 'error', 'Clasificación cancelada')
  }
  return { result, latencyMs, startedAt, finishedAt, cut }
}

// ─────────────────────────────── Lane ────────────────────────────────

export interface RunLaneOptions {
  engine: Engine
  task: ClassificationTask
  plan: readonly PlannedItem[]
  /** Simultaneous calls in this lane (clamped to 1..3). */
  concurrency: number
  /** Per-call timeout (same for both lanes). */
  timeoutMs: number
  /** Live model picked in the UI. */
  model?: string
  /** Run signal: aborting it stops the lane (no new calls; in-flight calls are cancelled, without record). */
  signal: AbortSignal
  /** Called once per finished classification, in completion order. */
  onRecord: (record: ClassificationRecord) => void
  /** epoch ms clock (record startedAt / finishedAt). Defaults to Date.now. */
  now?: () => number
  /** Monotonic clock for latency. Defaults to performance.now. */
  perfNow?: () => number
}

export interface RunLaneSummary {
  /** Records emitted. */
  completed: number
  /** Planned calls not recorded (run aborted). */
  skipped: number
  aborted: boolean
}

export async function runLane(opts: RunLaneOptions): Promise<RunLaneSummary> {
  const { engine, task, plan, signal, onRecord } = opts
  const concurrency = clampConcurrency(opts.concurrency)
  const timeoutMs = clampTimeoutMs(opts.timeoutMs)
  let next = 0
  let completed = 0

  const worker = async (): Promise<void> => {
    while (!signal.aborted && next < plan.length) {
      const planned = plan[next++]
      const timed = await classifyOnce({
        engine,
        task,
        // Defense in depth: engines only ever get the label-free item.
        item: toConceptInput(planned.item),
        timeoutMs,
        model: opts.model,
        repetition: planned.repetition,
        signal,
        now: opts.now,
        perfNow: opts.perfNow,
      })
      if (timed.cut === 'abort') return
      const record = gradeResult(timed.result, planned, task.categories, timed)
      completed++
      try {
        onRecord(record)
      } catch (error) {
        console.error('[runner] onRecord falló', error)
      }
    }
  }

  // Workers start synchronously: the first `concurrency` calls are issued in this tick.
  const workers = Array.from({ length: Math.min(concurrency, plan.length) }, () => worker())
  await Promise.all(workers)
  return { completed, skipped: plan.length - completed, aborted: signal.aborted }
}
