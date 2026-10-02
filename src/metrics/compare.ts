/**
 * GPT vs Jev: comparison rows, one verdict per pillar and the overall verdict.
 *
 * Verdict rules (constants below, also bundled in VERDICT_RULES). A difference within the
 * tolerance (|Δ| ≤ tolerance) is a tie.
 *  - Score: higher `accuracy` wins; tie when the difference is worth ≤ SCORE_TIE_ITEMS
 *    classification (|Δacc| · n ≤ 1, n = min completed). `significant` comes from the paired test
 *    (exact McNemar; item-level sign test with repetitions) at α = SIGNIFICANCE_ALPHA. A
 *    non-significant difference still decides the pillar, and the summary says so.
 *  - Reliability: majority vote of ECE (lower, ±ECE_TIE), Brier (lower, ±BRIER_TIE) and
 *    `validRate` (higher, ≤ VALID_RATE_TIE_ITEMS classification). A metric missing on either side
 *    abstains. Equal votes → AUROC (higher, ±AUROC_TIE) breaks the tie; otherwise tie.
 *  - Time: lower end-to-end p50 wins; tie when the relative difference is ≤ TIME_TIE_REL;
 *    then p95, then the batch wall time (same relative tolerance) break ties.
 *  - Overall: the lane that wins more pillars; if pillars are level, Score decides; if Score is
 *    tied too, the result is a tie.
 *  Cost is informative only (rows, no pillar).
 */
import { ENGINE_IDS, type ClassificationRecord, type EngineId, type EngineMode } from '../shared/contracts.ts'
import { OVERCONFIDENT_THRESHOLD } from './calibration.ts'
import type { LaneMetrics } from './compute.ts'
import { int, ms, num, pct, pp, pValue, times, usd } from './format.ts'
import { pairedTest, SIGNIFICANCE_ALPHA, type PairedTest } from './paired.ts'
import { relativeDifference } from './stats.ts'

export type Pillar = 'score' | 'reliability' | 'time'
export type RowPillar = Pillar | 'cost'
export type RowFormat = 'pct' | 'ms' | 'num' | 'usd' | 'p'
export type Better = 'higher' | 'lower'
export type Winner = EngineId | 'tie' | null

export const PILLARS: readonly Pillar[] = ['score', 'reliability', 'time']
export const PILLAR_LABELS: Record<RowPillar, string> = {
  score: 'Score',
  reliability: 'Confiabilidad',
  time: 'Tiempo',
  cost: 'Costo',
}
export const ENGINE_LABELS: Record<EngineId, string> = { gpt: 'GPT', jev: 'Jev' }
const MODE_LABELS: Record<EngineMode | 'mixed', string> = { live: 'real', mock: 'simulado', mixed: 'mixto' }

// ─────────────────────────────── Verdict rules ───────────────────────────────

/** Score: tie when the accuracy gap is worth this many classifications or fewer. */
export const SCORE_TIE_ITEMS = 1
/** Reliability: absolute ECE tolerance. */
export const ECE_TIE = 0.01
/** Reliability: absolute Brier tolerance. */
export const BRIER_TIE = 0.005
/** Reliability: validRate tie when the gap is worth this many classifications or fewer. */
export const VALID_RATE_TIE_ITEMS = 1
/** Reliability tie-break: absolute AUROC tolerance. */
export const AUROC_TIE = 0.01
/** Time: relative tolerance for p50, p95 and wall time (|a − b| / max(a, b)). */
export const TIME_TIE_REL = 0.05
/** Validity note when a lane's answers carry a confidence less often than this. */
export const MIN_CONFIDENCE_COVERAGE = 0.9
/** Validity note when a lane's error + timeout rate exceeds this. */
export const MAX_FAILURE_RATE = 0.2

export const VERDICT_RULES = {
  alpha: SIGNIFICANCE_ALPHA,
  score: { metric: 'accuracy', tieItems: SCORE_TIE_ITEMS },
  reliability: {
    votes: { ece: ECE_TIE, brier: BRIER_TIE, validRateItems: VALID_RATE_TIE_ITEMS },
    tieBreak: { auroc: AUROC_TIE },
  },
  time: { metric: 'latency.p50', relTolerance: TIME_TIE_REL, tieBreaks: ['latency.p95', 'wallTimeMs'] },
  overall: 'Mayoría de pilares; si empatan, decide Score.',
} as const

export type Tolerance =
  | { kind: 'abs'; value: number }
  | { kind: 'rel'; value: number }
  /** Difference measured in classifications: |a − b| · n ≤ value. */
  | { kind: 'items'; value: number; n: number }

const EPS = 1e-9

export function isTie(a: number, b: number, tol: Tolerance): boolean {
  if (a === b) return true
  switch (tol.kind) {
    case 'abs':
      return Math.abs(a - b) <= tol.value + EPS
    case 'rel':
      return relativeDifference(a, b) <= tol.value + EPS
    case 'items':
      return tol.n > 0 && Math.abs(a - b) * tol.n <= tol.value + EPS
  }
}

/** Winner of one metric: null when either side is missing. */
export function decide(gpt: number | null, jev: number | null, better: Better, tol: Tolerance): Winner {
  if (gpt === null || jev === null || !Number.isFinite(gpt) || !Number.isFinite(jev)) return null
  if (isTie(gpt, jev, tol)) return 'tie'
  const gptWins = better === 'higher' ? gpt > jev : gpt < jev
  return gptWins ? 'gpt' : 'jev'
}

// ─────────────────────────────── Types ───────────────────────────────

export interface ComparisonRow {
  key: string
  label: string
  pillar: RowPillar
  gpt: number | null
  jev: number | null
  better: Better
  /** null = not comparable (missing data or informative row). */
  winner: Winner
  /** jev − gpt in the metric's units (null when either side is missing). */
  delta: number | null
  /** Winner's advantage, formatted ("+3,3 pp", "2,4× más rápido"); '' on tie / no winner. */
  deltaText: string
  format: RowFormat
  /** Decimals for 'pct' / 'num'. */
  digits?: number
  /** The metric takes part in its pillar's verdict (decider or tie-break). */
  primary: boolean
  /** Shown for context only: never has a winner. */
  informative?: boolean
  /** The value belongs to the pair (e.g. the p-value): gpt === jev, render once. */
  shared?: boolean
  /** Spanish tooltip. */
  hint?: string
}

export interface PillarVerdict {
  pillar: Pillar
  label: string
  winner: Winner
  /** Row key that settled the verdict ('votes' for the reliability majority); null without a decision. */
  decidedBy: string | null
  /** Short detail for summaries, e.g. "+3,3 pp, diferencia no significativa". '' without data. */
  detail: string
  /** Step-by-step justification, in Spanish. */
  reasons: string[]
  /** Score only: paired-test p-value (null without pairs) and significance at α. */
  pValue?: number | null
  significant?: boolean
  /** Reliability only: vote tally. */
  votes?: { gpt: number; jev: number; tie: number; abstain: number }
}

export interface OverallVerdict {
  winner: Winner
  pillarsWon: Record<EngineId, number>
  /** Pillars tied or without data. */
  pillarsTied: number
  pillarsWithoutData: number
  /** Pillars were level and Score broke the tie. */
  decidedByScore: boolean
  /** One Spanish sentence. */
  summary: string
  reasons: string[]
}

export type ValidityCode =
  | 'no_data'
  | 'engine_mismatch'
  | 'mock'
  | 'mixed_mode'
  | 'mode_mismatch'
  | 'aborted'
  | 'running'
  | 'incomplete'
  | 'coverage_mismatch'
  | 'label_mismatch'
  | 'multiple_models'
  | 'duplicates'
  | 'high_failure_rate'
  | 'low_confidence_coverage'
  | 'rerun'

export interface ValidityIssue {
  code: ValidityCode
  engine?: EngineId
  message: string
  /** Blocking issues make `validForComparison` false; the rest are notes. */
  blocking: boolean
}

export interface ComparisonValidity {
  validForComparison: boolean
  /** Every issue message, blocking ones first. */
  warnings: string[]
  issues: ValidityIssue[]
}

export interface Comparison {
  rows: ComparisonRow[]
  pillars: Record<Pillar, PillarVerdict>
  overall: OverallVerdict
  paired: PairedTest
  validity: ComparisonValidity
}

export interface LaneInput {
  metrics: LaneMetrics
  records: readonly ClassificationRecord[]
}

// ─────────────────────────────── Rows ───────────────────────────────

interface RowDef {
  key: string
  label: string
  pillar: RowPillar
  better: Better
  format: RowFormat
  digits?: number
  primary?: boolean
  informative?: boolean
  /** Drop the row when both sides are null. */
  optional?: boolean
  hint: string
  /** Hint that depends on the lanes (replaces `hint`). */
  hintFor?: (g: LaneMetrics, j: LaneMetrics) => string
  pick: (m: LaneMetrics) => number | null
  tolerance?: (g: LaneMetrics, j: LaneMetrics) => Tolerance
  /** Advantage as a ratio, e.g. 'más rápido' → "2,4× más rápido". */
  ratioWord?: string
}

const minN = (f: (m: LaneMetrics) => number) => (g: LaneMetrics, j: LaneMetrics) => Math.min(f(g), f(j))
const items = (value: number, n: (g: LaneMetrics, j: LaneMetrics) => number) => (g: LaneMetrics, j: LaneMetrics): Tolerance => ({
  kind: 'items',
  value,
  n: n(g, j),
})
const abs = (value: number) => (): Tolerance => ({ kind: 'abs', value })
const rel = (value: number) => (): Tolerance => ({ kind: 'rel', value })

const DIFFICULTY_LABELS = { easy: 'fácil', medium: 'media', hard: 'difícil' } as const

const ROWS: RowDef[] = [
  // ── Score
  {
    key: 'accuracy',
    label: 'Acierto',
    pillar: 'score',
    better: 'higher',
    format: 'pct',
    primary: true,
    hint: 'Clasificaciones correctas sobre las completadas. Inválido, error y timeout cuentan como fallo. Decide el pilar Score (empate si la diferencia equivale a 1 clasificación o menos).',
    pick: (m) => m.score.accuracy,
    tolerance: items(SCORE_TIE_ITEMS, minN((m) => m.counts.completed)),
  },
  {
    key: 'accuracyOnValid',
    label: 'Acierto sobre respuestas válidas',
    pillar: 'score',
    better: 'higher',
    format: 'pct',
    hint: 'Correctas sobre las respuestas válidas (sin contar inválidos, errores ni timeouts).',
    pick: (m) => m.score.accuracyOnValid,
    tolerance: items(SCORE_TIE_ITEMS, minN((m) => m.counts.answered)),
  },
  {
    key: 'groupAccuracy',
    label: 'Acierto por grupo (cuenta)',
    pillar: 'score',
    better: 'higher',
    format: 'pct',
    optional: true,
    hint: 'La predicción cae en el mismo grupo (cuenta de 4 dígitos) que la esperada. Sin respuesta cuenta como fallo.',
    pick: (m) => m.score.groupAccuracy,
    tolerance: items(SCORE_TIE_ITEMS, minN((m) => m.score.groupTotal)),
  },
  {
    key: 'macroF1',
    label: 'Macro-F1',
    pillar: 'score',
    better: 'higher',
    format: 'num',
    digits: 3,
    hint: 'Promedio simple del F1 de cada subcuenta presente en las etiquetas esperadas: todas las categorías pesan igual.',
    pick: (m) => m.score.macroF1,
  },
  {
    key: 'weightedF1',
    label: 'F1 ponderado',
    pillar: 'score',
    better: 'higher',
    format: 'num',
    digits: 3,
    hint: 'F1 de cada subcuenta ponderado por su número de conceptos esperados.',
    pick: (m) => m.score.weightedF1,
  },
  ...(['easy', 'medium', 'hard'] as const).map(
    (d): RowDef => ({
      key: `accuracy_${d}`,
      label: `Acierto (dificultad ${DIFFICULTY_LABELS[d]})`,
      pillar: 'score',
      better: 'higher',
      format: 'pct',
      optional: true,
      hint: `Acierto en los conceptos de dificultad ${DIFFICULTY_LABELS[d]}.`,
      pick: (m) => m.score.byDifficulty[d].accuracy,
      tolerance: items(SCORE_TIE_ITEMS, minN((m) => m.score.byDifficulty[d].n)),
    }),
  ),
  // ── Reliability
  {
    key: 'ece',
    label: 'ECE (error de calibración)',
    pillar: 'reliability',
    better: 'lower',
    format: 'num',
    digits: 3,
    primary: true,
    hint: `Diferencia media entre la confianza declarada y el acierto real (10 intervalos), sobre respuestas válidas con confianza. 0 = perfecta. Vota en Confiabilidad (tolerancia ±${num(ECE_TIE)}).`,
    pick: (m) => m.reliability.ece,
    tolerance: abs(ECE_TIE),
  },
  {
    key: 'brier',
    label: 'Brier',
    pillar: 'reliability',
    better: 'lower',
    format: 'num',
    digits: 3,
    primary: true,
    hint: `Error cuadrático medio entre la confianza y el acierto (0 = perfecto, 0,25 = decir siempre 50 %), sobre respuestas válidas con confianza. Vota en Confiabilidad (tolerancia ±${num(BRIER_TIE)}).`,
    pick: (m) => m.reliability.brier,
    tolerance: abs(BRIER_TIE),
  },
  {
    key: 'validRate',
    label: 'Respuestas válidas',
    pillar: 'reliability',
    better: 'higher',
    format: 'pct',
    primary: true,
    hint: 'Clasificaciones con una subcuenta válida (sin inválidos, errores ni timeouts). Vota en Confiabilidad (empate si difieren en 1 clasificación o menos).',
    pick: (m) => m.reliability.validRate,
    tolerance: items(VALID_RATE_TIE_ITEMS, minN((m) => m.counts.completed)),
  },
  {
    key: 'auroc',
    label: 'AUROC confianza → acierto',
    pillar: 'reliability',
    better: 'higher',
    format: 'num',
    digits: 3,
    primary: true,
    hint: `Capacidad de la confianza para separar aciertos de errores (0,5 = azar, 1 = perfecta). Desempata Confiabilidad (tolerancia ±${num(AUROC_TIE)}).`,
    pick: (m) => m.reliability.auroc,
    tolerance: abs(AUROC_TIE),
  },
  {
    key: 'mce',
    label: 'MCE (peor intervalo)',
    pillar: 'reliability',
    better: 'lower',
    format: 'num',
    digits: 3,
    hint: 'Mayor brecha entre confianza y acierto en un intervalo de confianza.',
    pick: (m) => m.reliability.mce,
  },
  {
    key: 'overconfidentRate',
    label: `Errores sobreconfiados (≥ ${pct(OVERCONFIDENT_THRESHOLD, 0)})`,
    pillar: 'reliability',
    better: 'lower',
    format: 'pct',
    hint: `Respuestas equivocadas con confianza de ${pct(OVERCONFIDENT_THRESHOLD, 0)} o más, sobre las respuestas con confianza.`,
    pick: (m) => m.reliability.overconfidentErrors.rate,
  },
  {
    key: 'meanConfidenceCorrect',
    label: 'Confianza media en aciertos',
    pillar: 'reliability',
    better: 'higher',
    format: 'pct',
    hint: 'Confianza promedio declarada cuando acertó.',
    pick: (m) => m.reliability.meanConfidenceCorrect,
  },
  {
    key: 'meanConfidenceWrong',
    label: 'Confianza media en errores',
    pillar: 'reliability',
    better: 'lower',
    format: 'pct',
    hint: 'Confianza promedio declarada cuando se equivocó (menor es mejor: sabe cuándo duda).',
    pick: (m) => m.reliability.meanConfidenceWrong,
  },
  {
    key: 'confidenceCoverage',
    label: 'Respuestas con confianza',
    pillar: 'reliability',
    better: 'higher',
    format: 'pct',
    hint: 'Respuestas válidas que traen confianza (base de la calibración).',
    pick: (m) => m.reliability.confidenceCoverage,
  },
  {
    key: 'agreementRate',
    label: 'Consistencia entre repeticiones',
    pillar: 'reliability',
    better: 'higher',
    format: 'pct',
    optional: true,
    hint: 'Conceptos con la misma salida en todas sus repeticiones ("sin respuesta" cuenta como una salida).',
    pick: (m) => m.reliability.consistency?.agreementRate ?? null,
  },
  {
    key: 'accuracyStd',
    label: 'Variación del acierto entre repeticiones (σ)',
    pillar: 'reliability',
    better: 'lower',
    format: 'pct',
    optional: true,
    hint: 'Desviación estándar muestral del acierto de cada repetición.',
    pick: (m) => m.reliability.consistency?.accuracyStd ?? null,
  },
  {
    key: 'multiclassBrier',
    label: 'Brier multiclase',
    pillar: 'reliability',
    better: 'lower',
    format: 'num',
    digits: 3,
    informative: true,
    optional: true,
    hint: 'Sobre la distribución completa de probabilidades, cuando el motor la entrega (0 = perfecto, 2 = peor). Informativo: no entra al veredicto.',
    pick: (m) => m.reliability.multiclassBrier,
  },
  // ── Time
  {
    key: 'latencyP50',
    label: 'Latencia p50',
    pillar: 'time',
    better: 'lower',
    format: 'ms',
    primary: true,
    hint: `Mediana de la latencia extremo a extremo por clasificación. Decide Tiempo (empate si difieren ≤ ${pct(TIME_TIE_REL, 0)}).`,
    pick: (m) => m.timing.latency?.p50 ?? null,
    tolerance: rel(TIME_TIE_REL),
    ratioWord: 'más rápido',
  },
  {
    key: 'latencyP95',
    label: 'Latencia p95',
    pillar: 'time',
    better: 'lower',
    format: 'ms',
    primary: true,
    hint: 'El 95 % de las clasificaciones tardó menos que esto (cola). Primer desempate de Tiempo.',
    pick: (m) => m.timing.latency?.p95 ?? null,
    tolerance: rel(TIME_TIE_REL),
    ratioWord: 'más rápido',
  },
  {
    key: 'wallTime',
    label: 'Tiempo total del lote',
    pillar: 'time',
    better: 'lower',
    format: 'ms',
    primary: true,
    hint: 'De la primera a la última clasificación del carril. Segundo desempate de Tiempo.',
    pick: (m) => m.timing.wallTimeMs,
    tolerance: rel(TIME_TIE_REL),
    ratioWord: 'más rápido',
  },
  {
    key: 'latencyMean',
    label: 'Latencia media',
    pillar: 'time',
    better: 'lower',
    format: 'ms',
    hint: 'Promedio de la latencia extremo a extremo.',
    pick: (m) => m.timing.latency?.mean ?? null,
    ratioWord: 'más rápido',
  },
  {
    key: 'latencyP90',
    label: 'Latencia p90',
    pillar: 'time',
    better: 'lower',
    format: 'ms',
    hint: 'El 90 % de las clasificaciones tardó menos que esto.',
    pick: (m) => m.timing.latency?.p90 ?? null,
    ratioWord: 'más rápido',
  },
  {
    key: 'providerLatencyP50',
    label: 'Latencia del proveedor p50',
    pillar: 'time',
    better: 'lower',
    format: 'ms',
    optional: true,
    hint: 'Mediana del tiempo de la llamada al proveedor medido en el servidor (incluye reintentos).',
    pick: (m) => m.timing.providerLatency?.p50 ?? null,
    ratioWord: 'más rápido',
  },
  {
    key: 'throughput',
    label: 'Clasificaciones por minuto',
    pillar: 'time',
    better: 'higher',
    format: 'num',
    digits: 1,
    hint: 'Clasificaciones completadas por minuto de tiempo total.',
    pick: (m) => m.timing.throughputPerMin,
    tolerance: rel(0.01),
    ratioWord: 'más',
  },
  // ── Cost (informative pillar)
  {
    key: 'costTotal',
    label: 'Costo total',
    pillar: 'cost',
    better: 'lower',
    format: 'usd',
    hint: 'USD de la corrida: tokens que reporta cada proveedor × precio por millón de tokens del modelo. Vacío si algún registro facturable no trae costo.',
    hintFor: (g, j) => {
      const estimated = [g, j].filter((m) => m.cost.estimated).length
      if (estimated === 0) {
        return 'USD de la corrida: tokens que reporta cada proveedor × precio por millón de tokens del modelo. Vacío si algún registro facturable no trae costo.'
      }
      return `USD ${estimated === 2 ? 'estimados' : 'de la corrida (el carril simulado es un estimado)'}: los motores simulados inventan tokens y costo. Vacío si algún registro facturable no trae costo.`
    },
    pick: (m) => m.cost.costUsd ?? null,
    ratioWord: 'más barato',
  },
  {
    key: 'costPerClassification',
    label: 'Costo por clasificación',
    pillar: 'cost',
    better: 'lower',
    format: 'usd',
    hint: 'USD por clasificación completada.',
    pick: (m) => m.cost.costPerClassificationUsd ?? null,
    ratioWord: 'más barato',
  },
  {
    key: 'inputTokens',
    label: 'Tokens de entrada',
    pillar: 'cost',
    better: 'lower',
    format: 'num',
    digits: 0,
    informative: true,
    hint: 'Informativo: cada proveedor tokeniza distinto.',
    pick: (m) => (m.cost.usageRecords > 0 ? m.cost.inputTokens : null),
  },
  {
    key: 'outputTokens',
    label: 'Tokens de salida',
    pillar: 'cost',
    better: 'lower',
    format: 'num',
    digits: 0,
    informative: true,
    hint: 'Informativo: cada proveedor tokeniza distinto (incluye razonamiento oculto en modelos de razonamiento).',
    pick: (m) => (m.cost.usageRecords > 0 ? m.cost.outputTokens : null),
  },
]

function defaultTolerance(def: RowDef): Tolerance {
  switch (def.format) {
    case 'pct':
      return { kind: 'abs', value: 0.5 * 10 ** -((def.digits ?? 1) + 2) } // half a display unit
    case 'num':
      return { kind: 'abs', value: 0.5 * 10 ** -(def.digits ?? 3) }
    default:
      return { kind: 'rel', value: 0.01 }
  }
}

function signed(text: string, positive: boolean): string {
  return positive ? `+${text}` : text
}

/** Advantage of the winner over the loser, formatted for the row. */
function deltaText(def: RowDef, winner: number, loser: number): string {
  const d = winner - loser
  if (def.ratioWord && winner > 0 && loser > 0) {
    const r = def.better === 'lower' ? loser / winner : winner / loser
    if (r >= 1.05) return `${times(r)} ${def.ratioWord}`
  }
  switch (def.format) {
    case 'pct':
      return pp(d, def.digits ?? 1)
    case 'num':
      return signed(num(d, def.digits ?? 3), d > 0)
    case 'ms':
      return signed(ms(d), d > 0)
    case 'usd':
      return signed(usd(d), d > 0)
    case 'p':
      return ''
  }
}

function buildRow(def: RowDef, g: LaneMetrics, j: LaneMetrics): ComparisonRow | null {
  const gv = def.pick(g)
  const jv = def.pick(j)
  if (def.optional && gv === null && jv === null) return null
  const winner = def.informative ? null : decide(gv, jv, def.better, def.tolerance ? def.tolerance(g, j) : defaultTolerance(def))
  let text = ''
  if (gv !== null && jv !== null && (winner === 'gpt' || winner === 'jev')) {
    text = winner === 'gpt' ? deltaText(def, gv, jv) : deltaText(def, jv, gv)
  }
  return {
    key: def.key,
    label: def.label,
    pillar: def.pillar,
    gpt: gv,
    jev: jv,
    better: def.better,
    winner,
    delta: gv !== null && jv !== null ? jv - gv : null,
    deltaText: text,
    format: def.format,
    ...(def.digits !== undefined ? { digits: def.digits } : {}),
    primary: def.primary ?? false,
    ...(def.informative ? { informative: true } : {}),
    hint: def.hintFor ? def.hintFor(g, j) : def.hint,
  }
}

function pValueRow(paired: PairedTest): ComparisonRow {
  const p = paired.pairs > 0 ? paired.pValue : null
  return {
    key: 'pValue',
    label: 'Significancia de la diferencia de acierto',
    pillar: 'score',
    gpt: p,
    jev: p,
    better: 'lower',
    winner: null,
    delta: null,
    deltaText: '',
    format: 'p',
    primary: false,
    informative: true,
    shared: true,
    hint: `${paired.testName} sobre los pares (mismo concepto y repetición). p < ${num(SIGNIFICANCE_ALPHA, 2)} = diferencia significativa.`,
  }
}

/** Comparison rows (score, reliability, time, cost), with a winner per metric. */
export function buildRows(g: LaneMetrics, j: LaneMetrics, paired: PairedTest): ComparisonRow[] {
  const rows: ComparisonRow[] = []
  for (const def of ROWS) {
    const row = buildRow(def, g, j)
    if (row) rows.push(row)
    if (def.key === 'accuracy') rows.push(pValueRow(paired))
  }
  return rows
}

// ─────────────────────────────── Pillars ───────────────────────────────

const N = ENGINE_LABELS

function isEngine(w: Winner): w is EngineId {
  return w === 'gpt' || w === 'jev'
}

function fmtItems(x: number): string {
  return Math.abs(x - Math.round(x)) < 1e-6 ? int(x) : num(x, 1)
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

function missingLanes(g: LaneMetrics, j: LaneMetrics, has: (m: LaneMetrics) => boolean): string {
  const missing = ENGINE_IDS.filter((e) => !has(e === 'gpt' ? g : j)).map((e) => N[e])
  return joinEs(missing)
}

function scoreVerdict(g: LaneMetrics, j: LaneMetrics, paired: PairedTest): PillarVerdict {
  const label = PILLAR_LABELS.score
  const ga = g.score.accuracy
  const ja = j.score.accuracy
  const p = paired.pairs > 0 ? paired.pValue : null
  const significant = p !== null && p < SIGNIFICANCE_ALPHA
  if (ga === null || ja === null) {
    return {
      pillar: 'score',
      label,
      winner: null,
      decidedBy: null,
      detail: '',
      reasons: [`Sin clasificaciones en ${missingLanes(g, j, (m) => m.score.accuracy !== null)}.`],
      pValue: p,
      significant: false,
    }
  }
  const n = Math.min(g.counts.completed, j.counts.completed)
  const winner = decide(ga, ja, 'higher', { kind: 'items', value: SCORE_TIE_ITEMS, n })
  const reasons = [
    `Acierto: GPT ${pct(ga)} (${g.score.correct}/${g.score.n}) vs. Jev ${pct(ja)} (${j.score.correct}/${j.score.n}).`,
  ]
  const gapItems = Math.abs(ga - ja) * n
  let detail: string
  if (isEngine(winner)) {
    const delta = Math.abs(ga - ja)
    reasons.push(
      `Gana ${N[winner]} por ${pp(delta)} (equivale a ${fmtItems(gapItems)} ${plural(Math.round(gapItems), 'clasificación', 'clasificaciones')}; empate si es ${SCORE_TIE_ITEMS} o menos).`,
    )
    detail = `${pp(delta)}, diferencia ${significant ? `significativa, ${pValue(p)}` : 'no significativa'}`
  } else {
    reasons.push(
      `Empate: la diferencia equivale a ${fmtItems(gapItems)} ${plural(Math.round(gapItems), 'clasificación', 'clasificaciones')} (tolerancia: ${SCORE_TIE_ITEMS}).`,
    )
    detail = `diferencia de ${SCORE_TIE_ITEMS} ${plural(SCORE_TIE_ITEMS, 'clasificación', 'clasificaciones')} o menos`
  }
  if (p === null) {
    reasons.push('Sin pares comparables (mismo concepto y repetición) para la prueba de significancia.')
  } else {
    const verdict = significant ? 'Diferencia significativa' : 'Diferencia no significativa'
    const counts =
      paired.repetitions > 1
        ? `${paired.itemTest.gptBetter} conceptos a favor de GPT vs. ${paired.itemTest.jevBetter} a favor de Jev`
        : `${paired.gptOnly} aciertos solo de GPT vs. ${paired.jevOnly} solo de Jev`
    reasons.push(`${verdict} (${paired.testName}, ${pValue(p)}, α = ${num(SIGNIFICANCE_ALPHA, 2)}; ${counts}).`)
  }
  return {
    pillar: 'score',
    label,
    winner,
    decidedBy: isEngine(winner) || winner === 'tie' ? 'accuracy' : null,
    detail,
    reasons,
    pValue: p,
    significant,
  }
}

function outcomeText(w: Winner, tieNote: string): string {
  if (isEngine(w)) return `gana ${N[w]}`
  if (w === 'tie') return `empate (${tieNote})`
  return 'sin datos'
}

function reliabilityVerdict(g: LaneMetrics, j: LaneMetrics): PillarVerdict {
  const label = PILLAR_LABELS.reliability
  const n = Math.min(g.counts.completed, j.counts.completed)
  const metrics = [
    {
      key: 'ece',
      name: 'ECE',
      g: g.reliability.ece,
      j: j.reliability.ece,
      w: decide(g.reliability.ece, j.reliability.ece, 'lower', { kind: 'abs', value: ECE_TIE }),
      fmt: (v: number) => num(v),
      tieNote: `±${num(ECE_TIE)}`,
    },
    {
      key: 'brier',
      name: 'Brier',
      g: g.reliability.brier,
      j: j.reliability.brier,
      w: decide(g.reliability.brier, j.reliability.brier, 'lower', { kind: 'abs', value: BRIER_TIE }),
      fmt: (v: number) => num(v),
      tieNote: `±${num(BRIER_TIE)}`,
    },
    {
      key: 'validRate',
      name: 'Respuestas válidas',
      g: g.reliability.validRate,
      j: j.reliability.validRate,
      w: decide(g.reliability.validRate, j.reliability.validRate, 'higher', { kind: 'items', value: VALID_RATE_TIE_ITEMS, n }),
      fmt: (v: number) => pct(v),
      tieNote: `${VALID_RATE_TIE_ITEMS} clasificación o menos`,
    },
  ]
  const votes = { gpt: 0, jev: 0, tie: 0, abstain: 0 }
  const reasons: string[] = []
  for (const m of metrics) {
    if (isEngine(m.w)) votes[m.w] += 1
    else if (m.w === 'tie') votes.tie += 1
    else votes.abstain += 1
    const gs = m.g === null ? '—' : m.fmt(m.g)
    const js = m.j === null ? '—' : m.fmt(m.j)
    reasons.push(`${m.name}: GPT ${gs} vs. Jev ${js} → ${outcomeText(m.w, m.tieNote)}.`)
  }
  reasons.push(
    `Votos: GPT ${votes.gpt}, Jev ${votes.jev}, empates ${votes.tie}${votes.abstain > 0 ? `, sin datos ${votes.abstain}` : ''}.`,
  )

  if (votes.abstain === metrics.length) {
    return { pillar: 'reliability', label, winner: null, decidedBy: null, detail: '', reasons, votes }
  }
  if (votes.gpt !== votes.jev) {
    const winner: EngineId = votes.gpt > votes.jev ? 'gpt' : 'jev'
    const loser: EngineId = winner === 'gpt' ? 'jev' : 'gpt'
    return {
      pillar: 'reliability',
      label,
      winner,
      decidedBy: 'votes',
      detail: `${votes[winner]} ${plural(votes[winner], 'voto', 'votos')} contra ${votes[loser]}`,
      reasons,
      votes,
    }
  }
  const ga = g.reliability.auroc
  const ja = j.reliability.auroc
  const tb = decide(ga, ja, 'higher', { kind: 'abs', value: AUROC_TIE })
  reasons.push(
    `Desempate por AUROC: GPT ${ga === null ? '—' : num(ga)} vs. Jev ${ja === null ? '—' : num(ja)} → ${outcomeText(tb, `±${num(AUROC_TIE)}`)}.`,
  )
  if (isEngine(tb)) {
    return { pillar: 'reliability', label, winner: tb, decidedBy: 'auroc', detail: 'desempate por AUROC', reasons, votes }
  }
  return { pillar: 'reliability', label, winner: 'tie', decidedBy: null, detail: 'votos empatados', reasons, votes }
}

function timeVerdict(g: LaneMetrics, j: LaneMetrics): PillarVerdict {
  const label = PILLAR_LABELS.time
  const steps = [
    { key: 'latencyP50', name: 'Latencia p50', g: g.timing.latency?.p50 ?? null, j: j.timing.latency?.p50 ?? null },
    { key: 'latencyP95', name: 'Desempate por latencia p95', g: g.timing.latency?.p95 ?? null, j: j.timing.latency?.p95 ?? null },
    { key: 'wallTime', name: 'Desempate por tiempo total', g: g.timing.wallTimeMs, j: j.timing.wallTimeMs },
  ]
  const reasons: string[] = []
  if (steps[0].g === null || steps[0].j === null) {
    reasons.push(`Sin latencias en ${missingLanes(g, j, (m) => m.timing.latency !== null)}.`)
    return { pillar: 'time', label, winner: null, decidedBy: null, detail: '', reasons }
  }
  const tol: Tolerance = { kind: 'rel', value: TIME_TIE_REL }
  for (const [i, s] of steps.entries()) {
    const w = decide(s.g, s.j, 'lower', tol)
    const gs = s.g === null ? '—' : ms(s.g)
    const js = s.j === null ? '—' : ms(s.j)
    if (isEngine(w)) {
      const win = (w === 'gpt' ? s.g : s.j) as number
      const lose = (w === 'gpt' ? s.j : s.g) as number
      const speed = win > 0 ? `${times(lose / win)} más rápido` : 'más rápido'
      reasons.push(`${s.name}: GPT ${gs} vs. Jev ${js} → gana ${N[w]} (${speed}).`)
      const metric = i === 0 ? 'p50' : i === 1 ? 'desempate por p95' : 'desempate por tiempo total'
      return { pillar: 'time', label, winner: w, decidedBy: s.key, detail: `${metric}, ${speed}`, reasons }
    }
    reasons.push(`${s.name}: GPT ${gs} vs. Jev ${js} → ${outcomeText(w, `diferencia ≤ ${pct(TIME_TIE_REL, 0)}`)}.`)
  }
  return { pillar: 'time', label, winner: 'tie', decidedBy: null, detail: `diferencias ≤ ${pct(TIME_TIE_REL, 0)}`, reasons }
}

// ─────────────────────────────── Overall ───────────────────────────────

/** Spanish list: "A", "A y B", "A, B y C". */
export function joinEs(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}`
}

function overallVerdict(pillars: Record<Pillar, PillarVerdict>): OverallVerdict {
  const won: Record<EngineId, Pillar[]> = { gpt: [], jev: [] }
  const tied: Pillar[] = []
  const none: Pillar[] = []
  for (const p of PILLARS) {
    const w = pillars[p].winner
    if (isEngine(w)) won[w].push(p)
    else if (w === 'tie') tied.push(p)
    else none.push(p)
  }
  const pillarsWon = { gpt: won.gpt.length, jev: won.jev.length }

  let winner: Winner
  let decidedByScore = false
  if (none.length === PILLARS.length) winner = null
  else if (pillarsWon.gpt !== pillarsWon.jev) winner = pillarsWon.gpt > pillarsWon.jev ? 'gpt' : 'jev'
  else if (isEngine(pillars.score.winner)) {
    winner = pillars.score.winner
    decidedByScore = true
  } else winner = 'tie'

  const scoreDetail = pillars.score.detail
  const names = (ps: readonly Pillar[]) => joinEs(ps.map((p) => PILLAR_LABELS[p]))
  /** Pillar list with the Score detail attached when Score is in it. */
  const clause = (ps: readonly Pillar[]) => {
    if (!ps.includes('score') || !scoreDetail) return names(ps)
    return ps.length === 1 ? `${names(ps)} (${scoreDetail})` : `${names(ps)} (Score: ${scoreDetail})`
  }

  let summary: string
  if (winner === null) {
    summary = 'Aún no hay datos suficientes para comparar los carriles.'
  } else if (isEngine(winner) && !decidedByScore) {
    const loser: EngineId = winner === 'gpt' ? 'jev' : 'gpt'
    const mine = won[winner]
    const scoreNote = mine.includes('score') && scoreDetail ? (mine.length === 1 ? `: ${scoreDetail}` : `; Score: ${scoreDetail}`) : ''
    const parts = [`${N[winner]} gana ${mine.length} de ${PILLARS.length} pilares (${names(mine)}${scoreNote})`]
    if (won[loser].length > 0) parts.push(`${N[loser]} gana en ${clause(won[loser])}`)
    if (tied.length > 0) parts.push(`empate en ${clause(tied)}`)
    if (none.length > 0) parts.push(`sin datos en ${names(none)}`)
    summary = `${parts.join('; ')}.`
  } else if (isEngine(winner)) {
    const loser: EngineId = winner === 'gpt' ? 'jev' : 'gpt'
    const parts = [`${N[winner]} gana por desempate en Score (${scoreDetail})`]
    if (won[loser].length > 0) parts.push(`${N[loser]} gana en ${clause(won[loser])}`)
    if (tied.length > 0) parts.push(`empate en ${clause(tied)}`)
    if (none.length > 0) parts.push(`sin datos en ${names(none)}`)
    summary = `${parts.join('; ')}.`
  } else if (pillarsWon.gpt === 0) {
    summary = `Empate en ${clause(tied)}${none.length > 0 ? `; sin datos en ${names(none)}` : ''}.`
  } else {
    const parts = ENGINE_IDS.map((e) => `${N[e]} gana en ${clause(won[e])}`)
    if (tied.length > 0) parts.push(`empate en ${clause(tied)}`)
    if (none.length > 0) parts.push(`sin datos en ${names(none)}`)
    summary = `Empate: ${parts.join('; ')}.`
  }

  const reasons = PILLARS.map((p) => {
    const v = pillars[p]
    const outcome = isEngine(v.winner) ? `gana ${N[v.winner]}` : v.winner === 'tie' ? 'empate' : 'sin datos'
    return `${v.label}: ${outcome}${v.detail ? ` (${v.detail})` : ''}.`
  })
  reasons.push(
    decidedByScore
      ? `Pilares empatados ${pillarsWon.gpt}–${pillarsWon.jev}: decide Score.`
      : 'Regla: gana quien gane más pilares; si empatan, decide Score.',
  )

  return {
    winner,
    pillarsWon,
    pillarsTied: tied.length,
    pillarsWithoutData: none.length,
    decidedByScore,
    summary,
    reasons,
  }
}

// ─────────────────────────────── Validity ───────────────────────────────

export function assessValidity(g: LaneMetrics, j: LaneMetrics, paired: PairedTest): ComparisonValidity {
  const issues: ValidityIssue[] = []
  const add = (code: ValidityCode, message: string, blocking: boolean, engine?: EngineId) =>
    issues.push({ code, message, blocking, ...(engine ? { engine } : {}) })

  for (const e of ENGINE_IDS) {
    const m = e === 'gpt' ? g : j
    const name = N[e]
    const { completed, scheduled } = m.counts
    if (completed === 0) add('no_data', `${name} aún no tiene clasificaciones.`, true, e)
    if (m.engine !== null && m.engine !== e) add('engine_mismatch', `El carril de ${name} trae registros de ${N[m.engine]}.`, true, e)
    if (m.mode === 'mock') add('mock', `${name} corrió en modo simulado: los resultados no reflejan el modelo real.`, true, e)
    if (m.mode === 'mixed') add('mixed_mode', `${name} mezcla clasificaciones reales y simuladas.`, true, e)
    if (m.runStatus === 'aborted') add('aborted', `La corrida de ${name} fue abortada (${completed} de ${scheduled}).`, true, e)
    else if (m.runStatus === 'running' || m.runStatus === 'idle')
      add('running', `La corrida de ${name} no ha terminado (${completed} de ${scheduled}).`, true, e)
    else if (m.counts.pending > 0) add('incomplete', `La corrida de ${name} está incompleta (${completed} de ${scheduled}).`, true, e)

    if (m.models.length > 1) add('multiple_models', `${name} respondió con varios modelos (${m.models.join(', ')}).`, false, e)
    if (m.counts.duplicates > 0)
      add('duplicates', `${name}: ${m.counts.duplicates} registros repetidos ignorados (se usa el último).`, false, e)
    const fr = m.counts.failureRate
    if (fr !== null && fr > MAX_FAILURE_RATE)
      add(
        'high_failure_rate',
        `${name} tuvo ${pct(fr)} de errores o timeouts: cuentan como fallo en Score, su latencia incluye esas llamadas (un error rápido la acorta, un timeout la alarga) y su calibración usa menos respuestas.`,
        false,
        e,
      )
    if (m.counts.rerun > 0)
      add(
        'rerun',
        `${name}: ${m.counts.rerun} ${m.counts.rerun === 1 ? 'clasificación viene' : 'clasificaciones vienen'} de «Reintentar fallidos»: tuvieron una segunda oportunidad y su latencia se midió en otras condiciones de carga.`,
        false,
        e,
      )
    const cov = m.reliability.confidenceCoverage
    if (cov !== null && cov < MIN_CONFIDENCE_COVERAGE)
      add(
        'low_confidence_coverage',
        cov === 0
          ? `${name} no declaró confianza en ninguna respuesta: no se puede medir su calibración.`
          : `Solo ${pct(cov)} de las respuestas de ${name} traen confianza: su calibración es parcial.`,
        false,
        e,
      )
  }

  if (g.mode !== null && j.mode !== null && g.mode !== j.mode)
    add('mode_mismatch', `Los carriles corrieron en modos distintos (GPT: ${MODE_LABELS[g.mode]}, Jev: ${MODE_LABELS[j.mode]}).`, true)
  if (paired.unmatchedGpt > 0 || paired.unmatchedJev > 0)
    add(
      'coverage_mismatch',
      `Los carriles no cubren los mismos conceptos: ${paired.unmatchedGpt} solo en GPT y ${paired.unmatchedJev} solo en Jev.`,
      true,
    )
  if (paired.labelMismatches > 0)
    add('label_mismatch', `${paired.labelMismatches} pares tienen etiqueta esperada distinta en cada carril.`, true)

  const ordered = [...issues.filter((i) => i.blocking), ...issues.filter((i) => !i.blocking)]
  return {
    validForComparison: !ordered.some((i) => i.blocking),
    warnings: ordered.map((i) => i.message),
    issues: ordered,
  }
}

// ─────────────────────────────── Entry point ───────────────────────────────

export function compareLanes(input: { gpt: LaneInput; jev: LaneInput }): Comparison {
  const g = input.gpt.metrics
  const j = input.jev.metrics
  const paired = pairedTest(input.gpt.records, input.jev.records)
  const pillars: Record<Pillar, PillarVerdict> = {
    score: scoreVerdict(g, j, paired),
    reliability: reliabilityVerdict(g, j),
    time: timeVerdict(g, j),
  }
  return {
    rows: buildRows(g, j, paired),
    pillars,
    overall: overallVerdict(pillars),
    paired,
    validity: assessValidity(g, j, paired),
  }
}
