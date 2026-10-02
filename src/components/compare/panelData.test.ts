import { describe, expect, it } from 'vitest'
import { CATEGORIES, hits, makeLane, makeRun } from '../../metrics/__fixtures__/makeRecord.ts'
import { compareLanes, computeLaneMetrics, type Comparison, type LaneInput, type PairedTest } from '../../metrics/index.ts'
import type { LaneRunInfo } from '../../shared/contracts.ts'
import {
  decidedByLabel,
  directionLabel,
  focusRows,
  groupRows,
  helpLine,
  pairedInterpretation,
  partialState,
  validityView,
  winnerHeadline,
  winnerLabel,
} from './panelData.ts'

const N = 20

function lane(engine: 'gpt' | 'jev', correct: boolean[], opts: { mode?: 'live' | 'mock'; run?: Partial<LaneRunInfo>; latencyMs?: number } = {}): LaneInput {
  const records = makeLane({ engine, correct, confidence: correct.map((ok) => (ok ? 0.9 : 0.4)), latencyMs: opts.latencyMs ?? 1000, mode: opts.mode })
  const run = makeRun(engine, records.length, { mode: opts.mode ?? 'live', ...opts.run })
  return { records, metrics: computeLaneMetrics(records, { categories: CATEGORIES, run }) }
}

function compare(g: LaneInput, j: LaneInput): Comparison {
  return compareLanes({ gpt: g, jev: j })
}

describe('winner wording', () => {
  it('labels winners', () => {
    expect(winnerLabel('gpt')).toBe('GPT')
    expect(winnerLabel('jev')).toBe('Jev')
    expect(winnerLabel('tie')).toBe('Empate')
    expect(winnerLabel(null)).toBe('Sin datos')
    expect(winnerHeadline('jev')).toBe('Gana Jev')
    expect(winnerHeadline('tie')).toBe('Empate')
    expect(directionLabel('lower')).toBe('menor es mejor')
    expect(directionLabel('higher')).toBe('mayor es mejor')
  })
})

describe('helpLine', () => {
  it('keeps the first sentence of a hint', () => {
    expect(helpLine('Mediana de la latencia extremo a extremo por clasificación. Decide Tiempo (empate si difieren ≤ 5 %).')).toBe(
      'Mediana de la latencia extremo a extremo por clasificación.',
    )
    expect(helpLine('Sin punto final')).toBe('Sin punto final')
    expect(helpLine(undefined)).toBe('')
  })
  it('does not cut inside a decimal number', () => {
    expect(helpLine('Error cuadrático (0,25 = decir siempre 50 %). Vota en Confiabilidad.')).toBe(
      'Error cuadrático (0,25 = decir siempre 50 %).',
    )
  })
})

describe('groupRows / focusRows / decidedByLabel', () => {
  const c = compare(lane('gpt', hits(16, N), { latencyMs: 800 }), lane('jev', hits(12, N), { latencyMs: 1500 }))

  it('groups by pillar in canonical order and drops empty groups', () => {
    const groups = groupRows(c.rows)
    expect(groups.map((g) => g.pillar)).toEqual(['score', 'reliability', 'time', 'cost'].filter((p) => c.rows.some((r) => r.pillar === p)))
    expect(groups[0].label).toBe('Score')
    expect(groups.flatMap((g) => g.rows)).toHaveLength(c.rows.length)
    expect(groupRows([])).toEqual([])
  })

  it('picks the rows that decide each pillar', () => {
    expect(focusRows('score', c.rows)[0].key).toBe('accuracy')
    expect(focusRows('reliability', c.rows).map((r) => r.key)).toEqual(expect.arrayContaining(['ece', 'brier', 'validRate']))
    expect(focusRows('time', c.rows)[0].key).toBe('latencyP50')
  })

  it('names the deciding metric', () => {
    expect(decidedByLabel(c.pillars.score, c.rows)).toBe('Acierto')
    expect(decidedByLabel(c.pillars.time, c.rows)).toBe('Latencia p50')
    expect(decidedByLabel({ ...c.pillars.reliability, decidedBy: 'votes' }, c.rows)).toMatch(/votos/)
    expect(decidedByLabel({ ...c.pillars.score, decidedBy: null }, c.rows)).toBeNull()
  })
})

describe('validityView', () => {
  it('is valid for two finished live lanes', () => {
    const v = validityView(compare(lane('gpt', hits(10, N)), lane('jev', hits(10, N))).validity)
    expect(v.valid).toBe(true)
    expect(v.title).toBe('Válido para comparar')
    expect(v.blocking).toEqual([])
  })

  it('says "no válido para evaluar eficacia" for a simulated lane', () => {
    const v = validityView(compare(lane('gpt', hits(10, N), { mode: 'mock' }), lane('jev', hits(10, N))).validity)
    expect(v.valid).toBe(false)
    expect(v.title).toBe('No válido para evaluar eficacia')
    expect(v.lead).toMatch(/simulado/)
    expect(v.blocking.length).toBeGreaterThan(0)
  })

  it('says it too for an incomplete / running run, with the partial lead', () => {
    const running = lane('gpt', hits(10, 10), { run: { total: 20, status: 'running' } })
    const v = validityView(compare(running, lane('jev', hits(10, 10), { run: { total: 20, status: 'running' } })).validity)
    expect(v.valid).toBe(false)
    expect(v.title).toBe('No válido para evaluar eficacia')
    expect(v.lead).toMatch(/parciales/)
  })

  it('separates blocking issues from notes', () => {
    const failing = lane('gpt', hits(10, N), { run: { total: N } })
    const g = { ...failing, metrics: { ...failing.metrics, counts: { ...failing.metrics.counts, failureRate: 0.5 } } }
    const v = validityView(compare(g, lane('jev', hits(10, N))).validity)
    expect(v.valid).toBe(true)
    // A high failure rate does not block, but it turns the banner into a warning.
    expect(v.cautions.map((i) => i.code)).toEqual(['high_failure_rate'])
    expect(v.notes.some((i) => i.code === 'high_failure_rate')).toBe(false)
    expect(v.title).toBe('Válido para comparar, con advertencias')
    expect(v.lead).toMatch(/errores o timeouts/)
  })
})

describe('partialState', () => {
  it('is partial while running and when the run is incomplete or aborted', () => {
    expect(partialState('running', [])).toEqual({ partial: true, label: 'parcial · en vivo' })
    expect(partialState('done', [{ pending: 3, runStatus: 'done' }]).label).toBe('parcial · corrida incompleta')
    expect(partialState('aborted', [{ pending: 0, runStatus: 'aborted' }]).partial).toBe(true)
    expect(partialState('done', [{ pending: 0, runStatus: 'done' }, { pending: 0, runStatus: 'done' }])).toEqual({ partial: false, label: '' })
  })
})

describe('pairedInterpretation', () => {
  const base: PairedTest = {
    pairs: 20,
    bothCorrect: 10,
    gptOnly: 6,
    jevOnly: 1,
    bothWrong: 3,
    unmatchedGpt: 0,
    unmatchedJev: 0,
    labelMismatches: 0,
    repetitions: 1,
    mcnemar: { gptOnly: 6, jevOnly: 1, discordant: 7, pValue: 0.125 },
    itemTest: { items: 20, gptBetter: 6, jevBetter: 1, ties: 13, pValue: 0.125 },
    pValue: 0.125,
    significant: false,
    favored: 'gpt',
    testName: 'McNemar exacta',
  }

  it('reads a non-significant difference as possibly chance', () => {
    const t = pairedInterpretation(base)
    expect(t).toContain('7 de 20 pares')
    expect(t).toContain('solo GPT acertó en 6')
    expect(t).toContain('no es estadísticamente significativa')
    expect(t).toContain('ventaja de GPT')
  })

  it('reads a significant difference with its direction', () => {
    const t = pairedInterpretation({ ...base, gptOnly: 1, jevOnly: 12, pValue: 0.003, significant: true })
    expect(t).toContain('es estadísticamente significativa y favorece a Jev')
    expect(t).toContain('p = 0,003')
  })

  it('handles no pairs and no disagreements', () => {
    expect(pairedInterpretation({ ...base, pairs: 0, gptOnly: 0, jevOnly: 0, bothCorrect: 0, bothWrong: 0 })).toMatch(/Aún no hay/)
    expect(pairedInterpretation({ ...base, gptOnly: 0, jevOnly: 0, bothCorrect: 15, bothWrong: 5 })).toMatch(/coincidieron/)
  })

  it('explains the per-concept test when there are repetitions', () => {
    const t = pairedInterpretation({
      ...base,
      repetitions: 3,
      itemTest: { items: 20, gptBetter: 2, jevBetter: 5, ties: 13, pValue: 0.45 },
      pValue: 0.45,
    })
    expect(t).toContain('cuenta conceptos')
    expect(t).toContain('2 a favor de GPT, 5 a favor de Jev')
    expect(t).toContain('ventaja de Jev')
  })
})
