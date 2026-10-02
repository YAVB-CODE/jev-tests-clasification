import { describe, expect, it } from 'vitest'
import type { ClassificationRecord, LaneRunInfo } from '../shared/contracts.ts'
import { CATEGORIES, hits, makeLane, makeRecord, makeRun, type LaneSpec } from './__fixtures__/makeRecord.ts'
import type { ReliabilityMetrics } from './calibration.ts'
import {
  AUROC_TIE,
  BRIER_TIE,
  ECE_TIE,
  SCORE_TIE_ITEMS,
  TIME_TIE_REL,
  compareLanes,
  decide,
  isTie,
  joinEs,
  type Comparison,
} from './compare.ts'
import { computeLaneMetrics, type LaneMetrics } from './compute.ts'
import { formatRowValue } from './format.ts'

const N = 60

function lane(spec: LaneSpec, run?: LaneRunInfo) {
  const records = makeLane(spec)
  return {
    records,
    metrics: computeLaneMetrics(records, { categories: CATEGORIES, run: run ?? makeRun(spec.engine, records.length) }),
  }
}

function patchReliability(l: { metrics: LaneMetrics; records: readonly ClassificationRecord[] }, patch: Partial<ReliabilityMetrics>) {
  return { ...l, metrics: { ...l.metrics, reliability: { ...l.metrics.reliability, ...patch } } }
}

/** Jev: always-right-or-honest confidence (0.9 right / 0.3 wrong). */
function honest(correct: readonly boolean[]) {
  return correct.map((ok) => (ok ? 0.9 : 0.3))
}

const row = (c: Comparison, key: string) => {
  const r = c.rows.find((x) => x.key === key)
  if (!r) throw new Error(`row ${key} missing`)
  return r
}

describe('tolerance helpers', () => {
  it('isTie / decide', () => {
    expect(isTie(0.5, 0.5, { kind: 'abs', value: 0 })).toBe(true)
    expect(isTie(0.05, 0.059, { kind: 'abs', value: ECE_TIE })).toBe(true)
    expect(isTie(0.05, 0.0611, { kind: 'abs', value: ECE_TIE })).toBe(false)
    expect(isTie(1000, 1050, { kind: 'rel', value: TIME_TIE_REL })).toBe(true) // 50/1050 = 4,8 %
    expect(isTie(1000, 1060, { kind: 'rel', value: TIME_TIE_REL })).toBe(false) // 5,7 %
    expect(isTie(45 / 60, 44 / 60, { kind: 'items', value: SCORE_TIE_ITEMS, n: 60 })).toBe(true)
    expect(isTie(45 / 60, 43 / 60, { kind: 'items', value: SCORE_TIE_ITEMS, n: 60 })).toBe(false)
    expect(isTie(0.5, 0.6, { kind: 'items', value: 1, n: 0 })).toBe(false)
    expect(decide(null, 1, 'higher', { kind: 'abs', value: 0 })).toBeNull()
    expect(decide(2, 1, 'higher', { kind: 'abs', value: 0 })).toBe('gpt')
    expect(decide(2, 1, 'lower', { kind: 'abs', value: 0 })).toBe('jev')
    expect(joinEs(['Score'])).toBe('Score')
    expect(joinEs(['A', 'B', 'C'])).toBe('A, B y C')
  })
})

describe('compareLanes — the summary example', () => {
  // GPT 45/60 always at 0.95 and slow; Jev 43/60 with honest confidence and fast.
  const gpt = lane({ engine: 'gpt', correct: hits(45, N), confidence: 0.95, latencyMs: 2000 })
  const jev = lane({ engine: 'jev', correct: hits(43, N), confidence: honest(hits(43, N)), latencyMs: 500 })
  const c = compareLanes({ gpt, jev })

  it('Score: GPT by 2 items, not significant', () => {
    expect(c.pillars.score.winner).toBe('gpt')
    expect(c.pillars.score.significant).toBe(false)
    expect(c.pillars.score.pValue).toBeCloseTo(0.5, 12) // b = 2, c = 0
    expect(c.pillars.score.decidedBy).toBe('accuracy')
    expect(c.pillars.score.reasons[0]).toBe('Acierto: GPT 75,0 % (45/60) vs. Jev 71,7 % (43/60).')
  })

  it('Reliability: Jev wins ECE and Brier, validRate ties', () => {
    const r = c.pillars.reliability
    expect(r.winner).toBe('jev')
    expect(r.votes).toEqual({ gpt: 0, jev: 2, tie: 1, abstain: 0 })
    expect(r.decidedBy).toBe('votes')
    expect(gpt.metrics.reliability.ece).toBeCloseTo(0.2, 12)
    expect(jev.metrics.reliability.ece).toBeCloseTo((43 / 60) * 0.1 + (17 / 60) * 0.3, 12)
  })

  it('Time: Jev 4× faster at p50', () => {
    expect(c.pillars.time.winner).toBe('jev')
    expect(c.pillars.time.decidedBy).toBe('latencyP50')
    expect(c.pillars.time.detail).toBe('p50, 4,0× más rápido')
  })

  it('overall: Jev 2 of 3 with the expected sentence', () => {
    expect(c.overall.winner).toBe('jev')
    expect(c.overall.pillarsWon).toEqual({ gpt: 1, jev: 2 })
    expect(c.overall.decidedByScore).toBe(false)
    expect(c.overall.summary).toBe(
      'Jev gana 2 de 3 pilares (Confiabilidad y Tiempo); GPT gana en Score (+3,3 pp, diferencia no significativa).',
    )
    expect(c.overall.reasons).toHaveLength(4)
  })

  it('rows agree with the pillars and format in es-CO', () => {
    const acc = row(c, 'accuracy')
    expect(acc).toMatchObject({ pillar: 'score', winner: 'gpt', primary: true, better: 'higher', format: 'pct', deltaText: '+3,3 pp' })
    expect(acc.delta).toBeCloseTo(43 / 60 - 45 / 60, 12) // jev − gpt
    expect(formatRowValue(acc, 'gpt')).toBe('75,0 %')
    expect(formatRowValue(acc, 'jev')).toBe('71,7 %')

    const p = row(c, 'pValue')
    expect(p).toMatchObject({ shared: true, informative: true, winner: null, format: 'p' })
    expect(p.gpt).toBe(p.jev)
    expect(formatRowValue(p, 'gpt')).toBe('p = 0,50')

    expect(row(c, 'latencyP50')).toMatchObject({ winner: 'jev', deltaText: '4,0× más rápido', primary: true })
    expect(formatRowValue(row(c, 'latencyP50'), 'gpt')).toBe('2,00 s')
    expect(row(c, 'ece')).toMatchObject({ winner: 'jev', primary: true })
    expect(row(c, 'validRate')).toMatchObject({ winner: 'tie', deltaText: '' })
    expect(row(c, 'inputTokens').winner).toBeNull() // informative
    // optional rows without data are dropped
    expect(c.rows.find((r) => r.key === 'agreementRate')).toBeUndefined()
    expect(c.rows.find((r) => r.key === 'accuracy_easy')).toBeUndefined()
    expect(new Set(c.rows.map((r) => r.pillar))).toEqual(new Set(['score', 'reliability', 'time', 'cost']))
  })

  it('is valid for comparison', () => {
    expect(c.validity).toEqual({ validForComparison: true, warnings: [], issues: [] })
  })
})

describe('compareLanes — Score pillar', () => {
  it('ties when the gap is worth ≤ 1 classification', () => {
    const c = compareLanes({
      gpt: lane({ engine: 'gpt', correct: hits(45, N), confidence: 0.8 }),
      jev: lane({ engine: 'jev', correct: hits(44, N), confidence: 0.8 }),
    })
    expect(c.pillars.score.winner).toBe('tie')
    expect(c.pillars.score.detail).toBe('diferencia de 1 clasificación o menos')
    expect(row(c, 'accuracy').winner).toBe('tie')
  })

  it('reports a significant difference with its p-value', () => {
    // GPT right on 50, Jev right on the first 38 → b = 12, c = 0
    const c = compareLanes({
      gpt: lane({ engine: 'gpt', correct: hits(50, N), confidence: 0.8 }),
      jev: lane({ engine: 'jev', correct: hits(38, N), confidence: 0.8 }),
    })
    expect(c.pillars.score.winner).toBe('gpt')
    expect(c.pillars.score.significant).toBe(true)
    expect(c.pillars.score.detail).toBe('+20,0 pp, diferencia significativa, p < 0,001')
  })
})

describe('compareLanes — Reliability pillar', () => {
  const base = () => ({
    gpt: lane({ engine: 'gpt', correct: hits(45, N), confidence: 0.8 }),
    jev: lane({ engine: 'jev', correct: hits(45, N), confidence: 0.8 }),
  })

  it('applies the ECE and Brier tolerances', () => {
    const b = base()
    const within = compareLanes({
      gpt: patchReliability(b.gpt, { ece: 0.05, brier: 0.1 }),
      jev: patchReliability(b.jev, { ece: 0.05 + ECE_TIE * 0.9, brier: 0.1 + BRIER_TIE * 0.9 }),
    })
    expect(within.pillars.reliability.votes).toEqual({ gpt: 0, jev: 0, tie: 3, abstain: 0 })

    const beyond = compareLanes({
      gpt: patchReliability(b.gpt, { ece: 0.05, brier: 0.1 }),
      jev: patchReliability(b.jev, { ece: 0.05 + ECE_TIE * 1.1, brier: 0.1 + BRIER_TIE * 1.1 }),
    })
    expect(beyond.pillars.reliability).toMatchObject({ winner: 'gpt', votes: { gpt: 2, jev: 0, tie: 1, abstain: 0 } })
  })

  it('breaks equal votes with AUROC', () => {
    const b = base()
    const c = compareLanes({
      gpt: patchReliability(b.gpt, { ece: 0.05, brier: 0.2, auroc: 0.7 }),
      jev: patchReliability(b.jev, { ece: 0.1, brier: 0.1, auroc: 0.7 + AUROC_TIE * 2 }),
    })
    expect(c.pillars.reliability.votes).toEqual({ gpt: 1, jev: 1, tie: 1, abstain: 0 })
    expect(c.pillars.reliability).toMatchObject({ winner: 'jev', decidedBy: 'auroc', detail: 'desempate por AUROC' })
  })

  it('ties when AUROC is within tolerance too', () => {
    const b = base()
    const c = compareLanes({
      gpt: patchReliability(b.gpt, { ece: 0.05, brier: 0.1, auroc: 0.7 }),
      jev: patchReliability(b.jev, { ece: 0.05, brier: 0.1, auroc: 0.7 + AUROC_TIE / 2 }),
    })
    expect(c.pillars.reliability.winner).toBe('tie')
  })

  it('a missing metric abstains; validRate punishes failures', () => {
    // Jev answers everything without confidence; GPT has 5 timeouts but calibrated answers.
    const gptRecords = makeLane({ engine: 'gpt', correct: hits(45, N), confidence: 0.8 }).map((r, i) =>
      i >= 55 ? makeRecord({ engine: 'gpt', index: i, status: 'timeout', startedAt: 0 }) : r,
    )
    const gpt = { records: gptRecords, metrics: computeLaneMetrics(gptRecords, { categories: CATEGORIES, run: makeRun('gpt', N) }) }
    const jev = lane({ engine: 'jev', correct: hits(45, N) })
    const c = compareLanes({ gpt, jev })
    expect(c.pillars.reliability.votes).toEqual({ gpt: 0, jev: 1, tie: 0, abstain: 2 })
    expect(c.pillars.reliability.winner).toBe('jev')
    expect(c.validity.issues.some((i) => i.code === 'low_confidence_coverage' && i.engine === 'jev')).toBe(true)
  })
})

describe('compareLanes — Time pillar', () => {
  it('ties p50 within 5 % and lets p95 decide', () => {
    const slowTail = Array.from({ length: N }, (_, i) => (i >= 54 ? 5000 : 1000))
    const c = compareLanes({
      gpt: lane({ engine: 'gpt', correct: hits(45, N), confidence: 0.8, latencyMs: slowTail }),
      jev: lane({ engine: 'jev', correct: hits(45, N), confidence: 0.8, latencyMs: 1040 }),
    })
    const t = c.pillars.time
    expect(t.winner).toBe('jev')
    expect(t.decidedBy).toBe('latencyP95')
    expect(t.reasons[0]).toContain('empate')
    expect(row(c, 'latencyP50').winner).toBe('tie')
  })

  it('is a tie when p50, p95 and wall time are all within tolerance', () => {
    const c = compareLanes({
      gpt: lane({ engine: 'gpt', correct: hits(45, N), confidence: 0.8, latencyMs: 1000 }),
      jev: lane({ engine: 'jev', correct: hits(45, N), confidence: 0.8, latencyMs: 1030 }),
    })
    expect(c.pillars.time.winner).toBe('tie')
    expect(c.pillars.time.reasons).toHaveLength(3)
  })
})

describe('compareLanes — overall verdict', () => {
  it('Score breaks a 1–1 tie between pillars', () => {
    // GPT +5 items (Score), Jev faster (Time), same calibration (Reliability tie).
    const gpt = lane({ engine: 'gpt', correct: hits(50, N), confidence: 0.8, latencyMs: 3000 })
    const jev = lane({ engine: 'jev', correct: hits(45, N), confidence: 0.8, latencyMs: 1000 })
    const c = compareLanes({
      gpt: patchReliability(gpt, { ece: 0.1, brier: 0.15, auroc: 0.5 }),
      jev: patchReliability(jev, { ece: 0.1, brier: 0.15, auroc: 0.5 }),
    })
    expect(c.pillars.reliability.winner).toBe('tie')
    expect(c.overall).toMatchObject({ winner: 'gpt', decidedByScore: true, pillarsWon: { gpt: 1, jev: 1 } })
    expect(c.overall.summary).toBe(
      'GPT gana por desempate en Score (+8,3 pp, diferencia no significativa); Jev gana en Tiempo; empate en Confiabilidad.',
    )
  })

  it('is a tie when pillars are level and Score is tied', () => {
    const gpt = lane({ engine: 'gpt', correct: hits(45, N), confidence: 0.8, latencyMs: 3000 })
    const jev = lane({ engine: 'jev', correct: hits(45, N), confidence: 0.8, latencyMs: 1000 })
    const c = compareLanes({
      gpt: patchReliability(gpt, { ece: 0.05 }),
      jev: patchReliability(jev, { ece: 0.2 }),
    })
    expect(c.pillars.reliability.winner).toBe('gpt')
    expect(c.overall.winner).toBe('tie')
    expect(c.overall.summary).toBe(
      'Empate: GPT gana en Confiabilidad; Jev gana en Tiempo; empate en Score (diferencia de 1 clasificación o menos).',
    )
  })

  it('identical lanes tie in every pillar', () => {
    const c = compareLanes({
      gpt: lane({ engine: 'gpt', correct: hits(45, N), confidence: 0.8 }),
      jev: lane({ engine: 'jev', correct: hits(45, N), confidence: 0.8 }),
    })
    expect(c.overall.winner).toBe('tie')
    expect(c.overall.pillarsTied).toBe(3)
    expect(c.overall.summary).toBe('Empate en Score, Confiabilidad y Tiempo (Score: diferencia de 1 clasificación o menos).')
  })

  it('a clean sweep mentions the Score detail inside the list', () => {
    const c = compareLanes({
      gpt: lane({ engine: 'gpt', correct: hits(55, N), confidence: honest(hits(55, N)), latencyMs: 500 }),
      jev: lane({ engine: 'jev', correct: hits(40, N), confidence: 0.95, latencyMs: 2000 }),
    })
    expect(c.overall.winner).toBe('gpt')
    expect(c.overall.pillarsWon).toEqual({ gpt: 3, jev: 0 })
    expect(c.overall.summary).toBe(
      'GPT gana 3 de 3 pilares (Score, Confiabilidad y Tiempo; Score: +25,0 pp, diferencia significativa, p < 0,001).',
    )
  })

  it('no data → null winner', () => {
    const empty = () => ({ records: [], metrics: computeLaneMetrics([], { categories: CATEGORIES }) })
    const c = compareLanes({ gpt: empty(), jev: empty() })
    expect(c.overall.winner).toBeNull()
    expect(c.overall.summary).toBe('Aún no hay datos suficientes para comparar los carriles.')
    expect(c.pillars.score.winner).toBeNull()
    expect(c.pillars.reliability.winner).toBeNull()
    expect(c.pillars.time.winner).toBeNull()
    expect(c.validity.validForComparison).toBe(false)
    expect(c.validity.issues.filter((i) => i.code === 'no_data')).toHaveLength(2)
  })
})

describe('compareLanes — validity', () => {
  const ok = () => lane({ engine: 'gpt', correct: hits(45, N), confidence: 0.8 })

  it('flags mock lanes and mixed modes', () => {
    const jev = lane({ engine: 'jev', correct: hits(45, N), confidence: 0.8, mode: 'mock' }, makeRun('jev', N, { mode: 'mock' }))
    const v = compareLanes({ gpt: ok(), jev }).validity
    expect(v.validForComparison).toBe(false)
    expect(v.issues.map((i) => i.code)).toEqual(['mock', 'mode_mismatch'])
    expect(v.warnings[0]).toBe('Jev corrió en modo simulado: los resultados no reflejan el modelo real.')
    expect(v.warnings[1]).toBe('Los carriles corrieron en modos distintos (GPT: real, Jev: simulado).')
  })

  it('flags incomplete and aborted runs', () => {
    const jev = lane({ engine: 'jev', correct: hits(45, N), confidence: 0.8 }, makeRun('jev', 70))
    expect(compareLanes({ gpt: ok(), jev }).validity.warnings).toContain('La corrida de Jev está incompleta (60 de 70).')
    const aborted = lane({ engine: 'jev', correct: hits(45, N), confidence: 0.8 }, makeRun('jev', 70, { status: 'aborted' }))
    const v = compareLanes({ gpt: ok(), jev: aborted }).validity
    expect(v.validForComparison).toBe(false)
    expect(v.warnings).toContain('La corrida de Jev fue abortada (60 de 70).')
    const running = lane({ engine: 'jev', correct: hits(45, N), confidence: 0.8 }, makeRun('jev', 60, { status: 'running' }))
    expect(compareLanes({ gpt: ok(), jev: running }).validity.issues[0].code).toBe('running')
  })

  it('flags lanes that do not cover the same items', () => {
    const jevRecords = makeLane({ engine: 'jev', correct: hits(45, N), confidence: 0.8 }).slice(0, 55)
    const jev = { records: jevRecords, metrics: computeLaneMetrics(jevRecords, { categories: CATEGORIES, run: makeRun('jev', 55) }) }
    const v = compareLanes({ gpt: ok(), jev }).validity
    expect(v.validForComparison).toBe(false)
    expect(v.warnings).toEqual(['Los carriles no cubren los mismos conceptos: 5 solo en GPT y 0 solo en Jev.'])
  })

  it('notes a high failure rate without invalidating the comparison', () => {
    const jevRecords = makeLane({ engine: 'jev', correct: hits(30, N), confidence: 0.8 }).map((r, i) =>
      i >= 45 ? makeRecord({ engine: 'jev', index: i, status: 'error', startedAt: 0 }) : r,
    )
    const jev = { records: jevRecords, metrics: computeLaneMetrics(jevRecords, { categories: CATEGORIES, run: makeRun('jev', N) }) }
    const v = compareLanes({ gpt: ok(), jev }).validity
    expect(v.validForComparison).toBe(true)
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]).toMatchObject({ code: 'high_failure_rate', engine: 'jev', blocking: false })
    expect(v.warnings[0]).toBe(
      'Jev tuvo 25,0 % de errores o timeouts: cuentan como fallo en Score, su latencia incluye esas llamadas (un error rápido la acorta, un timeout la alarga) y su calibración usa menos respuestas.',
    )
  })

  it('notes records re-run by «Reintentar fallidos» (started after the first pass ended), without invalidating', () => {
    const jevRecords = makeLane({ engine: 'jev', correct: hits(45, N), confidence: 0.8 }).map((r, i) =>
      i < 2 ? { ...r, startedAt: 10_000_000 + i, finishedAt: 10_000_500 + i } : r,
    )
    const run = makeRun('jev', N, { finishedAt: 9_000_000 })
    const jev = { records: jevRecords, metrics: computeLaneMetrics(jevRecords, { categories: CATEGORIES, run }) }
    expect(jev.metrics.counts.rerun).toBe(2)
    const v = compareLanes({ gpt: ok(), jev }).validity
    expect(v.validForComparison).toBe(true)
    expect(v.issues).toEqual([
      expect.objectContaining({ code: 'rerun', engine: 'jev', blocking: false, message: expect.stringContaining('2 clasificaciones vienen de «Reintentar fallidos»') }),
    ])
  })

  it('cost hint says «estimado» only when a lane is simulated', () => {
    const live = compareLanes({ gpt: ok(), jev: lane({ engine: 'jev', correct: hits(45, N), confidence: 0.8 }) })
    expect(row(live, 'costTotal').hint).not.toMatch(/estimad|simulad/)
    const mock = lane({ engine: 'jev', correct: hits(45, N), confidence: 0.8, mode: 'mock' }, makeRun('jev', N, { mode: 'mock' }))
    const estimated = { ...mock, metrics: { ...mock.metrics, cost: { ...mock.metrics.cost, estimated: true } } }
    expect(row(compareLanes({ gpt: ok(), jev: estimated }), 'costTotal').hint).toMatch(/simulado es un estimado/)
  })

  it('flags records from the wrong engine', () => {
    const swapped = lane({ engine: 'jev', correct: hits(45, N), confidence: 0.8 })
    const v = compareLanes({ gpt: swapped, jev: swapped }).validity
    expect(v.issues.some((i) => i.code === 'engine_mismatch' && i.engine === 'gpt')).toBe(true)
  })
})
