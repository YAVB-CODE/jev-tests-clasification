/** Test factories: build ClassificationRecord / LaneRunInfo with only the fields a test cares about. */
import type { Category, ClassificationRecord, EngineId, LaneRunInfo } from '../../shared/contracts.ts'

/** A small task: A and B share a group, C has its own, D has none. */
export const CATEGORIES: Category[] = [
  { id: 'A', name: 'Alfa', description: '', group: 'G1' },
  { id: 'B', name: 'Beta', description: '', group: 'G1' },
  { id: 'C', name: 'Gamma', description: '', group: 'G2' },
  { id: 'D', name: 'Delta', description: '' },
]

export type RecordSpec = Partial<ClassificationRecord>

/**
 * Defaults: GPT, live, status 'ok', item `item-<index>`, repetition 0, expected 'A', predicted =
 * expected (null when status ≠ 'ok'), latency 1000 ms. `correct` is derived unless given.
 */
export function makeRecord(spec: RecordSpec = {}): ClassificationRecord {
  const index = spec.index ?? 0
  const status = spec.status ?? 'ok'
  const expected = spec.expected ?? 'A'
  const predicted = status === 'ok' ? (spec.predicted === undefined ? expected : spec.predicted) : null
  const latencyMs = spec.latencyMs ?? 1000
  const startedAt = spec.startedAt ?? index * 1000
  return {
    engine: 'gpt',
    mode: 'live',
    model: 'test-model',
    itemId: `item-${index}`,
    repetition: 0,
    ...spec,
    index,
    status,
    expected,
    predicted,
    correct: spec.correct ?? (predicted !== null && predicted === expected),
    latencyMs,
    startedAt,
    finishedAt: spec.finishedAt ?? startedAt + latencyMs,
  }
}

/** Shorthand: answered record at `index`, right or wrong, with a confidence. */
export function answer(index: number, correct: boolean, confidence?: number, extra: RecordSpec = {}): ClassificationRecord {
  return makeRecord({ index, expected: 'A', predicted: correct ? 'A' : 'B', confidence, ...extra })
}

export interface LaneSpec {
  engine: EngineId
  /** Correctness per item (index = position). */
  correct: readonly boolean[]
  /** Confidence per item, or one value for all. */
  confidence?: number | readonly number[]
  /** Latency per item, or one value for all. */
  latencyMs?: number | readonly number[]
  mode?: 'live' | 'mock'
  extra?: RecordSpec
}

function at<T>(v: T | readonly T[] | undefined, i: number): T | undefined {
  return Array.isArray(v) ? (v as readonly T[])[i] : (v as T | undefined)
}

/** One record per item; items are shared across lanes by index (`item-<i>`). */
export function makeLane(spec: LaneSpec): ClassificationRecord[] {
  return spec.correct.map((ok, i) =>
    makeRecord({
      engine: spec.engine,
      mode: spec.mode ?? 'live',
      index: i,
      expected: 'A',
      predicted: ok ? 'A' : 'B',
      confidence: at(spec.confidence, i),
      latencyMs: at(spec.latencyMs, i) ?? 1000,
      startedAt: 0,
      ...spec.extra,
    }),
  )
}

export function makeRun(engine: EngineId, total: number, extra: Partial<LaneRunInfo> = {}): LaneRunInfo {
  return { engine, mode: 'live', model: 'test-model', status: 'done', total, ...extra }
}

/** `n` booleans with the first `k` true. */
export function hits(k: number, n: number): boolean[] {
  return Array.from({ length: n }, (_, i) => i < k)
}
