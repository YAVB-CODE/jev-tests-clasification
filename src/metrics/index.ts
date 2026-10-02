/** Public API of the metrics module (pure: no React, no I/O, no clock). */
export { computeLaneMetrics } from './compute.ts'
export type { LaneCounts, LaneMetrics, LaneMetricsContext } from './compute.ts'

export { TOP_CONFUSIONS, buildLabels, computeScore } from './score.ts'
export type { CategoryScore, ConfusionMatrix, ConfusionPair, DifficultyScore, ScoreMetrics } from './score.ts'

export {
  CALIBRATION_BINS,
  COVERAGE_LEVELS,
  OVERCONFIDENT_THRESHOLD,
  binIndex,
  computeCalibration,
  computeConsistency,
  computeReliability,
  riskCoverage,
} from './calibration.ts'
export type {
  CalibrationBin,
  CalibrationStats,
  ConfidencePoint,
  ConsistencyStats,
  CoveragePoint,
  NativeCalibration,
  OverconfidenceStats,
  ReliabilityMetrics,
} from './calibration.ts'

export { computeCost, computeTiming } from './timing.ts'
export type { CostMetrics, TimingMetrics } from './timing.ts'

export { SIGNIFICANCE_ALPHA, pairedTest } from './paired.ts'
export type { ItemSignTest, McNemarResult, PairedTest } from './paired.ts'

export {
  AUROC_TIE,
  BRIER_TIE,
  ECE_TIE,
  ENGINE_LABELS,
  MAX_FAILURE_RATE,
  MIN_CONFIDENCE_COVERAGE,
  PILLARS,
  PILLAR_LABELS,
  SCORE_TIE_ITEMS,
  TIME_TIE_REL,
  VALID_RATE_TIE_ITEMS,
  VERDICT_RULES,
  assessValidity,
  buildRows,
  compareLanes,
  decide,
  isTie,
  joinEs,
} from './compare.ts'
export type {
  Better,
  Comparison,
  ComparisonRow,
  ComparisonValidity,
  LaneInput,
  OverallVerdict,
  Pillar,
  PillarVerdict,
  RowFormat,
  RowPillar,
  Tolerance,
  ValidityCode,
  ValidityIssue,
  Winner,
} from './compare.ts'

export { DASH, fixed, formatRowValue, formatValue, int, ms, num, pValue, pct, pp, seconds, times, usd } from './format.ts'

export { dedupeRecords, isAnswered, isCorrect, slotKey } from './records.ts'

export {
  Z_95,
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
export type { Interval, LatencyStats } from './stats.ts'
