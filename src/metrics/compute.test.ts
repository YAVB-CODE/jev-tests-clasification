import { describe, expect, it } from 'vitest'
import type { ClassificationRecord } from '../shared/contracts.ts'
import { CATEGORIES, answer, makeRecord, makeRun } from './__fixtures__/makeRecord.ts'
import { binIndex, computeCalibration, riskCoverage } from './calibration.ts'
import { computeLaneMetrics } from './compute.ts'

const ctx = { categories: CATEGORIES }

/** Every number in a value is finite (no NaN / Infinity). */
function expectAllFinite(value: unknown, path = 'metrics'): void {
  if (typeof value === 'number') expect(Number.isFinite(value), `${path} = ${value}`).toBe(true)
  else if (Array.isArray(value)) value.forEach((v, i) => expectAllFinite(v, `${path}[${i}]`))
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) expectAllFinite(v, `${path}.${k}`)
}

describe('computeLaneMetrics — empty input', () => {
  it('returns nulls / zeros and never NaN', () => {
    const m = computeLaneMetrics([], ctx)
    expectAllFinite(m)
    expect(m.engine).toBeNull()
    expect(m.mode).toBeNull()
    expect(m.counts).toMatchObject({ scheduled: 0, completed: 0, pending: 0, progress: null, validRate: null })
    expect(m.score.accuracy).toBeNull()
    expect(m.score.accuracyCi).toBeNull()
    expect(m.score.macroF1).toBeNull()
    expect(m.score.perCategory).toHaveLength(4)
    expect(m.reliability.brier).toBeNull()
    expect(m.reliability.ece).toBeNull()
    expect(m.reliability.auroc).toBeNull()
    expect(m.reliability.bins).toHaveLength(10)
    expect(m.reliability.consistency).toBeNull()
    expect(m.timing.latency).toBeNull()
    expect(m.timing.wallTimeMs).toBeNull()
    expect(m.cost.costUsd).toBeUndefined()
  })
})

describe('score', () => {
  it('all correct', () => {
    const records = [0, 1, 2, 3].map((i) =>
      makeRecord({ index: i, expected: CATEGORIES[i].id, predicted: CATEGORIES[i].id, confidence: 0.9 }),
    )
    const s = computeLaneMetrics(records, ctx).score
    expect(s.accuracy).toBe(1)
    expect(s.accuracyOnValid).toBe(1)
    expect(s.macroF1).toBe(1)
    expect(s.weightedF1).toBe(1)
    expect(s.accuracyCi!.hi).toBe(1)
    expect(s.accuracyCi!.lo).toBeCloseTo(0.5101, 3) // Wilson 4/4
    expect(s.topConfusions).toEqual([])
    expect(s.confusion.matrix.map((row, i) => row[i])).toEqual([1, 1, 1, 1])
    // groupAccuracy only counts expected categories with a group (D has none).
    expect(s.groupTotal).toBe(3)
    expect(s.groupAccuracy).toBe(1)
  })

  it('all wrong', () => {
    const records = [0, 1, 2].map((i) => makeRecord({ index: i, expected: 'C', predicted: 'A', confidence: 0.9 }))
    const s = computeLaneMetrics(records, ctx).score
    expect(s.accuracy).toBe(0)
    expect(s.accuracyCi!.lo).toBe(0)
    expect(s.macroF1).toBe(0)
    expect(s.weightedF1).toBe(0)
    expect(s.groupAccuracy).toBe(0) // G2 → G1
    expect(s.topConfusions).toHaveLength(1)
    expect(s.topConfusions[0]).toMatchObject({ expected: 'C', predicted: 'A', count: 3, share: 1, sameGroup: false })
    expect(s.topConfusions[0].itemIds).toEqual(['item-0', 'item-1', 'item-2'])
  })

  it('computes per-category precision / recall / F1, macro and weighted F1 by hand', () => {
    const records = [
      makeRecord({ index: 0, expected: 'A', predicted: 'A', difficulty: 'easy' }),
      makeRecord({ index: 1, expected: 'A', predicted: 'A', difficulty: 'easy' }),
      makeRecord({ index: 2, expected: 'A', predicted: 'B', difficulty: 'medium' }),
      makeRecord({ index: 3, expected: 'B', predicted: 'B', difficulty: 'hard' }),
      makeRecord({ index: 4, expected: 'B', status: 'timeout', difficulty: 'hard' }),
      makeRecord({ index: 5, expected: 'C', predicted: 'A' }),
    ]
    const s = computeLaneMetrics(records, ctx).score
    const by = Object.fromEntries(s.perCategory.map((c) => [c.id, c]))

    expect(by.A).toMatchObject({ support: 3, predicted: 3, tp: 2 })
    expect(by.A.precision).toBeCloseTo(2 / 3, 12)
    expect(by.A.recall).toBeCloseTo(2 / 3, 12)
    expect(by.A.f1).toBeCloseTo(2 / 3, 12)
    expect(by.B).toMatchObject({ support: 2, predicted: 2, tp: 1, precision: 0.5, recall: 0.5, f1: 0.5 })
    expect(by.C).toMatchObject({ support: 1, predicted: 0, tp: 0, precision: null, recall: 0, f1: 0 })
    expect(by.D).toMatchObject({ support: 0, predicted: 0, precision: null, recall: null, f1: null })

    expect(s.accuracy).toBe(0.5)
    expect(s.accuracyOnValid).toBeCloseTo(3 / 5, 12)
    expect(s.macroF1).toBeCloseTo((2 / 3 + 0.5 + 0) / 3, 12) // D (support 0) excluded
    expect(s.weightedF1).toBeCloseTo((2 / 3) * 0.5 + 0.5 * (2 / 6), 12)
    // A→A ×2, A→B (same G1), B→B hit; B timeout, C→A miss
    expect(s.groupCorrect).toBe(4)
    expect(s.groupAccuracy).toBeCloseTo(4 / 6, 12)

    // rows = expected, last column = no answer
    expect(s.confusion.labels).toEqual(['A', 'B', 'C', 'D'])
    expect(s.confusion.noAnswerIndex).toBe(4)
    expect(s.confusion.matrix).toEqual([
      [2, 1, 0, 0, 0],
      [0, 1, 0, 0, 1],
      [1, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ])
    expect(s.topConfusions.map((c) => `${c.expected}>${c.predicted}`)).toEqual(['A>B', 'C>A'])
    expect(s.topConfusions[0].sameGroup).toBe(true)

    expect(s.byDifficulty.easy).toEqual({ n: 2, correct: 2, accuracy: 1 })
    expect(s.byDifficulty.medium).toEqual({ n: 1, correct: 0, accuracy: 0 })
    expect(s.byDifficulty.hard).toEqual({ n: 2, correct: 1, accuracy: 0.5 })
    expect(s.withoutDifficulty).toBe(1)
  })

  it('appends unknown category ids after the task ones', () => {
    const s = computeLaneMetrics([makeRecord({ expected: 'Z', predicted: 'A' })], ctx).score
    expect(s.confusion.labels).toEqual(['A', 'B', 'C', 'D', 'Z'])
    expect(s.perCategory[4]).toMatchObject({ id: 'Z', name: 'Z', support: 1 })
  })

  it('recomputes correctness instead of trusting the record flag', () => {
    const s = computeLaneMetrics([makeRecord({ expected: 'A', predicted: 'B', correct: true })], ctx).score
    expect(s.accuracy).toBe(0)
  })
})

describe('counts — invalid, error and timeout', () => {
  const records = [
    answer(0, true, 0.9),
    answer(1, false, 0.7),
    makeRecord({ index: 2, status: 'invalid' }),
    makeRecord({ index: 3, status: 'error' }),
    makeRecord({ index: 4, status: 'timeout', latencyMs: 30_000 }),
  ]
  const m = computeLaneMetrics(records, { ...ctx, run: makeRun('gpt', 8, { status: 'running' }) })

  it('counts statuses and rates', () => {
    expect(m.counts).toMatchObject({
      scheduled: 8,
      completed: 5,
      pending: 3,
      ok: 2,
      invalid: 1,
      error: 1,
      timeout: 1,
      answered: 2,
      correct: 1,
      items: 5,
      repetitions: 1,
      duplicates: 0,
    })
    expect(m.counts.progress).toBeCloseTo(5 / 8, 12)
    expect(m.counts.validRate).toBeCloseTo(2 / 5, 12)
    expect(m.counts.failureRate).toBeCloseTo(2 / 5, 12)
    expect(m.reliability.validRate).toBeCloseTo(2 / 5, 12)
    expect(m.runStatus).toBe('running')
  })

  it('counts failures as misses in accuracy but not in accuracyOnValid', () => {
    expect(m.score.accuracy).toBeCloseTo(1 / 5, 12)
    expect(m.score.accuracyOnValid).toBe(0.5)
    expect(m.score.confusion.matrix[0][m.score.confusion.noAnswerIndex]).toBe(3)
    expect(m.score.perCategory[0].support).toBe(5)
  })

  it('keeps failures out of calibration but includes them in brierAllRecords as (0, 0)', () => {
    // answered: (0.9 right) → 0.01, (0.7 wrong) → 0.49
    expect(m.reliability.n).toBe(2)
    expect(m.reliability.brier).toBeCloseTo(0.25, 12)
    expect(m.reliability.brierAllRecords).toBeCloseTo(0.5 / 5, 12)
    expect(m.reliability.confidenceCoverage).toBe(1)
  })

  it('includes timeouts in the end-to-end latency', () => {
    expect(m.timing.latency!.count).toBe(5)
    expect(m.timing.latency!.max).toBe(30_000)
  })
})

describe('deduplication', () => {
  it('keeps the last record of a repeated slot', () => {
    const m = computeLaneMetrics(
      [makeRecord({ index: 0, status: 'timeout' }), makeRecord({ index: 0, predicted: 'A' })],
      ctx,
    )
    expect(m.counts.completed).toBe(1)
    expect(m.counts.duplicates).toBe(1)
    expect(m.score.accuracy).toBe(1)
  })
})

describe('reliability — calibration by hand', () => {
  // (confidence, correct): bins 9, 9, 6, 6, 1, 9
  const pairs: [number, boolean][] = [
    [0.95, true],
    [0.95, false],
    [0.65, true],
    [0.62, false],
    [0.15, false],
    [1.0, true],
  ]
  const records = pairs.map(([c, ok], i) => answer(i, ok, c))
  const r = computeLaneMetrics(records, ctx).reliability

  it('fills 10 equal-width bins', () => {
    expect(r.bins).toHaveLength(10)
    expect(r.bins.map((b) => b.count)).toEqual([0, 1, 0, 0, 0, 0, 2, 0, 0, 3])
    expect(r.bins[9].meanConfidence).toBeCloseTo((0.95 + 0.95 + 1) / 3, 12)
    expect(r.bins[9].accuracy).toBeCloseTo(2 / 3, 12)
    expect(r.bins[9].gap).toBeCloseTo(-0.3, 12)
    expect(r.bins[6].meanConfidence).toBeCloseTo(0.635, 12)
    expect(r.bins[6].accuracy).toBe(0.5)
    expect(r.bins[0]).toMatchObject({ lo: 0, hi: 0.1, count: 0, meanConfidence: null, accuracy: null, gap: null })
  })

  it('computes ECE, MCE and Brier', () => {
    // ECE = 3/6·0.3 + 2/6·0.135 + 1/6·0.15 = 0.22
    expect(r.ece).toBeCloseTo(0.22, 12)
    expect(r.mce).toBeCloseTo(0.3, 12)
    // (0.05² + 0.95² + 0.35² + 0.62² + 0.15² + 0²) / 6
    expect(r.brier).toBeCloseTo(1.4344 / 6, 12)
  })

  it('computes AUROC, mean confidences and overconfident errors', () => {
    expect(r.auroc).toBeCloseTo(7.5 / 9, 12)
    expect(r.meanConfidenceCorrect).toBeCloseTo((0.95 + 0.65 + 1) / 3, 12)
    expect(r.meanConfidenceWrong).toBeCloseTo((0.95 + 0.62 + 0.15) / 3, 12)
    expect(r.overconfidentErrors).toMatchObject({ threshold: 0.8, count: 1 })
    expect(r.overconfidentErrors.rate).toBeCloseTo(1 / 6, 12)
    expect(r.overconfidentErrors.shareOfErrors).toBeCloseTo(1 / 3, 12)
  })

  it('computes the risk–coverage curve, averaging ties at the cut', () => {
    const at = (c: number) => r.riskCoverage.find((p) => Math.abs(p.coverage - c) < 1e-9)!
    expect(at(0.1)).toMatchObject({ count: 1, accuracy: 1, threshold: 1 })
    // top 2 = 1.0 (right) + half of the 0.95 pair (one right, one wrong)
    expect(at(0.2).count).toBe(2)
    expect(at(0.2).accuracy).toBeCloseTo(0.75, 12)
    expect(at(0.2).threshold).toBe(0.95)
    expect(at(0.5).accuracy).toBeCloseTo(2 / 3, 12)
    expect(at(1)).toMatchObject({ count: 6, accuracy: 0.5, risk: 0.5, threshold: 0.15 })
  })

  it('does not depend on input order', () => {
    const shuffled = computeLaneMetrics([...records].reverse(), ctx).reliability
    expect(shuffled.riskCoverage).toEqual(r.riskCoverage)
    expect(shuffled.ece).toBeCloseTo(r.ece!, 12)
  })
})

describe('reliability — edge cases', () => {
  it('bins edges: 0.7 → bin 7, 1 → last bin, 0 → first', () => {
    expect(binIndex(0.7)).toBe(7)
    expect(binIndex(0.1)).toBe(1)
    expect(binIndex(1)).toBe(9)
    expect(binIndex(0)).toBe(0)
    expect(binIndex(0.0999)).toBe(0)
  })

  it('without confidence: no calibration, coverage 0', () => {
    const r = computeLaneMetrics([answer(0, true), answer(1, false)], ctx).reliability
    expect(r.n).toBe(0)
    expect(r.brier).toBeNull()
    expect(r.ece).toBeNull()
    expect(r.mce).toBeNull()
    expect(r.auroc).toBeNull()
    expect(r.confidenceCoverage).toBe(0)
    expect(r.riskCoverage).toEqual([])
    expect(r.bins.every((b) => b.count === 0)).toBe(true)
  })

  it('a single class gives AUROC null but a defined Brier', () => {
    const r = computeLaneMetrics([answer(0, true, 0.9), answer(1, true, 0.6)], ctx).reliability
    expect(r.auroc).toBeNull()
    expect(r.brier).toBeCloseTo((0.01 + 0.16) / 2, 12)
    expect(r.meanConfidenceWrong).toBeNull()
    expect(r.overconfidentErrors.shareOfErrors).toBeNull()
  })

  it('clamps out-of-range confidences for Brier and reports them', () => {
    const c = computeCalibration([
      { confidence: 1.4, correct: true },
      { confidence: -0.2, correct: false },
    ])
    expect(c.brier).toBe(0)
    expect(c.outOfRange).toBe(2)
    expect(c.auroc).toBe(1)
  })

  it('partial confidence coverage', () => {
    const r = computeLaneMetrics([answer(0, true, 0.9), answer(1, false), answer(2, true, 0.8)], ctx).reliability
    expect(r.withConfidence).toBe(2)
    expect(r.confidenceCoverage).toBeCloseTo(2 / 3, 12)
  })

  it('riskCoverage handles a single point', () => {
    expect(riskCoverage([{ confidence: 0.4, correct: false }])[0]).toMatchObject({ count: 1, accuracy: 0, risk: 1 })
  })

  it('multiclass Brier from probabilities (missing classes = 0)', () => {
    const rec = answer(0, true, 0.7, { probabilities: { A: 0.7, B: 0.2, C: 0.1 } })
    const r = computeLaneMetrics([rec, answer(1, true, 0.9)], ctx).reliability
    expect(r.multiclassBrierN).toBe(1)
    expect(r.multiclassBrier).toBeCloseTo(0.09 + 0.04 + 0.01, 12)
  })

  it('native confidence is analysed separately and reports its kind', () => {
    const records = [
      answer(0, true, 0.9, { nativeConfidence: 0.99, nativeConfidenceKind: 'logprob' }),
      answer(1, false, 0.9, { nativeConfidence: 0.4, nativeConfidenceKind: 'logprob' }),
    ]
    const r = computeLaneMetrics(records, ctx).reliability
    expect(r.native.kind).toBe('logprob')
    expect(r.native.probabilistic).toBe(true)
    expect(r.native.n).toBe(2)
    expect(r.native.auroc).toBe(1)
    expect(r.native.coverage).toBe(1)
    expect(r.auroc).toBe(0.5) // the comparable signal ties

    const mixed = computeLaneMetrics(
      [records[0], answer(2, true, 0.5, { nativeConfidence: 3.2, nativeConfidenceKind: 'jev_confidence' })],
      ctx,
    ).reliability.native
    expect(mixed.kind).toBe('mixed')
    expect(mixed.probabilistic).toBe(false)
    expect(mixed.outOfRange).toBe(1)

    expect(computeLaneMetrics([answer(0, true, 0.9)], ctx).reliability.native).toMatchObject({ kind: null, n: 0, coverage: 0 })
  })
})

describe('consistency across repetitions', () => {
  const rep = (index: number, repetition: number, spec: Partial<ClassificationRecord>) =>
    makeRecord({ index, itemId: `item-${index}`, repetition, expected: 'A', ...spec })

  it('is null without repetitions', () => {
    expect(computeLaneMetrics([answer(0, true, 0.9)], ctx).reliability.consistency).toBeNull()
  })

  it('measures agreement and the spread of accuracy between repetitions', () => {
    const records = [
      rep(0, 0, { predicted: 'A' }),
      rep(0, 1, { predicted: 'A' }), // consistent (right twice)
      rep(1, 0, { predicted: 'A' }),
      rep(1, 1, { predicted: 'B' }), // changes its mind
      rep(2, 0, { predicted: 'B' }),
      rep(2, 1, { status: 'timeout' }), // answer vs no answer
      rep(3, 0, { status: 'error' }),
      rep(3, 1, { status: 'timeout' }), // no answer twice = same output
    ]
    const m = computeLaneMetrics(records, ctx)
    const c = m.reliability.consistency!
    expect(m.counts.items).toBe(4)
    expect(m.counts.repetitions).toBe(2)
    expect(c.itemsCompared).toBe(4)
    expect(c.itemsConsistent).toBe(2)
    expect(c.agreementRate).toBe(0.5)
    expect(c.accuracyByRepetition).toEqual([
      { repetition: 0, n: 4, correct: 2, accuracy: 0.5 },
      { repetition: 1, n: 4, correct: 1, accuracy: 0.25 },
    ])
    expect(c.accuracyStd).toBeCloseTo(0.25 / Math.SQRT2, 12) // sample std of {0.5, 0.25}
    expect(c.accuracyRange).toBeCloseTo(0.25, 12)
  })

  it('ignores items seen only once', () => {
    const c = computeLaneMetrics([rep(0, 0, {}), rep(1, 1, {})], ctx).reliability.consistency!
    expect(c.itemsCompared).toBe(0)
    expect(c.agreementRate).toBeNull()
  })
})

describe('timing', () => {
  const latencies = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
  const records = latencies.map((latencyMs, i) =>
    makeRecord({ index: i, latencyMs, providerLatencyMs: i % 2 === 0 ? latencyMs - 50 : undefined, startedAt: i * 6000 }),
  )

  it('computes latency percentiles with linear interpolation', () => {
    const t = computeLaneMetrics(records, ctx).timing
    expect(t.latency).toMatchObject({ count: 10, mean: 550, min: 100, max: 1000, total: 5500 })
    expect(t.latency!.p50).toBeCloseTo(550, 9)
    expect(t.latency!.p90).toBeCloseTo(910, 9)
    expect(t.latency!.p95).toBeCloseTo(955, 9)
    expect(t.latency!.std).toBeCloseTo(Math.sqrt(825_000 / 9), 9)
    expect(t.providerLatency!.count).toBe(5)
    expect(t.providerLatency!.p50).toBe(450)
  })

  it('derives wall time from the records (min start → max finish) and throughput', () => {
    const t = computeLaneMetrics(records, ctx).timing
    expect(t.wallTimeMs).toBe(9 * 6000 + 1000) // last starts at 54 000 and lasts 1 000
    expect(t.throughputPerMin).toBeCloseTo(10 / (55_000 / 60_000), 9)
  })

  it('prefers the run bounds when present', () => {
    const t = computeLaneMetrics(records, { ...ctx, run: makeRun('gpt', 10, { startedAt: 1_000, finishedAt: 61_000 }) }).timing
    expect(t.wallTimeMs).toBe(60_000)
    expect(t.throughputPerMin).toBe(10)
  })
})

describe('cost', () => {
  it('sums tokens and USD when every billable record has a cost', () => {
    const records = [
      answer(0, true, 0.9, { usage: { inputTokens: 100, outputTokens: 10 }, costUsd: 0.001 }),
      answer(1, true, 0.9, { usage: { inputTokens: 200, outputTokens: 20 }, costUsd: 0.002 }),
      makeRecord({ index: 2, status: 'timeout' }), // unbilled: does not break completeness
    ]
    const c = computeLaneMetrics(records, ctx).cost
    expect(c).toMatchObject({ inputTokens: 300, outputTokens: 30, usageRecords: 2, costComplete: true, costedRecords: 2, estimated: false })
    expect(c.costUsd).toBeCloseTo(0.003, 12)
    expect(c.costPerClassificationUsd).toBeCloseTo(0.001, 12)
  })

  it('leaves the total undefined when a billable record has no cost', () => {
    const records = [answer(0, true, 0.9, { costUsd: 0.001, estimated: true }), answer(1, true, 0.9)]
    const c = computeLaneMetrics(records, ctx).cost
    expect(c.costUsd).toBeUndefined()
    expect(c.costPerClassificationUsd).toBeUndefined()
    expect(c.costComplete).toBe(false)
    expect(c.knownCostUsd).toBeCloseTo(0.001, 12)
    expect(c.estimated).toBe(true)
  })
})

describe('lane identity', () => {
  it('reads engine / mode / model from the run, flags mixed modes', () => {
    const m = computeLaneMetrics([makeRecord({ engine: 'jev', mode: 'mock', model: 'mock-jev' })], ctx)
    expect(m).toMatchObject({ engine: 'jev', mode: 'mock', model: 'mock-jev', models: ['mock-jev'] })
    const mixed = computeLaneMetrics([makeRecord({ mode: 'mock' })], { ...ctx, run: makeRun('gpt', 1) })
    expect(mixed.mode).toBe('mixed')
  })

  it('ignores the requested model id of timeouts / errors: only models that answered count', () => {
    const records = [
      makeRecord({ index: 0, model: 'gpt-4.1-mini-2025-04-14' }),
      makeRecord({ index: 1, status: 'timeout', model: 'gpt-4.1-mini' }),
      makeRecord({ index: 2, status: 'error', model: 'gpt-4.1-mini' }),
    ]
    expect(computeLaneMetrics(records, ctx).models).toEqual(['gpt-4.1-mini-2025-04-14'])
    // Nothing answered: fall back to what the records say.
    expect(computeLaneMetrics(records.slice(1), ctx).models).toEqual(['gpt-4.1-mini'])
    // Two models that really answered are still reported.
    const two = [makeRecord({ index: 0, model: 'a' }), makeRecord({ index: 1, model: 'b' })]
    expect(computeLaneMetrics(two, ctx).models).toEqual(['a', 'b'])
  })
})
