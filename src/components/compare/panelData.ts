/**
 * Pure view-model helpers for the comparison panel (no React): grouping of table rows, help
 * lines, verdict / validity wording, paired-test interpretation and the "partial" state.
 */
import { ENGINE_LABELS, PILLARS, PILLAR_LABELS, pValue, SIGNIFICANCE_ALPHA, num } from '../../metrics/index.ts'
import type {
  Better,
  ComparisonRow,
  ComparisonValidity,
  PairedTest,
  Pillar,
  PillarVerdict,
  RowPillar,
  ValidityCode,
  ValidityIssue,
  Winner,
} from '../../metrics/index.ts'
import type { EngineId, LaneStatus } from '../../shared/contracts.ts'
import { ENGINE_THEME } from '../ui/theme.ts'

// ─────────────────────────────── Winners ───────────────────────────────

export function isEngineWinner(w: Winner | undefined): w is EngineId {
  return w === 'gpt' || w === 'jev'
}

/** "GPT", "Jev", "Empate" or "Sin datos". */
export function winnerLabel(w: Winner | undefined): string {
  if (isEngineWinner(w)) return ENGINE_LABELS[w]
  return w === 'tie' ? 'Empate' : 'Sin datos'
}

/** Headline of a verdict: "Gana GPT", "Empate" or "Sin datos". */
export function winnerHeadline(w: Winner | undefined): string {
  return isEngineWinner(w) ? `Gana ${ENGINE_LABELS[w]}` : winnerLabel(w)
}

export function directionLabel(better: Better): string {
  return better === 'lower' ? 'menor es mejor' : 'mayor es mejor'
}

/** Accent color (CSS variable) of a winner: the engine's series color, neutral for a tie / no data. */
export function winnerAccent(winner: Winner | undefined): string {
  return isEngineWinner(winner) ? ENGINE_THEME[winner].chart : 'var(--cmp-axis)'
}

// ─────────────────────────────── Table rows ───────────────────────────────

export const TABLE_PILLARS: readonly RowPillar[] = [...PILLARS, 'cost']

export interface RowGroup {
  pillar: RowPillar
  label: string
  rows: ComparisonRow[]
}

/** Comparison rows grouped by pillar (score, reliability, time, cost), keeping their order; empty groups dropped. */
export function groupRows(rows: readonly ComparisonRow[]): RowGroup[] {
  return TABLE_PILLARS.map((pillar) => ({
    pillar,
    label: PILLAR_LABELS[pillar],
    rows: rows.filter((r) => r.pillar === pillar),
  })).filter((g) => g.rows.length > 0)
}

/** First sentence of a hint: the one-line explanation shown under the metric name. */
export function helpLine(hint: string | undefined): string {
  if (!hint) return ''
  const m = /^(.+?[.!?])(?:\s+(?=[A-ZÁÉÍÓÚÑ¿¡0-9])|$)/.exec(hint.trim())
  return (m ? m[1] : hint).trim()
}

/** Row label used when a verdict was decided by a row key. */
export function decidedByLabel(verdict: PillarVerdict, rows: readonly ComparisonRow[]): string | null {
  if (verdict.decidedBy === null) return null
  if (verdict.decidedBy === 'votes') return 'Mayoría de votos (ECE, Brier y respuestas válidas)'
  return rows.find((r) => r.key === verdict.decidedBy)?.label ?? verdict.decidedBy
}

/** Keys of the rows shown head to head inside each pillar card. */
export const PILLAR_FOCUS: Record<Pillar, readonly string[]> = {
  score: ['accuracy', 'groupAccuracy', 'macroF1'],
  reliability: ['ece', 'brier', 'validRate', 'auroc'],
  time: ['latencyP50', 'latencyP95', 'wallTime'],
}

export function focusRows(pillar: Pillar, rows: readonly ComparisonRow[]): ComparisonRow[] {
  return PILLAR_FOCUS[pillar].map((key) => rows.find((r) => r.key === key)).filter((r): r is ComparisonRow => r !== undefined)
}

// ─────────────────────────────── Validity ───────────────────────────────

export interface ValidityView {
  valid: boolean
  /** "No válido para evaluar eficacia", "Válido para comparar, con advertencias" or "Válido para comparar". */
  title: string
  /** One sentence explaining the most serious reason (empty when valid without cautions). */
  lead: string
  blocking: ValidityIssue[]
  /** Non-blocking issues serious enough to turn a valid banner into a warning (see `CAUTION_CODES`). */
  cautions: ValidityIssue[]
  /** The other non-blocking issues. */
  notes: ValidityIssue[]
}

const SIMULATED: ReadonlySet<ValidityCode> = new Set(['mock', 'mixed_mode', 'mode_mismatch'])
const UNPAIRED: ReadonlySet<ValidityCode> = new Set(['coverage_mismatch', 'label_mismatch', 'engine_mismatch'])
/** Valid, but the banner must not stay green: many errors / timeouts (> MAX_FAILURE_RATE). */
export const CAUTION_CODES: ReadonlySet<ValidityCode> = new Set(['high_failure_rate'])

export function validityView(validity: ComparisonValidity): ValidityView {
  const blocking = validity.issues.filter((i) => i.blocking)
  const cautions = validity.issues.filter((i) => !i.blocking && CAUTION_CODES.has(i.code))
  const notes = validity.issues.filter((i) => !i.blocking && !CAUTION_CODES.has(i.code))
  if (validity.validForComparison) {
    return cautions.length > 0
      ? {
          valid: true,
          title: 'Válido para comparar, con advertencias',
          lead: 'Ambos carriles reales, corrida completa y mismos conceptos, pero con muchos errores o timeouts: lee el resultado con cautela.',
          blocking,
          cautions,
          notes,
        }
      : { valid: true, title: 'Válido para comparar', lead: '', blocking, cautions, notes }
  }
  const codes = new Set(blocking.map((i) => i.code))
  const has = (set: ReadonlySet<ValidityCode>) => blocking.some((i) => set.has(i.code))
  let lead: string
  if (has(SIMULATED)) {
    lead =
      'Al menos un carril corrió en modo simulado (o los modos no coinciden): sirve para probar la interfaz, no para decidir qué motor clasifica mejor.'
  } else if (has(UNPAIRED)) {
    lead = 'Los carriles no se pueden emparejar concepto a concepto: la comparación no es justa.'
  } else if (codes.has('aborted')) {
    lead = 'La corrida se abortó: los resultados son parciales y el veredicto no es concluyente.'
  } else {
    lead = 'La corrida aún no termina: los resultados son parciales y el veredicto puede cambiar.'
  }
  return { valid: false, title: 'No válido para evaluar eficacia', lead, blocking, cautions, notes }
}

// ─────────────────────────────── Partial state ───────────────────────────────

export interface PartialState {
  partial: boolean
  /** "parcial · en vivo", "parcial · corrida incompleta" or ''. */
  label: string
}

/** The panel is "parcial" while the run is live and when the finished run is incomplete / aborted. */
export function partialState(
  status: LaneStatus,
  lanes: readonly { pending: number; runStatus: LaneStatus | null }[],
): PartialState {
  if (status === 'running') return { partial: true, label: 'parcial · en vivo' }
  const incomplete = lanes.some((l) => l.pending > 0 || l.runStatus === 'aborted' || l.runStatus === 'running')
  return incomplete ? { partial: true, label: 'parcial · corrida incompleta' } : { partial: false, label: '' }
}

// ─────────────────────────────── Paired test ───────────────────────────────

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

/** Plain-language reading of the paired test: who won the disagreements and whether it can be chance. */
export function pairedInterpretation(p: PairedTest): string {
  if (p.pairs === 0) {
    return 'Aún no hay conceptos clasificados por ambos carriles: la prueba pareada necesita pares comparables.'
  }
  const discordant = p.gptOnly + p.jevOnly
  if (discordant === 0) {
    return `Los dos motores coincidieron en los ${p.pairs} ${plural(p.pairs, 'par', 'pares')} (acertaron o fallaron juntos): no hay desacuerdos que permitan distinguirlos.`
  }
  const alpha = num(SIGNIFICANCE_ALPHA, 2)
  const parts = [
    `En ${discordant} de ${p.pairs} ${plural(p.pairs, 'par', 'pares')} los motores discreparon: solo GPT acertó en ${p.gptOnly} y solo Jev en ${p.jevOnly}.`,
  ]
  let gptLead = p.gptOnly
  let jevLead = p.jevOnly
  if (p.repetitions > 1) {
    parts.push(
      `Como hay repeticiones del mismo concepto (no independientes), la prueba cuenta conceptos: ${p.itemTest.gptBetter} a favor de GPT, ${p.itemTest.jevBetter} a favor de Jev y ${p.itemTest.ties} sin diferencia.`,
    )
    gptLead = p.itemTest.gptBetter
    jevLead = p.itemTest.jevBetter
  }
  const leader = gptLead > jevLead ? 'GPT' : jevLead > gptLead ? 'Jev' : null
  if (p.significant) {
    parts.push(
      `${pValue(p.pValue)} (α = ${alpha}): la diferencia es estadísticamente significativa${leader ? ` y favorece a ${leader}` : ''}; es poco probable que se deba al azar.`,
    )
  } else {
    parts.push(
      `${pValue(p.pValue)} (α = ${alpha}): la diferencia no es estadísticamente significativa${leader ? ` (ventaja de ${leader})` : ''}; con esta muestra podría deberse al azar, hacen falta más conceptos para concluir.`,
    )
  }
  return parts.join(' ')
}

/** Share of the matched pairs, 0..1 (0 without pairs). */
export function pairShare(count: number, pairs: number): number {
  return pairs > 0 ? count / pairs : 0
}
