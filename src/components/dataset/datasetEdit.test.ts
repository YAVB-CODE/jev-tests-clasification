import { describe, expect, it } from 'vitest'
import type { Category, Dataset, LabeledConcept } from '../../shared/contracts.ts'
import { validateDataset } from '../../shared/task.ts'
import { PUC_COLOMBIA_DATASET } from '../../data/puc-colombia.ts'
import {
  applyCategory,
  applyItem,
  buildCategory,
  buildItem,
  categoryRemovalBlocker,
  categoryToForm,
  duplicateDataset,
  emptyCategoryForm,
  emptyItemForm,
  itemToForm,
  mergeItems,
  nextItemId,
  removeCategory,
  removeItem,
  slugify,
  uniqueId,
} from './datasetEdit.ts'

const CATEGORIES: Category[] = [
  { id: 'A', name: 'Alfa', description: 'a', group: 'G1' },
  { id: 'B', name: 'Beta', description: '' },
  { id: 'C', name: 'Gamma', description: '' },
]
const ITEMS: LabeledConcept[] = [
  { id: 'item-001', concept: 'uno', expected: 'A' },
  { id: 'item-002', concept: 'dos', expected: 'B', amount: 1500.5, currency: 'COP', difficulty: 'hard', rationale: 'por qué' },
]
const DATASET: Dataset = {
  id: 'mio',
  name: 'Mío',
  description: '',
  source: 'custom',
  task: { instructions: 'inst', question: 'preg', categories: CATEGORIES },
  items: ITEMS,
}

describe('uniqueId / slugify / nextItemId', () => {
  it('uniqueId agrega sufijos y respeta el largo máximo', () => {
    expect(uniqueId('x', [])).toBe('x')
    expect(uniqueId('x', ['x'])).toBe('x-2')
    expect(uniqueId('x', ['x', 'x-2'])).toBe('x-3')
    const long = uniqueId('abcdef', ['abcdef'], 6)
    expect(long).toBe('abcd-2')
    expect(long).toHaveLength(6)
  })
  it('slugify limpia tildes y signos', () => {
    expect(slugify('Mi dataset Nº 1 — Ñandú')).toBe('mi-dataset-n-1-nandu')
    expect(slugify('***')).toBe('')
    expect(slugify('a'.repeat(80))).toHaveLength(50)
  })
  it('nextItemId continúa la numeración y evita choques', () => {
    expect(nextItemId([])).toBe('item-001')
    expect(nextItemId(ITEMS)).toBe('item-003')
    expect(nextItemId([{ id: 'item-009' }, { id: 'x' }])).toBe('item-010')
  })
  it('nextItemId sigue la numeración propia del dataset', () => {
    expect(nextItemId([{ id: 'puc-059' }, { id: 'puc-060' }])).toBe('puc-061')
    expect(nextItemId([{ id: 'a1' }, { id: 'a9' }, { id: 'a10' }])).toBe('a11')
    expect(nextItemId([{ id: 'sin-numero' }])).toBe('item-001')
  })
})

describe('duplicateDataset', () => {
  it('hace una copia profunda, personalizada y con id y nombre nuevos', () => {
    const copy = duplicateDataset(PUC_COLOMBIA_DATASET, [PUC_COLOMBIA_DATASET.id])
    expect(copy.id).toBe('puc-colombia-copia')
    expect(copy.name).toBe(`${PUC_COLOMBIA_DATASET.name} (copia)`)
    expect(copy.source).toBe('custom')
    expect(copy.items).toEqual(PUC_COLOMBIA_DATASET.items)
    expect(copy.items).not.toBe(PUC_COLOMBIA_DATASET.items)
    expect(copy.task.categories[0]).not.toBe(PUC_COLOMBIA_DATASET.task.categories[0])
    expect(validateDataset(copy).ok).toBe(true)
  })
  it('evita ids ya usados', () => {
    expect(duplicateDataset(DATASET, ['mio', 'mio-copia']).id).toBe('mio-copia-2')
  })
})

describe('mergeItems', () => {
  it('conserva los ids libres y renumera los repetidos', () => {
    const incoming: LabeledConcept[] = [
      { id: 'item-001', concept: 'n1', expected: 'A' },
      { id: 'zzz', concept: 'n2', expected: 'B' },
      { id: 'item-002', concept: 'n3', expected: 'C' },
    ]
    const { items, renumbered } = mergeItems(ITEMS, incoming)
    expect(renumbered).toBe(2)
    expect(items.map((i) => i.id)).toEqual(['item-001', 'item-002', 'item-003', 'zzz', 'item-004'])
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length)
  })
  it('no genera un id que choque con otro importado', () => {
    const incoming: LabeledConcept[] = [
      { id: 'item-001', concept: 'n1', expected: 'A' },
      { id: 'item-003', concept: 'n2', expected: 'B' },
    ]
    const { items } = mergeItems(ITEMS, incoming)
    expect(items.map((i) => i.id)).toEqual(['item-001', 'item-002', 'item-004', 'item-003'])
  })
})

describe('operaciones sobre el dataset', () => {
  it('categoryRemovalBlocker bloquea categorías en uso o el mínimo', () => {
    expect(categoryRemovalBlocker(DATASET, 'A')).toMatch(/1 concepto usa/)
    expect(categoryRemovalBlocker(DATASET, 'C')).toBeNull()
    const two = { ...DATASET, task: { ...DATASET.task, categories: CATEGORIES.slice(0, 2) } }
    expect(categoryRemovalBlocker({ ...two, items: [] }, 'B')).toMatch(/al menos 2/)
  })
  it('applyCategory agrega y propaga el cambio de código a los items', () => {
    const added = applyCategory(DATASET, { id: 'D', name: 'Delta', description: '' }, null)
    expect(added.task.categories.map((c) => c.id)).toEqual(['A', 'B', 'C', 'D'])
    const renamed = applyCategory(DATASET, { id: 'A2', name: 'Alfa', description: 'a' }, 'A')
    expect(renamed.task.categories.map((c) => c.id)).toEqual(['A2', 'B', 'C'])
    expect(renamed.items.map((i) => i.expected)).toEqual(['A2', 'B'])
    expect(validateDataset(renamed).ok).toBe(true)
  })
  it('removeCategory / applyItem / removeItem', () => {
    expect(removeCategory(DATASET, 'C').task.categories.map((c) => c.id)).toEqual(['A', 'B'])
    const edited = applyItem(DATASET, { id: 'item-001', concept: 'cambiado', expected: 'B' }, 'item-001')
    expect(edited.items[0]?.concept).toBe('cambiado')
    expect(applyItem(DATASET, { id: 'n', concept: 'x', expected: 'A' }, null).items).toHaveLength(3)
    expect(removeItem(DATASET, 'item-002').items.map((i) => i.id)).toEqual(['item-001'])
  })
  it('no muta el dataset original', () => {
    const snapshot = structuredClone(DATASET)
    applyCategory(DATASET, { id: 'A2', name: 'x', description: '' }, 'A')
    removeItem(DATASET, 'item-001')
    expect(DATASET).toEqual(snapshot)
  })
})

describe('buildCategory', () => {
  const form = { ...emptyCategoryForm(), id: ' 513530 ', name: ' Energía ', group: ' 5135 ', description: ' Luz ' }

  it('recorta y omite el grupo vacío', () => {
    expect(buildCategory(form, CATEGORIES, null)).toEqual({
      ok: true,
      value: { id: '513530', name: 'Energía', description: 'Luz', group: '5135' },
    })
    const noGroup = buildCategory({ ...form, group: ' ' }, CATEGORIES, null)
    expect(noGroup.ok && 'group' in noGroup.value).toBe(false)
  })
  it('valida código, duplicados y nombre', () => {
    const bad = buildCategory({ ...emptyCategoryForm(), id: 'a b', name: '' }, CATEGORIES, null)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors).toHaveLength(2)
    const dup = buildCategory({ ...emptyCategoryForm(), id: 'a', name: 'x' }, CATEGORIES, null)
    expect(dup.ok).toBe(false)
    expect(buildCategory({ ...emptyCategoryForm(), id: '__proto__', name: 'x' }, CATEGORIES, null).ok).toBe(false)
  })
  it('al editar permite conservar el mismo código', () => {
    expect(buildCategory(categoryToForm(CATEGORIES[0] as Category), CATEGORIES, 'A').ok).toBe(true)
  })
})

describe('buildItem', () => {
  const form = { ...emptyItemForm(ITEMS, 'A'), concept: ' Servicio ', amount: '$ 1.234.567,50', currency: 'cop', rationale: ' por qué ' }

  it('arma el item con valores normalizados', () => {
    expect(buildItem(form, ITEMS, CATEGORIES, null)).toEqual({
      ok: true,
      value: { id: 'item-003', concept: 'Servicio', expected: 'A', amount: 1234567.5, currency: 'COP', rationale: 'por qué' },
    })
  })
  it('omite los opcionales vacíos', () => {
    const result = buildItem({ ...emptyItemForm(ITEMS, 'B'), concept: 'x', currency: '' }, ITEMS, CATEGORIES, null)
    expect(result).toEqual({ ok: true, value: { id: 'item-003', concept: 'x', expected: 'B' } })
  })
  it('valida concepto, monto, categoría esperada e id repetido', () => {
    const result = buildItem({ ...emptyItemForm(ITEMS), id: 'item-001', amount: 'abc' }, ITEMS, CATEGORIES, null)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.join('|')).toMatch(/id item-001/)
      expect(result.errors.join('|')).toMatch(/concepto es obligatorio/)
      expect(result.errors.join('|')).toMatch(/monto válido/)
      expect(result.errors.join('|')).toMatch(/categoría esperada/)
    }
    expect(buildItem({ ...form, expected: 'ZZ' }, ITEMS, CATEGORIES, null).ok).toBe(false)
  })
  it('al editar permite conservar el id; ida y vuelta con itemToForm', () => {
    const item = ITEMS[1] as LabeledConcept
    const again = buildItem(itemToForm(item), ITEMS, CATEGORIES, item.id)
    expect(again).toEqual({ ok: true, value: item })
  })
})
