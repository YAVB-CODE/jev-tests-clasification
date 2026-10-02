/**
 * Pure data preparation for the comparison charts (no React): metrics → rows ready for recharts
 * and for the table twin of each chart. Keeping it pure makes it unit-testable and cheap to
 * recompute on every streamed record.
 */
import { DIFFICULTIES, type Difficulty, type EngineId } from '../../shared/contracts.ts'
import { pct, pp } from '../../metrics/index.ts'
import type { CalibrationBin, CoveragePoint, DifficultyScore, LatencyStats } from '../../metrics/index.ts'

export const DIFFICULTY_LABELS: Record<Difficulty, string> = { easy: 'Fácil', medium: 'Media', hard: 'Difícil' }

// ─────────────────────────────── Reliability diagram ───────────────────────────────

export interface ReliabilityPoint {
  engine: EngineId
  /** Mean stated confidence of the answers in the bin (x). */
  confidence: number
  /** Share of correct answers in the bin (y). */
  accuracy: number
  /** Answers in the bin: drives bubble size and opacity. */
  n: number
  lo: number
  hi: number
  /** accuracy − confidence (negative = overconfident). */
  gap: number
  /** Bubble opacity from n / maxN (see `bubbleOpacity`). */
  opacity: number
}

export const MIN_BUBBLE_OPACITY = 0.5

/** Opacity of a bin bubble: sparse bins fade (down to MIN_BUBBLE_OPACITY), the fullest bin is solid. */
export function bubbleOpacity(n: number, maxN: number): number {
  if (maxN <= 0 || n <= 0) return MIN_BUBBLE_OPACITY
  return MIN_BUBBLE_OPACITY + (1 - MIN_BUBBLE_OPACITY) * Math.min(1, n / maxN)
}

/** Non-empty bins of one lane as scatter points; `maxN` is shared across lanes so sizes are comparable. */
export function reliabilityPoints(engine: EngineId, bins: readonly CalibrationBin[], maxN: number): ReliabilityPoint[] {
  const out: ReliabilityPoint[] = []
  for (const b of bins) {
    if (b.count <= 0 || b.meanConfidence === null || b.accuracy === null) continue
    out.push({
      engine,
      confidence: b.meanConfidence,
      accuracy: b.accuracy,
      n: b.count,
      lo: b.lo,
      hi: b.hi,
      gap: b.accuracy - b.meanConfidence,
      opacity: bubbleOpacity(b.count, maxN),
    })
  }
  return out
}

/** Largest bin population across both lanes (≥ 1). */
export function maxBinCount(...lanes: readonly (readonly CalibrationBin[])[]): number {
  let max = 1
  for (const bins of lanes) for (const b of bins) max = Math.max(max, b.count)
  return max
}

// ─────────────────────────────── Latency ───────────────────────────────

export type LatencyStat = 'p50' | 'p90' | 'p95' | 'max'

export interface LatencyRow {
  stat: LatencyStat
  label: string
  gpt: number | null
  jev: number | null
}

export const LATENCY_STATS: readonly { stat: LatencyStat; label: string }[] = [
  { stat: 'p50', label: 'p50' },
  { stat: 'p90', label: 'p90' },
  { stat: 'p95', label: 'p95' },
  { stat: 'max', label: 'Máx.' },
]

/** One row per statistic (p50, p90, p95, max) with both lanes' values in ms; null when a lane has no latencies. */
export function latencyRows(gpt: LatencyStats | null, jev: LatencyStats | null): LatencyRow[] {
  return LATENCY_STATS.map(({ stat, label }) => ({
    stat,
    label,
    gpt: gpt ? gpt[stat] : null,
    jev: jev ? jev[stat] : null,
  }))
}

/** Round axis maximum and evenly spaced ticks (0 … max) with a 1 / 2 / 2.5 / 5 × 10^k step. */
export function niceAxis(max: number, targetTicks = 4): { max: number; ticks: number[] } {
  if (!Number.isFinite(max) || max <= 0) return { max: 1, ticks: [0, 1] }
  const raw = max / targetTicks
  const pow = 10 ** Math.floor(Math.log10(raw))
  const step = ([1, 2, 2.5, 5, 10].map((m) => m * pow).find((c) => c >= raw - 1e-9) ?? 10 * pow)
  const top = Math.ceil(max / step - 1e-9) * step
  const ticks: number[] = []
  for (let v = 0; v <= top + step / 1e6; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  return { max: top, ticks }
}

/** Largest value of the latency rows (0 when empty), the input of `niceAxis`. */
export function latencyMax(rows: readonly LatencyRow[]): number {
  let max = 0
  for (const r of rows) for (const v of [r.gpt, r.jev]) if (v !== null && v > max) max = v
  return max
}

// ─────────────────────────────── Accuracy by difficulty ───────────────────────────────

export interface DifficultyRow {
  difficulty: Difficulty
  label: string
  gpt: number | null
  jev: number | null
  gptN: number
  jevN: number
  gptCorrect: number
  jevCorrect: number
}

export function difficultyRows(
  gpt: Record<Difficulty, DifficultyScore>,
  jev: Record<Difficulty, DifficultyScore>,
): DifficultyRow[] {
  return DIFFICULTIES.map((d) => ({
    difficulty: d,
    label: DIFFICULTY_LABELS[d],
    gpt: gpt[d].accuracy,
    jev: jev[d].accuracy,
    gptN: gpt[d].n,
    jevN: jev[d].n,
    gptCorrect: gpt[d].correct,
    jevCorrect: jev[d].correct,
  }))
}

/** At least one difficulty bucket has data on either lane. */
export function hasDifficultyData(rows: readonly DifficultyRow[]): boolean {
  return rows.some((r) => r.gptN > 0 || r.jevN > 0)
}

// ─────────────────────────────── Risk–coverage ───────────────────────────────

export interface CoverageRow {
  /** Share of the most confident answers kept (0.1 … 1). */
  coverage: number
  gpt: number | null
  jev: number | null
  gptCount: number
  jevCount: number
  /** Lowest confidence kept at this coverage. */
  gptThreshold: number | null
  jevThreshold: number | null
}

/** Merge both lanes' selective-accuracy curves on the coverage axis (levels are shared by `riskCoverage`). */
export function coverageRows(gpt: readonly CoveragePoint[], jev: readonly CoveragePoint[]): CoverageRow[] {
  const gMap = new Map(gpt.map((p) => [p.coverage, p]))
  const jMap = new Map(jev.map((p) => [p.coverage, p]))
  const levels = [...new Set([...gMap.keys(), ...jMap.keys()])].sort((a, b) => a - b)
  return levels.map((coverage) => {
    const g = gMap.get(coverage)
    const j = jMap.get(coverage)
    return {
      coverage,
      gpt: g ? g.accuracy : null,
      jev: j ? j.accuracy : null,
      gptCount: g ? g.count : 0,
      jevCount: j ? j.count : 0,
      gptThreshold: g ? g.threshold : null,
      jevThreshold: j ? j.threshold : null,
    }
  })
}

/**
 * How well a curve "sorts" answers by confidence: accuracy at the lowest coverage minus accuracy at
 * full coverage, in fraction points. Positive = the most confident answers are indeed the most accurate.
 */
export function selectiveGain(points: readonly CoveragePoint[]): number | null {
  if (points.length < 2) return null
  const first = points[0]
  const last = points[points.length - 1]
  return first.accuracy - last.accuracy
}

/**
 * One-sentence reading of a risk–coverage curve: accuracy keeping only the `at` most confident
 * answers vs. keeping all of them, and whether the confidence is useful to filter. null when the
 * curve lacks either point.
 */
export function coverageTakeaway(label: string, points: readonly CoveragePoint[], at = 0.5): string | null {
  const top = points.find((p) => Math.abs(p.coverage - at) < 1e-9)
  const all = points.find((p) => Math.abs(p.coverage - 1) < 1e-9)
  if (!top || !all) return null
  const gain = top.accuracy - all.accuracy
  const verdict =
    gain >= 0.03
      ? 'su confianza sirve para filtrar'
      : gain <= -0.03
        ? 'su confianza va al revés: lo más confiado falla más'
        : 'su confianza apenas ayuda a filtrar'
  return `${label}: aceptando solo el ${pct(at, 0)} más confiado acierta ${pct(top.accuracy, 0)} (sin filtrar, ${pct(all.accuracy, 0)}; ${pp(gain, 0)}): ${verdict}.`
}
