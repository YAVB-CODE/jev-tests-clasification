/**
 * Reliability pillar: is the engine's stated confidence trustworthy?
 *
 * Population (decision documented here and in the UI hints)
 *  - Calibration (Brier, ECE, MCE, bins, AUROC, risk–coverage) is computed over ANSWERED records
 *    that carry a confidence (`confidence`, the comparable signal). Records without an answer
 *    (invalid / error / timeout) are excluded: scoring them as "confidence 0, correct 0" would add
 *    perfect (0) terms and make a lane that fails more look BETTER calibrated. Failures are
 *    punished where they belong: accuracy (Score) and `validRate` (Reliability).
 *  - `brierAllRecords` is that alternative definition (no answer = confidence 0 and correct 0,
 *    over every completed record), exposed for transparency only; it never enters the verdict.
 *  - Answered records without a confidence are excluded too; `confidenceCoverage` reports the
 *    share of answered records that carried one.
 *  - Confidences are clamped to [0, 1] for Brier / ECE / bins. AUROC is rank-based and uses the
 *    raw values (meaningful even for a native statistic that is not a probability).
 */
import type { Category, ClassificationRecord, NativeConfidenceKind } from '../shared/contracts.ts'
import { isAnswered, isCorrect } from './records.ts'
import { auroc, clamp01, isFiniteNumber, mean, ratio, sampleStd } from './stats.ts'

/** Equal-width bins on [0, 1] for ECE / MCE and the reliability diagram. */
export const CALIBRATION_BINS = 10
/** A wrong answer stated with at least this confidence is "overconfident". */
export const OVERCONFIDENT_THRESHOLD = 0.8
/** Coverage levels of the risk–coverage (selective accuracy) curve. */
export const COVERAGE_LEVELS: readonly number[] = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]

export interface ConfidencePoint {
  confidence: number
  correct: boolean
}

export interface CalibrationBin {
  lo: number
  hi: number
  count: number
  meanConfidence: number | null
  accuracy: number | null
  /** accuracy − meanConfidence (negative = overconfident); null when empty. */
  gap: number | null
}

export interface CoveragePoint {
  /** Target share of the most confident answers kept (0.1 … 1). */
  coverage: number
  /** Answers kept: ⌈coverage · n⌉. */
  count: number
  /** Accuracy of those answers (ties at the cut are averaged, see `riskCoverage`). */
  accuracy: number
  /** 1 − accuracy. */
  risk: number
  /** Lowest confidence kept. */
  threshold: number
}

export interface OverconfidenceStats {
  threshold: number
  /** Wrong answers with confidence ≥ threshold. */
  count: number
  /** count / scored answers. */
  rate: number | null
  /** count / wrong scored answers. */
  shareOfErrors: number | null
}

export interface CalibrationStats {
  /** Scored points (answers with a confidence). */
  n: number
  correct: number
  accuracy: number | null
  meanConfidence: number | null
  /** Binary Brier: mean of (confidence − correct)². 0 = perfect, 0.25 = always 0.5. */
  brier: number | null
  /** Expected calibration error: Σ (n_b / n) · |accuracy_b − confidence_b| over 10 equal-width bins. */
  ece: number | null
  /** Maximum calibration error: max over non-empty bins of |accuracy_b − confidence_b|. */
  mce: number | null
  bins: CalibrationBin[]
  /** P(confidence of a correct answer > confidence of a wrong one), ties = ½. null with a single class. */
  auroc: number | null
  meanConfidenceCorrect: number | null
  meanConfidenceWrong: number | null
  overconfidentErrors: OverconfidenceStats
  riskCoverage: CoveragePoint[]
  /** Raw values outside [0, 1] (clamped for Brier / ECE). */
  outOfRange: number
}

/** Bin of a confidence in [0, 1]; 1 falls in the last bin, and 1e-9 absorbs 0.1·k float noise (0.7·10). */
export function binIndex(confidence: number, bins = CALIBRATION_BINS): number {
  return Math.min(bins - 1, Math.max(0, Math.floor(confidence * bins + 1e-9)))
}

/**
 * Selective accuracy of the top-k most confident answers for each coverage level. Answers are
 * sorted by confidence (desc); when the cut falls inside a group of equal confidences, that group
 * contributes its mean accuracy pro rata (the expected value under a random tie-break), so the
 * result does not depend on input order.
 */
export function riskCoverage(points: readonly ConfidencePoint[], levels = COVERAGE_LEVELS): CoveragePoint[] {
  const n = points.length
  if (n === 0) return []
  const sorted = [...points].sort((a, b) => b.confidence - a.confidence)
  // Groups of equal confidence: [confidence, size, correct].
  const groups: [number, number, number][] = []
  for (const p of sorted) {
    const last = groups[groups.length - 1]
    if (last && last[0] === p.confidence) {
      last[1] += 1
      if (p.correct) last[2] += 1
    } else {
      groups.push([p.confidence, 1, p.correct ? 1 : 0])
    }
  }
  return levels.map((coverage) => {
    const k = Math.max(1, Math.min(n, Math.ceil(coverage * n - 1e-9)))
    let taken = 0
    let hits = 0
    let threshold = groups[0][0]
    for (const [conf, size, right] of groups) {
      if (taken >= k) break
      const take = Math.min(size, k - taken)
      hits += take === size ? right : (right / size) * take
      taken += take
      threshold = conf
    }
    const accuracy = hits / k
    return { coverage, count: k, accuracy, risk: 1 - accuracy, threshold }
  })
}

export function computeCalibration(points: readonly ConfidencePoint[]): CalibrationStats {
  const raw = points.filter((p) => Number.isFinite(p.confidence))
  const clamped = raw.map((p) => ({ confidence: clamp01(p.confidence), correct: p.correct }))
  const n = clamped.length

  const binCount = new Array<number>(CALIBRATION_BINS).fill(0)
  const binConf = new Array<number>(CALIBRATION_BINS).fill(0)
  const binRight = new Array<number>(CALIBRATION_BINS).fill(0)
  let correct = 0
  let brierSum = 0
  let overconfident = 0
  const confCorrect: number[] = []
  const confWrong: number[] = []

  for (const p of clamped) {
    const y = p.correct ? 1 : 0
    correct += y
    brierSum += (p.confidence - y) ** 2
    if (p.correct) confCorrect.push(p.confidence)
    else {
      confWrong.push(p.confidence)
      if (p.confidence >= OVERCONFIDENT_THRESHOLD) overconfident += 1
    }
    const b = binIndex(p.confidence)
    binCount[b] += 1
    binConf[b] += p.confidence
    binRight[b] += y
  }

  const bins: CalibrationBin[] = []
  let ece = 0
  let mce = 0
  for (let i = 0; i < CALIBRATION_BINS; i++) {
    const count = binCount[i]
    const meanConfidence = count > 0 ? binConf[i] / count : null
    const accuracy = count > 0 ? binRight[i] / count : null
    const gap = meanConfidence !== null && accuracy !== null ? accuracy - meanConfidence : null
    bins.push({ lo: i / CALIBRATION_BINS, hi: (i + 1) / CALIBRATION_BINS, count, meanConfidence, accuracy, gap })
    if (gap !== null) {
      ece += (count / n) * Math.abs(gap)
      mce = Math.max(mce, Math.abs(gap))
    }
  }

  return {
    n,
    correct,
    accuracy: ratio(correct, n),
    meanConfidence: mean(clamped.map((p) => p.confidence)),
    brier: n > 0 ? brierSum / n : null,
    ece: n > 0 ? ece : null,
    mce: n > 0 ? mce : null,
    bins,
    auroc: auroc(raw.map((p) => ({ score: p.confidence, positive: p.correct }))),
    meanConfidenceCorrect: mean(confCorrect),
    meanConfidenceWrong: mean(confWrong),
    overconfidentErrors: {
      threshold: OVERCONFIDENT_THRESHOLD,
      count: overconfident,
      rate: ratio(overconfident, n),
      shareOfErrors: ratio(overconfident, confWrong.length),
    },
    riskCoverage: riskCoverage(clamped),
    outOfRange: raw.filter((p) => p.confidence < 0 || p.confidence > 1).length,
  }
}

export interface NativeCalibration extends CalibrationStats {
  /** Origin of the values; 'mixed' if records disagree; null when no record carries one. */
  kind: NativeConfidenceKind | 'mixed' | null
  /** Only `logprob` is a probability; for `jev_confidence` read AUROC, not Brier / ECE. */
  probabilistic: boolean
  /** Answered records with a native confidence / answered records. */
  coverage: number | null
}

export interface ConsistencyStats {
  /** Items classified at least twice. */
  itemsCompared: number
  /** Items whose output (category, or "sin respuesta") was identical in every repetition. */
  itemsConsistent: number
  /** itemsConsistent / itemsCompared. */
  agreementRate: number | null
  /** Accuracy of each repetition (0-based). */
  accuracyByRepetition: { repetition: number; n: number; correct: number; accuracy: number | null }[]
  /** Sample standard deviation (n − 1) of the per-repetition accuracies; null with < 2 repetitions. */
  accuracyStd: number | null
  /** max − min of the per-repetition accuracies; null with < 2 repetitions. */
  accuracyRange: number | null
}

export interface ReliabilityMetrics extends CalibrationStats {
  /** Answered (status 'ok') / completed. */
  validRate: number | null
  /** Answered records with a confidence. */
  withConfidence: number
  /** withConfidence / answered. */
  confidenceCoverage: number | null
  /** Informative: binary Brier with "no answer = confidence 0, correct 0" over every completed record. */
  brierAllRecords: number | null
  /**
   * Informative (not in the verdict): mean of Σ_k (p_k − 1[k = expected])² over answered records
   * that carry `probabilities` (missing classes = 0). 0 = perfect, 2 = worst.
   */
  multiclassBrier: number | null
  multiclassBrierN: number
  /** Same analysis on `nativeConfidence` (informative only, not comparable across engines). */
  native: NativeCalibration
  /** Present when the run has repetitions (some record with repetition > 0). */
  consistency: ConsistencyStats | null
}

function multiclassBrierOf(r: ClassificationRecord, categoryIds: readonly string[]): number | null {
  const probs = r.probabilities
  if (!probs || typeof probs !== 'object') return null
  const keys = new Set<string>(categoryIds)
  for (const k of Object.keys(probs)) keys.add(k)
  keys.add(r.expected)
  let sum = 0
  for (const k of keys) {
    const v = probs[k]
    const p = isFiniteNumber(v) ? clamp01(v) : 0
    sum += (p - (k === r.expected ? 1 : 0)) ** 2
  }
  return sum
}

export function computeConsistency(records: readonly ClassificationRecord[]): ConsistencyStats | null {
  if (!records.some((r) => r.repetition > 0)) return null
  const byItem = new Map<string, ClassificationRecord[]>()
  const byRep = new Map<number, { n: number; correct: number }>()
  for (const r of records) {
    let list = byItem.get(r.itemId)
    if (!list) byItem.set(r.itemId, (list = []))
    list.push(r)
    let rep = byRep.get(r.repetition)
    if (!rep) byRep.set(r.repetition, (rep = { n: 0, correct: 0 }))
    rep.n += 1
    if (isCorrect(r)) rep.correct += 1
  }

  let itemsCompared = 0
  let itemsConsistent = 0
  for (const list of byItem.values()) {
    if (list.length < 2) continue
    itemsCompared += 1
    const outputs = new Set(list.map((r) => (isAnswered(r) ? r.predicted : null)))
    if (outputs.size === 1) itemsConsistent += 1
  }

  const accuracyByRepetition = [...byRep.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([repetition, { n, correct }]) => ({ repetition, n, correct, accuracy: ratio(correct, n) }))
  const accs = accuracyByRepetition.map((r) => r.accuracy).filter((a): a is number => a !== null)

  return {
    itemsCompared,
    itemsConsistent,
    agreementRate: ratio(itemsConsistent, itemsCompared),
    accuracyByRepetition,
    accuracyStd: accs.length >= 2 ? sampleStd(accs) : null,
    accuracyRange: accs.length >= 2 ? Math.max(...accs) - Math.min(...accs) : null,
  }
}

export function computeReliability(
  records: readonly ClassificationRecord[],
  categories: readonly Category[],
): ReliabilityMetrics {
  const answered = records.filter(isAnswered)
  const unanswered = records.length - answered.length

  const points: ConfidencePoint[] = []
  const nativePoints: ConfidencePoint[] = []
  const nativeKinds = new Set<NativeConfidenceKind>()
  const categoryIds = categories.map((c) => c.id)
  let mcSum = 0
  let mcN = 0
  for (const r of answered) {
    const correct = isCorrect(r)
    if (isFiniteNumber(r.confidence)) points.push({ confidence: r.confidence, correct })
    if (isFiniteNumber(r.nativeConfidence)) {
      nativePoints.push({ confidence: r.nativeConfidence, correct })
      if (r.nativeConfidenceKind) nativeKinds.add(r.nativeConfidenceKind)
    }
    const mc = multiclassBrierOf(r, categoryIds)
    if (mc !== null) {
      mcSum += mc
      mcN += 1
    }
  }

  const calibration = computeCalibration(points)
  const native = computeCalibration(nativePoints)
  const kind: NativeCalibration['kind'] =
    nativeKinds.size === 0 ? null : nativeKinds.size === 1 ? [...nativeKinds][0] : 'mixed'
  const allN = calibration.n + unanswered

  return {
    ...calibration,
    validRate: ratio(answered.length, records.length),
    withConfidence: calibration.n,
    confidenceCoverage: ratio(calibration.n, answered.length),
    brierAllRecords: allN > 0 ? ((calibration.brier ?? 0) * calibration.n) / allN : null,
    multiclassBrier: mcN > 0 ? mcSum / mcN : null,
    multiclassBrierN: mcN,
    native: {
      ...native,
      kind,
      probabilistic: kind === 'logprob',
      coverage: ratio(native.n, answered.length),
    },
    consistency: computeConsistency(records),
  }
}
