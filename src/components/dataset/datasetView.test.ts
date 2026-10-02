import { describe, expect, it } from 'vitest'
import type { Category, Dataset, LabeledConcept } from '../../shared/contracts.ts'
import { PUC_COLOMBIA_DATASET } from '../../data/puc-colombia.ts'
import { categoryLabel, countByCategory, filterItems, formatAmount, normalizeSearch, summarizeDataset } from './datasetView.ts'

const CATEGORIES: Category[] = [
  { id: '513530', name: 'Energía eléctrica', description: '', group: '5135 Servicios' },
  { id: '513535', name: 'Teléfono', description: '', group: '5135 Servicios' },
  { id: 'X', name: 'Otra', description: '' },
]

const ITEMS: LabeledConcept[] = [
  { id: 'a', concept: 'Servicio de energía marzo', supplier: 'Enel', amount: 1000, expected: '513530', difficulty: 'easy' },
  { id: 'b', concept: 'Plan de datos móvil', supplier: 'Claro', expected: '513535', difficulty: 'hard' },
  { id: 'c', concept: 'Varios', notes: 'Cargo extraño', expected: 'X' },
]

describe('summarizeDataset', () => {
  it('cuenta categorías, grupos, items y dificultades', () => {
    const dataset = { task: { instructions: 'i', question: 'q', categories: CATEGORIES }, items: ITEMS } satisfies Pick<Dataset, 'task' | 'items'>
    expect(summarizeDataset(dataset)).toEqual({
      categories: 3,
      groups: 1,
      items: 3,
      byDifficulty: { easy: 1, medium: 0, hard: 1, unset: 1 },
    })
  })

  it('resume el dataset semilla: la suma por dificultad es el total', () => {
    const s = summarizeDataset(PUC_COLOMBIA_DATASET)
    expect(s.items).toBe(PUC_COLOMBIA_DATASET.items.length)
    expect(s.byDifficulty.easy + s.byDifficulty.medium + s.byDifficulty.hard + s.byDifficulty.unset).toBe(s.items)
  })
})

describe('countByCategory / categoryLabel', () => {
  it('cuenta por categoría esperada', () => {
    expect(countByCategory(ITEMS).get('513530')).toBe(1)
    expect(countByCategory([...ITEMS, ...ITEMS]).get('X')).toBe(2)
  })
  it('etiqueta con código y nombre, o el id si no existe', () => {
    expect(categoryLabel(CATEGORIES, '513530')).toBe('513530 · Energía eléctrica')
    expect(categoryLabel(CATEGORIES, '999999')).toBe('999999')
  })
})

describe('normalizeSearch', () => {
  it('ignora tildes y mayúsculas', () => {
    expect(normalizeSearch('  ENERGÍA Eléctrica ')).toBe('energia electrica')
  })
})

describe('filterItems', () => {
  const base = { query: '', difficulty: 'all', category: '' } as const
  const ids = (filter: Parameters<typeof filterItems>[2]): string[] => filterItems(ITEMS, CATEGORIES, filter).map((i) => i.id)

  it('sin filtros devuelve todo', () => {
    expect(ids(base)).toEqual(['a', 'b', 'c'])
  })
  it('busca en concepto, proveedor, notas, id y nombre de la categoría sin tildes', () => {
    expect(ids({ ...base, query: 'ENERGIA' })).toEqual(['a'])
    expect(ids({ ...base, query: 'claro' })).toEqual(['b'])
    expect(ids({ ...base, query: 'extraño' })).toEqual(['c'])
    expect(ids({ ...base, query: 'telefono' })).toEqual(['b'])
    expect(ids({ ...base, query: '513530' })).toEqual(['a'])
  })
  it('todas las palabras deben coincidir', () => {
    expect(ids({ ...base, query: 'servicio enel' })).toEqual(['a'])
    expect(ids({ ...base, query: 'servicio claro' })).toEqual([])
  })
  it('filtra por dificultad (incluida «sin definir») y categoría', () => {
    expect(ids({ ...base, difficulty: 'hard' })).toEqual(['b'])
    expect(ids({ ...base, difficulty: 'unset' })).toEqual(['c'])
    expect(ids({ ...base, category: '513535' })).toEqual(['b'])
    expect(ids({ query: 'datos', difficulty: 'easy', category: '' })).toEqual([])
  })
})

describe('formatAmount', () => {
  it('formatea en es-CO con moneda por defecto COP', () => {
    expect(formatAmount(1234567)).toBe('COP 1.234.567')
    expect(formatAmount(12.5, 'usd ')).toBe('usd 12,50')
    expect(formatAmount(0, 'COP')).toBe('COP 0')
  })
  it('sin valor muestra un guion', () => {
    expect(formatAmount(undefined)).toBe('—')
    expect(formatAmount(Number.NaN)).toBe('—')
  })
})
