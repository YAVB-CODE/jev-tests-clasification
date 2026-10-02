import { describe, expect, it } from 'vitest'
import type { PlannedItem } from '../../bench/plan.ts'
import { CATEGORIES, makeRecord, type RecordSpec } from '../../metrics/__fixtures__/makeRecord.ts'
import type { ClassificationRecord, EngineId, LabeledConcept } from '../../shared/contracts.ts'
import {
  buildDetailRows,
  categoryNames,
  countFilters,
  disagreementScore,
  matchesFilter,
  matchesQuery,
  normalizeText,
  outcomeOf,
  repetitionsOf,
  sortRows,
  type DetailRow,
} from './detailRows.ts'

const NAMES = categoryNames(CATEGORIES)

const CONCEPTS: Partial<LabeledConcept>[] = [
  { concept: 'Servicio de energía eléctrica', supplier: 'Codensa' },
  { concept: 'Taxi al aeropuerto', supplier: 'Tax Express' },
  { concept: 'Resma de papel', supplier: 'Papelería Lara', notes: 'Pedido urgente' },
  { concept: 'Licencia de software', supplier: 'Microsoft' },
  { concept: 'Hosting anual', supplier: 'AWS' },
  { concept: 'Pendiente', supplier: 'Nadie' },
]

function plan(repetitions = 1): PlannedItem[] {
  const out: PlannedItem[] = []
  for (let repetition = 0; repetition < repetitions; repetition++) {
    CONCEPTS.forEach((c, i) => {
      out.push({
        item: { id: `item-${i}`, concept: 'x', expected: 'A', ...c } as LabeledConcept,
        index: out.length,
        repetition,
      })
    })
  }
  return out
}

function rec(engine: EngineId, index: number, spec: RecordSpec, repetition = 0): ClassificationRecord {
  return makeRecord({ engine, index, itemId: `item-${index % CONCEPTS.length}`, repetition, expected: 'A', ...spec })
}

/**
 * item-0: both right | item-1: only GPT | item-2: only Jev | item-3: both wrong, same answer
 * item-4: GPT timeout, Jev wrong (different) | item-5: no records (pending)
 */
function sampleRows(): DetailRow[] {
  const gpt = [
    rec('gpt', 0, { predicted: 'A', confidence: 0.9, latencyMs: 500 }),
    rec('gpt', 1, { predicted: 'A', confidence: 0.6, latencyMs: 1500 }),
    rec('gpt', 2, { predicted: 'B', confidence: 0.95, latencyMs: 900 }),
    rec('gpt', 3, { predicted: 'C', confidence: 0.7, latencyMs: 700 }),
    rec('gpt', 4, { status: 'timeout', latencyMs: 30000 }),
  ]
  const jev = [
    rec('jev', 0, { predicted: 'A', confidence: 0.8, latencyMs: 300 }),
    rec('jev', 1, { predicted: 'B', confidence: 0.99, latencyMs: 400 }),
    rec('jev', 2, { predicted: 'A', latencyMs: 350 }),
    rec('jev', 3, { predicted: 'C', confidence: 0.5, latencyMs: 600 }),
    rec('jev', 4, { predicted: 'D', confidence: 0.4, latencyMs: 450 }),
  ]
  return buildDetailRows(plan(), { gpt, jev })
}

const keys = (rows: readonly DetailRow[]) => rows.map((r) => r.item.id.replace('item-', ''))

describe('buildDetailRows', () => {
  it('has one row per planned slot, joined by item and repetition', () => {
    const rows = buildDetailRows(plan(2), {
      gpt: [rec('gpt', 0, {}, 0), rec('gpt', 6, { predicted: 'B' }, 1)],
      jev: [rec('jev', 0, {}, 0)],
    })
    expect(rows).toHaveLength(12)
    expect(rows[0].records.gpt).toBeDefined()
    expect(rows[0].records.jev).toBeDefined()
    expect(rows[6].key).toBe('item-0:1')
    expect(rows[6].records.gpt?.predicted).toBe('B')
    expect(rows[6].records.jev).toBeUndefined()
    expect(repetitionsOf(rows)).toEqual([0, 1])
  })

  it('lets a later record replace an earlier one for the same slot', () => {
    const rows = buildDetailRows(plan(), {
      gpt: [rec('gpt', 0, { status: 'error' }), rec('gpt', 0, { predicted: 'A' })],
      jev: [],
    })
    expect(outcomeOf(rows[0].records.gpt)).toBe('correct')
  })
})

describe('outcomeOf', () => {
  it('classifies records', () => {
    expect(outcomeOf(undefined)).toBe('pending')
    expect(outcomeOf(rec('gpt', 0, { predicted: 'A' }))).toBe('correct')
    expect(outcomeOf(rec('gpt', 0, { predicted: 'B' }))).toBe('wrong')
    expect(outcomeOf(rec('gpt', 0, { status: 'timeout' }))).toBe('failed')
    expect(outcomeOf(rec('gpt', 0, { status: 'invalid' }))).toBe('failed')
    // A stale `correct` flag is not trusted.
    expect(outcomeOf(rec('gpt', 0, { predicted: 'B', correct: true }))).toBe('wrong')
  })
})

describe('filters', () => {
  const rows = sampleRows()

  it('splits the rows by who got it right', () => {
    expect(keys(rows.filter((r) => matchesFilter(r, 'both_correct')))).toEqual(['0'])
    expect(keys(rows.filter((r) => matchesFilter(r, 'only_gpt')))).toEqual(['1'])
    expect(keys(rows.filter((r) => matchesFilter(r, 'only_jev')))).toEqual(['2'])
    expect(keys(rows.filter((r) => matchesFilter(r, 'both_wrong')))).toEqual(['3', '4'])
    expect(keys(rows.filter((r) => matchesFilter(r, 'failures')))).toEqual(['4'])
    expect(rows.filter((r) => matchesFilter(r, 'all'))).toHaveLength(6)
  })

  it('counts every filter (pending rows only count in "all")', () => {
    expect(countFilters(rows)).toEqual({ all: 6, both_correct: 1, only_gpt: 1, only_jev: 1, both_wrong: 2, failures: 1 })
  })

  it('does not classify half-finished rows as comparisons', () => {
    const half = buildDetailRows(plan(), { gpt: [rec('gpt', 0, { predicted: 'A' })], jev: [] })
    expect(countFilters(half)).toMatchObject({ all: 6, only_gpt: 0, both_wrong: 0, both_correct: 0 })
  })
})

describe('search', () => {
  const rows = sampleRows()
  const find = (q: string) => keys(rows.filter((r) => matchesQuery(r, q, NAMES)))

  it('matches concept, supplier and notes ignoring case and accents', () => {
    expect(find('ENERGIA')).toEqual(['0'])
    expect(find('papeleria')).toEqual(['2'])
    expect(find('urgente')).toEqual(['2'])
    expect(find('aws')).toEqual(['4'])
  })

  it('requires every term', () => {
    expect(find('taxi express')).toEqual(['1'])
    expect(find('taxi microsoft')).toEqual([])
  })

  it('matches expected and predicted categories by id or name', () => {
    expect(find('alfa')).toHaveLength(6) // every row expects A (Alfa)
    expect(find('gamma')).toEqual(['3']) // predicted C = Gamma
    expect(find('delta')).toEqual(['4'])
  })

  it('matches everything with an empty query', () => {
    expect(find('   ')).toHaveLength(6)
  })

  it('normalizeText strips diacritics', () => {
    expect(normalizeText('Papelería ÁÉÍÓÚ ñ')).toBe('papeleria aeiou n')
  })
})

describe('sorting', () => {
  const rows = sampleRows()

  it('keeps the queue order by default and can reverse it', () => {
    expect(keys(sortRows(rows, 'queue'))).toEqual(['0', '1', '2', '3', '4', '5'])
    expect(keys(sortRows(rows, 'queue', true))).toEqual(['5', '4', '3', '2', '1', '0'])
  })

  it('puts the strongest disagreements first and pending rows last', () => {
    expect(disagreementScore(rows[0])).toBe(0)
    expect(disagreementScore(rows[1])).toBe(3)
    expect(disagreementScore(rows[3])).toBe(1)
    expect(disagreementScore(rows[4])).toBe(2)
    expect(disagreementScore(rows[5])).toBeNull()
    expect(keys(sortRows(rows, 'disagreement'))).toEqual(['1', '2', '4', '3', '0', '5'])
    expect(keys(sortRows(rows, 'disagreement', false))).toEqual(['0', '3', '4', '1', '2', '5'])
  })

  it('sorts by confidence, with missing values always last', () => {
    expect(keys(sortRows(rows, 'confidence_gpt'))).toEqual(['2', '0', '3', '1', '4', '5'])
    expect(keys(sortRows(rows, 'confidence_gpt', false))).toEqual(['1', '3', '0', '2', '4', '5'])
    // Jev has no confidence on item-2.
    expect(keys(sortRows(rows, 'confidence_jev'))).toEqual(['1', '0', '3', '4', '2', '5'])
  })

  it('sorts by latency', () => {
    expect(keys(sortRows(rows, 'latency_gpt'))).toEqual(['4', '1', '2', '3', '0', '5'])
    expect(keys(sortRows(rows, 'latency_jev', false))).toEqual(['0', '2', '1', '4', '3', '5'])
  })

  it('does not mutate the input and keeps ties in queue order', () => {
    const copy = rows.slice()
    sortRows(rows, 'latency_gpt')
    expect(rows).toEqual(copy)
    const tied = buildDetailRows(plan(), {
      gpt: [rec('gpt', 0, { latencyMs: 1 }), rec('gpt', 1, { latencyMs: 1 })],
      jev: [],
    })
    expect(keys(sortRows(tied, 'latency_gpt')).slice(0, 2)).toEqual(['0', '1'])
  })
})
