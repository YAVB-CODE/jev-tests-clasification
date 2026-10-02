import { describe, expect, it } from 'vitest'
import type { ClassifyResult, LabeledConcept } from '../../shared/contracts.ts'
import { PUC_COLOMBIA_DATASET } from '../../data/puc-colombia.ts'
import {
  buildQuickInput,
  compareLanes,
  emptyQuickForm,
  formFromConcept,
  judgeAnswer,
  pickExamples,
  topProbabilities,
} from './quickUtils.ts'

const result = (status: ClassifyResult['status'], categoryId: string | null): Pick<ClassifyResult, 'status' | 'answer'> => ({
  status,
  answer: { categoryId },
})

describe('buildQuickInput', () => {
  it('exige el concepto', () => {
    expect(buildQuickInput({ ...emptyQuickForm(), concept: '   ' })).toEqual({ ok: false, error: expect.stringMatching(/concepto/) })
  })
  it('solo envía lo que se llenó; la moneda viaja con el valor y por defecto es COP', () => {
    expect(buildQuickInput({ ...emptyQuickForm(), concept: ' Resma de papel ' })).toEqual({ ok: true, input: { concept: 'Resma de papel' } })
    expect(buildQuickInput({ ...emptyQuickForm(), concept: 'x', amount: '$ 1.234.567,50', currency: ' ', supplier: ' Prov ', notes: ' n ' })).toEqual({
      ok: true,
      input: { concept: 'x', supplier: 'Prov', amount: 1234567.5, currency: 'COP', notes: 'n' },
    })
    expect(buildQuickInput({ ...emptyQuickForm(), concept: 'x', amount: '10', currency: 'usd' })).toEqual({
      ok: true,
      input: { concept: 'x', amount: 10, currency: 'USD' },
    })
  })
  it('rechaza montos inválidos', () => {
    const built = buildQuickInput({ ...emptyQuickForm(), concept: 'x', amount: 'mucho' })
    expect(built.ok).toBe(false)
  })
  it('formFromConcept ida y vuelta', () => {
    const form = formFromConcept({ concept: 'c', supplier: 's', amount: 1500.5, currency: 'USD', notes: 'n' })
    expect(form).toEqual({ concept: 'c', supplier: 's', amount: '1500,5', currency: 'USD', notes: 'n' })
    expect(buildQuickInput(form)).toEqual({ ok: true, input: { concept: 'c', supplier: 's', amount: 1500.5, currency: 'USD', notes: 'n' } })
    expect(formFromConcept(null)).toEqual(emptyQuickForm())
  })
})

describe('pickExamples', () => {
  it('devuelve 5 ejemplos únicos y variados del dataset semilla', () => {
    const picked = pickExamples(PUC_COLOMBIA_DATASET.items, 5)
    expect(picked).toHaveLength(5)
    expect(new Set(picked.map((i) => i.id)).size).toBe(5)
    expect(new Set(picked.map((i) => i.difficulty)).size).toBeGreaterThan(1)
  })
  it('es determinista', () => {
    expect(pickExamples(PUC_COLOMBIA_DATASET.items, 5)).toEqual(pickExamples(PUC_COLOMBIA_DATASET.items, 5))
  })
  it('completa con lo que haya cuando hay pocos items', () => {
    const items: LabeledConcept[] = [
      { id: 'a', concept: 'a', expected: 'X' },
      { id: 'b', concept: 'b', expected: 'X', difficulty: 'hard' },
    ]
    expect(pickExamples(items, 5).map((i) => i.id).sort()).toEqual(['a', 'b'])
    expect(pickExamples([], 5)).toEqual([])
    expect(pickExamples(items, 0)).toEqual([])
  })
  it('no excede el tope aunque haya muchos grupos', () => {
    const many: LabeledConcept[] = Array.from({ length: 20 }, (_, i) => ({
      id: `i${i}`,
      concept: 'c',
      expected: 'X',
      difficulty: (['easy', 'medium', 'hard'] as const)[i % 3],
    }))
    expect(pickExamples(many, 4)).toHaveLength(4)
  })
})

describe('topProbabilities', () => {
  it('ordena de mayor a menor, desempata por id y recorta', () => {
    const top = topProbabilities({ a: 0.1, b: 0.5, c: 0.5, d: 0.2, e: 0.05, f: 0.01 }, 5)
    expect(top.map((t) => t.id)).toEqual(['b', 'c', 'd', 'a', 'e'])
  })
  it('ignora valores no finitos y entradas vacías', () => {
    expect(topProbabilities({ a: Number.NaN, b: 1 }, 5)).toEqual([{ id: 'b', p: 1 }])
    expect(topProbabilities(undefined)).toEqual([])
  })
})

describe('judgeAnswer', () => {
  it('sin esperada o sin resultado no juzga', () => {
    expect(judgeAnswer(result('ok', 'A'), '')).toBeNull()
    expect(judgeAnswer(undefined, 'A')).toBeNull()
  })
  it('acierto, error y sin respuesta', () => {
    expect(judgeAnswer(result('ok', 'A'), 'A')).toBe('correct')
    expect(judgeAnswer(result('ok', 'B'), 'A')).toBe('wrong')
    expect(judgeAnswer(result('invalid', null), 'A')).toBe('failed')
    expect(judgeAnswer(result('timeout', null), 'A')).toBe('failed')
    expect(judgeAnswer(result('error', 'A'), 'A')).toBe('failed')
  })
})

describe('compareLanes', () => {
  it('coinciden o difieren solo si ambos respondieron', () => {
    expect(compareLanes({ engine: 'gpt', categoryId: 'A', latencyMs: 1000 }, { engine: 'jev', categoryId: 'A', latencyMs: 400 }).agree).toBe(true)
    expect(compareLanes({ engine: 'gpt', categoryId: 'A', latencyMs: 1 }, { engine: 'jev', categoryId: 'B', latencyMs: 1 }).agree).toBe(false)
    expect(compareLanes({ engine: 'gpt', categoryId: null, latencyMs: 1 }, { engine: 'jev', categoryId: 'B', latencyMs: 1 }).agree).toBeNull()
  })
  it('indica quién fue más rápido y cuántas veces', () => {
    const c = compareLanes({ engine: 'gpt', categoryId: 'A', latencyMs: 1200 }, { engine: 'jev', categoryId: 'A', latencyMs: 400 })
    expect(c.faster?.engine).toBe('jev')
    expect(c.faster?.ratio).toBeCloseTo(3)
  })
  it('no declara ganador si son parecidos o falta el dato', () => {
    expect(compareLanes({ engine: 'gpt', categoryId: 'A', latencyMs: 1000 }, { engine: 'jev', categoryId: 'A', latencyMs: 1020 }).faster).toBeNull()
    expect(compareLanes({ engine: 'gpt', categoryId: 'A', latencyMs: undefined }, { engine: 'jev', categoryId: 'A', latencyMs: 5 }).faster).toBeNull()
  })
})
