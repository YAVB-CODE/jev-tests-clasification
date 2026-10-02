import { describe, expect, it } from 'vitest'
import {
  auroc,
  binomialTwoSidedP,
  mean,
  percentile,
  ratio,
  relativeDifference,
  sampleStd,
  summarize,
  wilsonInterval,
} from './stats.ts'

describe('percentile (linear interpolation, type 7)', () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

  it('matches hand-computed values', () => {
    expect(percentile(sorted, 0)).toBe(1)
    expect(percentile(sorted, 50)).toBeCloseTo(5.5, 12)
    expect(percentile(sorted, 90)).toBeCloseTo(9.1, 12) // rank 8.1 → 9 + 0.1
    expect(percentile(sorted, 95)).toBeCloseTo(9.55, 12) // rank 8.55
    expect(percentile(sorted, 100)).toBe(10)
  })

  it('handles degenerate inputs', () => {
    expect(percentile([], 50)).toBeNull()
    expect(percentile([42], 95)).toBe(42)
    expect(percentile([1, 3], 50)).toBe(2)
    expect(percentile(sorted, -10)).toBe(1)
    expect(percentile(sorted, 150)).toBe(10)
  })
})

describe('summarize', () => {
  it('computes mean, percentiles, extremes and SAMPLE std', () => {
    const s = summarize([9, 2, 4, 4, 4, 5, 5, 7]) // unsorted on purpose
    expect(s).not.toBeNull()
    expect(s!.count).toBe(8)
    expect(s!.mean).toBe(5)
    expect(s!.total).toBe(40)
    expect(s!.min).toBe(2)
    expect(s!.max).toBe(9)
    expect(s!.p50).toBe(4.5)
    // sorted 2 4 4 4 5 5 7 9: p90 rank 6.3 → 7 + 0.3·2 = 7.6; p95 rank 6.65 → 8.3
    expect(s!.p90).toBeCloseTo(7.6, 12)
    expect(s!.p95).toBeCloseTo(8.3, 12)
    expect(s!.std).toBeCloseTo(Math.sqrt(32 / 7), 12) // Σ(x − 5)² = 32, n − 1 = 7
  })

  it('ignores non-finite values and does not mutate its input', () => {
    const input = [300, Number.NaN, 100, Number.POSITIVE_INFINITY]
    const s = summarize(input)
    expect(s!.count).toBe(2)
    expect(s!.mean).toBe(200)
    expect(input[0]).toBe(300)
  })

  it('returns null for no data and std 0 for a single value', () => {
    expect(summarize([])).toBeNull()
    expect(summarize([Number.NaN])).toBeNull()
    expect(summarize([250])).toMatchObject({ count: 1, mean: 250, p50: 250, p95: 250, std: 0 })
  })
})

describe('mean / sampleStd / ratio / relativeDifference', () => {
  it('never returns NaN', () => {
    expect(mean([])).toBeNull()
    expect(mean([1, 2, 3])).toBe(2)
    expect(sampleStd([])).toBeNull()
    expect(sampleStd([5])).toBe(0)
    expect(sampleStd([1, 3])).toBeCloseTo(Math.SQRT2, 12)
    expect(ratio(1, 0)).toBeNull()
    expect(ratio(3, 4)).toBe(0.75)
    expect(relativeDifference(0, 0)).toBe(0)
    expect(relativeDifference(100, 95)).toBeCloseTo(0.05, 12)
  })
})

describe('wilsonInterval (95 %)', () => {
  it('matches published values', () => {
    const half = wilsonInterval(5, 10)!
    expect(half.lo).toBeCloseTo(0.2366, 4)
    expect(half.hi).toBeCloseTo(0.7634, 4)
    const none = wilsonInterval(0, 10)!
    expect(none.lo).toBe(0)
    expect(none.hi).toBeCloseTo(0.2775, 4)
    const all = wilsonInterval(10, 10)!
    expect(all.lo).toBeCloseTo(0.7225, 4)
    expect(all.hi).toBe(1)
  })

  it('is null without trials and always inside [0, 1]', () => {
    expect(wilsonInterval(0, 0)).toBeNull()
    const ci = wilsonInterval(1, 1)!
    expect(ci.lo).toBeGreaterThan(0)
    expect(ci.hi).toBe(1)
  })
})

describe('binomialTwoSidedP (exact McNemar on discordant pairs)', () => {
  it('matches hand-computed values', () => {
    // n = 12, P(X ≤ 2) = (1 + 12 + 66) / 4096 = 79/4096 → p = 158/4096
    expect(binomialTwoSidedP(10, 12)).toBeCloseTo(158 / 4096, 12)
    expect(binomialTwoSidedP(10, 12)).toBeCloseTo(0.0386, 4)
    expect(binomialTwoSidedP(2, 12)).toBeCloseTo(158 / 4096, 12) // symmetric
    expect(binomialTwoSidedP(6, 6)).toBeCloseTo(2 / 64, 12)
    expect(binomialTwoSidedP(5, 5)).toBeCloseTo(2 / 32, 12)
  })

  it('caps at 1 and handles empty / degenerate input', () => {
    expect(binomialTwoSidedP(0, 0)).toBe(1)
    expect(binomialTwoSidedP(5, 10)).toBe(1)
    expect(binomialTwoSidedP(1, 1)).toBe(1)
    expect(binomialTwoSidedP(1, 2)).toBe(1)
  })

  it('stays finite for large n', () => {
    const p = binomialTwoSidedP(3000, 6100)
    expect(Number.isFinite(p)).toBe(true)
    expect(p).toBeGreaterThan(0)
    expect(p).toBeLessThan(1)
    expect(binomialTwoSidedP(0, 2000)).toBeLessThan(1e-300)
  })
})

describe('auroc (Mann–Whitney, ties = ½)', () => {
  const pt = (score: number, positive: boolean) => ({ score, positive })

  it('is 1 / 0 / 0.5 for perfect, inverted and uninformative scores', () => {
    expect(auroc([pt(0.9, true), pt(0.8, true), pt(0.2, false)])).toBe(1)
    expect(auroc([pt(0.1, true), pt(0.9, false)])).toBe(0)
    expect(auroc([pt(0.5, true), pt(0.5, false), pt(0.5, true)])).toBe(0.5)
  })

  it('matches a hand count with ties', () => {
    // pos 0.9, 0.6 vs neg 0.6, 0.3 → (1 + 1 + 0.5 + 1) / 4
    expect(auroc([pt(0.9, true), pt(0.6, true), pt(0.6, false), pt(0.3, false)])).toBe(0.875)
  })

  it('is null with a single class', () => {
    expect(auroc([pt(0.9, true), pt(0.4, true)])).toBeNull()
    expect(auroc([pt(0.9, false)])).toBeNull()
    expect(auroc([])).toBeNull()
  })
})
