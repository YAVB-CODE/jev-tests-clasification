import { describe, expect, it } from 'vitest'
import { CATEGORIES, hits, makeLane, makeRun } from '../../metrics/__fixtures__/makeRecord.ts'
import { computeLaneMetrics, type CalibrationBin, type CoveragePoint, type DifficultyScore } from '../../metrics/index.ts'
import {
  MIN_BUBBLE_OPACITY,
  bubbleOpacity,
  coverageRows,
  coverageTakeaway,
  difficultyRows,
  hasDifficultyData,
  latencyMax,
  latencyRows,
  niceAxis,
  maxBinCount,
  reliabilityPoints,
  selectiveGain,
} from './chartData.ts'

const bin = (lo: number, count: number, meanConfidence: number | null, accuracy: number | null): CalibrationBin => ({
  lo,
  hi: lo + 0.1,
  count,
  meanConfidence,
  accuracy,
  gap: meanConfidence !== null && accuracy !== null ? accuracy - meanConfidence : null,
})

describe('bubbleOpacity', () => {
  it('fades sparse bins but never below the floor and is solid at the max', () => {
    expect(bubbleOpacity(10, 10)).toBe(1)
    expect(bubbleOpacity(0, 10)).toBe(MIN_BUBBLE_OPACITY)
    expect(bubbleOpacity(5, 10)).toBeGreaterThan(MIN_BUBBLE_OPACITY)
    expect(bubbleOpacity(5, 10)).toBeLessThan(1)
    expect(bubbleOpacity(3, 0)).toBe(MIN_BUBBLE_OPACITY)
    expect(bubbleOpacity(20, 10)).toBe(1)
  })
})

describe('reliabilityPoints', () => {
  const bins = [bin(0.5, 0, null, null), bin(0.7, 4, 0.75, 0.5), bin(0.9, 10, 0.95, 0.9)]
  it('keeps only non-empty bins with x = mean confidence, y = accuracy and the signed gap', () => {
    const pts = reliabilityPoints('gpt', bins, maxBinCount(bins))
    expect(pts).toHaveLength(2)
    expect(pts[0]).toMatchObject({ engine: 'gpt', confidence: 0.75, accuracy: 0.5, n: 4 })
    expect(pts[0].gap).toBeCloseTo(-0.25) // overconfident: below the diagonal
    expect(pts[1].opacity).toBe(1)
    expect(pts[0].opacity).toBeLessThan(pts[1].opacity)
  })
  it('shares maxN across lanes', () => {
    const other = [bin(0.9, 40, 0.9, 0.9)]
    expect(maxBinCount(bins, other)).toBe(40)
    expect(maxBinCount([])).toBe(1)
    const pts = reliabilityPoints('jev', bins, maxBinCount(bins, other))
    expect(pts[1].opacity).toBeLessThan(1) // 10 of 40
  })
  it('is empty without bins or with unscored bins', () => {
    expect(reliabilityPoints('gpt', [], 1)).toEqual([])
    expect(reliabilityPoints('gpt', [bin(0.1, 3, null, null)], 3)).toEqual([])
  })
})

describe('latencyRows', () => {
  it('returns p50 / p90 / p95 / max for both lanes, null for a lane without latencies', () => {
    const records = makeLane({ engine: 'gpt', correct: hits(5, 10), latencyMs: [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000] })
    const m = computeLaneMetrics(records, { categories: CATEGORIES, run: makeRun('gpt', 10) })
    const rows = latencyRows(m.timing.latency, null)
    expect(rows.map((r) => r.stat)).toEqual(['p50', 'p90', 'p95', 'max'])
    expect(rows.map((r) => r.label)).toEqual(['p50', 'p90', 'p95', 'Máx.'])
    expect(rows[0].gpt).toBeCloseTo(550)
    expect(rows[3].gpt).toBe(1000)
    expect(rows.every((r) => r.jev === null)).toBe(true)
  })
})

describe('difficultyRows', () => {
  const d = (n: number, correct: number): DifficultyScore => ({ n, correct, accuracy: n > 0 ? correct / n : null })
  it('orders easy → medium → hard with Spanish labels and per-lane counts', () => {
    const rows = difficultyRows({ easy: d(10, 9), medium: d(10, 6), hard: d(0, 0) }, { easy: d(10, 10), medium: d(8, 4), hard: d(5, 1) })
    expect(rows.map((r) => r.label)).toEqual(['Fácil', 'Media', 'Difícil'])
    expect(rows[0]).toMatchObject({ gpt: 0.9, jev: 1, gptN: 10, jevN: 10, gptCorrect: 9, jevCorrect: 10 })
    expect(rows[2].gpt).toBeNull()
    expect(rows[2].jev).toBeCloseTo(0.2)
    expect(hasDifficultyData(rows)).toBe(true)
  })
  it('reports no data when every bucket is empty', () => {
    const empty = { easy: d(0, 0), medium: d(0, 0), hard: d(0, 0) }
    expect(hasDifficultyData(difficultyRows(empty, empty))).toBe(false)
  })
})

describe('coverageRows / selectiveGain', () => {
  const pt = (coverage: number, accuracy: number, count: number, threshold: number): CoveragePoint => ({
    coverage,
    count,
    accuracy,
    risk: 1 - accuracy,
    threshold,
  })
  const gpt = [pt(0.5, 1, 5, 0.9), pt(1, 0.8, 10, 0.4)]
  const jev = [pt(0.5, 0.9, 4, 0.8), pt(0.7, 0.85, 6, 0.6), pt(1, 0.8, 8, 0.3)]

  it('merges both curves on the union of coverage levels, null where a lane has no point', () => {
    const rows = coverageRows(gpt, jev)
    expect(rows.map((r) => r.coverage)).toEqual([0.5, 0.7, 1])
    expect(rows[1]).toMatchObject({ gpt: null, jev: 0.85, gptCount: 0, jevCount: 6, gptThreshold: null, jevThreshold: 0.6 })
    expect(rows[0]).toMatchObject({ gpt: 1, jev: 0.9, gptCount: 5, jevCount: 4 })
  })
  it('handles an empty lane', () => {
    const rows = coverageRows([], jev)
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.gpt === null)).toBe(true)
    expect(coverageRows([], [])).toEqual([])
  })
  it('selective gain = accuracy at the top coverage minus at full coverage', () => {
    expect(selectiveGain(gpt)).toBeCloseTo(0.2)
    expect(selectiveGain([pt(1, 0.8, 10, 0.4)])).toBeNull()
    expect(selectiveGain([])).toBeNull()
  })
})

describe('coverageTakeaway', () => {
  const pt = (coverage: number, accuracy: number): CoveragePoint => ({ coverage, count: 10, accuracy, risk: 1 - accuracy, threshold: 0.5 })
  it('says the confidence filters when accuracy rises at lower coverage', () => {
    const t = coverageTakeaway('GPT', [pt(0.5, 0.95), pt(1, 0.8)])
    expect(t).toContain('GPT: aceptando solo el 50 % más confiado acierta 95 %')
    expect(t).toContain('sin filtrar, 80 %')
    expect(t).toContain('+15 pp')
    expect(t).toContain('sirve para filtrar')
  })
  it('flags a flat or inverted curve', () => {
    expect(coverageTakeaway('Jev', [pt(0.5, 0.81), pt(1, 0.8)])).toContain('apenas ayuda')
    expect(coverageTakeaway('Jev', [pt(0.5, 0.6), pt(1, 0.8)])).toContain('al revés')
  })
  it('is null when a point is missing', () => {
    expect(coverageTakeaway('GPT', [pt(1, 0.8)])).toBeNull()
    expect(coverageTakeaway('GPT', [])).toBeNull()
  })
})

describe('niceAxis / latencyMax', () => {
  it('rounds the maximum up to a clean step', () => {
    expect(niceAxis(3800)).toEqual({ max: 4000, ticks: [0, 1000, 2000, 3000, 4000] })
    expect(niceAxis(950)).toEqual({ max: 1000, ticks: [0, 250, 500, 750, 1000] })
    expect(niceAxis(5100).ticks.at(-1)).toBe(niceAxis(5100).max)
    expect(niceAxis(5100).max).toBeGreaterThanOrEqual(5100)
  })
  it('handles empty / invalid maxima', () => {
    expect(niceAxis(0)).toEqual({ max: 1, ticks: [0, 1] })
    expect(niceAxis(Number.NaN)).toEqual({ max: 1, ticks: [0, 1] })
  })
  it('latencyMax takes the largest value across lanes, ignoring nulls', () => {
    expect(latencyMax([{ stat: 'p50', label: 'p50', gpt: 100, jev: null }, { stat: 'max', label: 'Máx.', gpt: null, jev: 700 }])).toBe(700)
    expect(latencyMax([])).toBe(0)
  })
})
