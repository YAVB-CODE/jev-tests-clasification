/**
 * Small, dependency-free statistics helpers. Every function is total: empty / degenerate input
 * never yields NaN or Infinity (it yields `null` where "no data" must be distinguishable from 0).
 */

/** Two-sided 95 % normal quantile (z_{0.975}). */
export const Z_95 = 1.959963984540054

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/** `numerator / denominator`, or null when the denominator is 0 (or the result is not finite). */
export function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null
  const v = numerator / denominator
  return Number.isFinite(v) ? v : null
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

/**
 * Sample standard deviation (Bessel-corrected, divides by n − 1): the values are treated as a
 * sample of the engine's behaviour. 0 for a single value, null for none.
 */
export function sampleStd(values: readonly number[]): number | null {
  const n = values.length
  if (n === 0) return null
  if (n === 1) return 0
  const m = mean(values) as number
  let sq = 0
  for (const v of values) sq += (v - m) ** 2
  return Math.sqrt(sq / (n - 1))
}

/**
 * Percentile of an ASCENDING-sorted array with linear interpolation between closest ranks
 * (Hyndman & Fan type 7, the default of NumPy / R / Excel PERCENTILE.INC):
 * rank = p/100 · (n − 1); value = x[⌊rank⌋] + (x[⌈rank⌉] − x[⌊rank⌋]) · (rank − ⌊rank⌋).
 * `p` is clamped to [0, 100]. Returns null for an empty array.
 */
export function percentile(sorted: readonly number[], p: number): number | null {
  const n = sorted.length
  if (n === 0) return null
  if (n === 1) return sorted[0]
  const clamped = Math.min(100, Math.max(0, p))
  const rank = (clamped / 100) * (n - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo)
}

export interface LatencyStats {
  count: number
  mean: number
  /** Percentiles with linear interpolation (see `percentile`). */
  p50: number
  p90: number
  p95: number
  min: number
  max: number
  /** Sample standard deviation (n − 1); 0 with a single value. */
  std: number
  /** Sum of all values (e.g. total time spent waiting). */
  total: number
}

/** Summary statistics of a set of durations. Non-finite values are ignored; null when nothing is left. */
export function summarize(values: readonly number[]): LatencyStats | null {
  const clean = values.filter((v) => Number.isFinite(v))
  if (clean.length === 0) return null
  const sorted = [...clean].sort((a, b) => a - b)
  let total = 0
  for (const v of sorted) total += v
  return {
    count: sorted.length,
    mean: total / sorted.length,
    p50: percentile(sorted, 50) as number,
    p90: percentile(sorted, 90) as number,
    p95: percentile(sorted, 95) as number,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    std: sampleStd(sorted) as number,
    total,
  }
}

export interface Interval {
  lo: number
  hi: number
}

/**
 * Wilson score interval for a binomial proportion k/n (default 95 %). Unlike the normal
 * approximation it stays inside [0, 1] and behaves well at k = 0, k = n and small n.
 * null when n = 0.
 */
export function wilsonInterval(successes: number, n: number, z = Z_95): Interval | null {
  if (n <= 0) return null
  const p = successes / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  return {
    lo: successes <= 0 ? 0 : clamp01(center - half),
    hi: successes >= n ? 1 : clamp01(center + half),
  }
}

/**
 * Exact two-sided binomial test of H0: p = 0.5 for `k` successes in `n` trials:
 * p = min(1, 2 · P(X ≤ min(k, n − k))), X ~ Bin(n, 1/2). This is the exact McNemar test when
 * k and n − k are the two discordant counts. Computed in log space (stable for large n).
 * Returns 1 when n = 0 (no evidence either way).
 */
export function binomialTwoSidedP(k: number, n: number): number {
  if (n <= 0) return 1
  const m = Math.min(k, n - k)
  if (m < 0) return 1
  const log2n = n * Math.LN2
  let logC = 0 // log C(n, 0)
  let tail = 0
  for (let i = 0; i <= m; i++) {
    tail += Math.exp(logC - log2n)
    logC += Math.log(n - i) - Math.log(i + 1)
  }
  return Math.min(1, 2 * tail)
}

/**
 * Area under the ROC curve of `score` as a detector of `positive` (Mann–Whitney U with mid-ranks,
 * so ties count 1/2): the probability that a random positive scores higher than a random negative.
 * 0.5 = no discrimination, 1 = perfect. null when there are no positives or no negatives.
 */
export function auroc(points: readonly { score: number; positive: boolean }[]): number | null {
  const clean = points.filter((p) => Number.isFinite(p.score))
  let nPos = 0
  for (const p of clean) if (p.positive) nPos += 1
  const nNeg = clean.length - nPos
  if (nPos === 0 || nNeg === 0) return null
  const sorted = [...clean].sort((a, b) => a.score - b.score)
  let rankSumPos = 0
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1].score === sorted[i].score) j += 1
    const midRank = (i + j) / 2 + 1 // ranks are 1-based
    for (let t = i; t <= j; t++) if (sorted[t].positive) rankSumPos += midRank
    i = j + 1
  }
  const u = rankSumPos - (nPos * (nPos + 1)) / 2
  return u / (nPos * nNeg)
}

/** |a − b| / max(|a|, |b|); 0 when both are 0. */
export function relativeDifference(a: number, b: number): number {
  const hi = Math.max(Math.abs(a), Math.abs(b))
  return hi === 0 ? 0 : Math.abs(a - b) / hi
}
