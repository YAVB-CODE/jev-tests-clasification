import { describe, expect, it } from 'vitest'
import type { Dataset } from '../../shared/contracts.ts'
import { DEFAULT_TASK_INSTRUCTIONS, validateDataset } from '../../shared/task.ts'
import { categoriesToCsv, datasetToJson, itemsToCsv, parseCategoriesCsv, parseItemsCsv } from '../../data/importDataset.ts'
import { PUC_COLOMBIA_DATASET } from '../../data/puc-colombia.ts'
import { categoriesTemplateCsv, itemsTemplateCsv, planItemsImport, planJsonImport } from './importFlow.ts'

const CUSTOM: Dataset = {
  id: 'mio',
  name: 'Mío',
  description: 'd',
  source: 'custom',
  task: {
    instructions: 'Clasifica.',
    question: '¿Cuál?',
    categories: [
      { id: 'A', name: 'Alfa', description: 'a' },
      { id: 'B', name: 'Beta', description: 'b' },
    ],
  },
  items: [{ id: 'item-001', concept: 'uno', expected: 'A' }],
}

function errorsOf(plan: ReturnType<typeof planJsonImport>): string[] {
  expect(plan.ok).toBe(false)
  return plan.ok ? [] : plan.errors
}

describe('planJsonImport', () => {
  it('importa un dataset exportado como uno nuevo y personalizado', () => {
    const plan = planJsonImport(datasetToJson(CUSTOM), [])
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.mode).toBe('create')
    expect(plan.itemCount).toBe(1)
    expect(plan.dataset).toMatchObject({ id: 'mio', source: 'custom' })
    expect(plan.warnings).toEqual([])
  })
  it('cambia el id si ya existe y lo avisa', () => {
    const plan = planJsonImport(datasetToJson(CUSTOM), ['mio'])
    expect(plan.ok && plan.dataset.id).toBe('mio-2')
    expect(plan.ok && plan.warnings[0]).toMatch(/mio-2/)
  })
  it('un dataset con id semilla ya sale renombrado y se puede volver a importar', () => {
    const plan = planJsonImport(datasetToJson(PUC_COLOMBIA_DATASET), [PUC_COLOMBIA_DATASET.id])
    expect(plan.ok && plan.dataset.id).toBe('puc-colombia-copia')
  })
  it('devuelve los errores de validación en español', () => {
    expect(errorsOf(planJsonImport('{ no es json', []))[0]).toMatch(/JSON válido/)
    expect(errorsOf(planJsonImport(JSON.stringify({ task: { categories: [] }, items: [] }), [])).length).toBeGreaterThan(0)
  })
})

describe('planItemsImport', () => {
  const itemsCsv = 'concepto,esperado,proveedor,valor\nCompra uno,A,Prov,"1.500"\nCompra dos,Beta,,\n'

  it('crea un dataset nuevo con la tarea del dataset seleccionado', () => {
    const plan = planItemsImport({ itemsText: itemsCsv, baseTask: CUSTOM.task, name: 'Mi lote Nº 2', takenIds: ['mi-lote-n-2'] })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.mode).toBe('create')
    expect(plan.itemCount).toBe(2)
    expect(plan.dataset.id).toBe('mi-lote-n-2-2')
    expect(plan.dataset.name).toBe('Mi lote Nº 2')
    expect(plan.dataset.task).toEqual(CUSTOM.task)
    expect(plan.dataset.task).not.toBe(CUSTOM.task)
    expect(plan.dataset.items.map((i) => [i.id, i.expected])).toEqual([
      ['item-001', 'A'],
      ['item-002', 'B'],
    ])
    expect(plan.dataset.items[0]?.amount).toBe(1500)
    expect(validateDataset(plan.dataset).ok).toBe(true)
  })
  it('usa las categorías de un CSV aparte con la tarea por defecto', () => {
    const plan = planItemsImport({
      itemsText: 'concepto,esperado\nUno,X1\n',
      categoriesText: categoriesToCsv([
        { id: 'X1', name: 'Equis', description: '' },
        { id: 'X2', name: 'Ye', description: '' },
      ]),
      baseTask: CUSTOM.task,
      name: '',
      takenIds: [],
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.dataset.name).toBe('Dataset importado')
    expect(plan.dataset.id).toBe('dataset-importado')
    expect(plan.dataset.task.instructions).toBe(DEFAULT_TASK_INSTRUCTIONS)
    expect(plan.dataset.task.categories.map((c) => c.id)).toEqual(['X1', 'X2'])
  })
  it('agrega al dataset actual renumerando ids repetidos', () => {
    const plan = planItemsImport({ itemsText: itemsCsv, baseTask: CUSTOM.task, name: 'ignorado', takenIds: [], appendTo: CUSTOM })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.mode).toBe('append')
    expect(plan.dataset.id).toBe('mio')
    expect(plan.dataset.items.map((i) => i.id)).toEqual(['item-001', 'item-003', 'item-002'])
    expect(plan.warnings.join(' ')).toMatch(/1 concepto/)
  })
  it('un roundtrip con itemsToCsv no pierde conceptos', () => {
    const plan = planItemsImport({
      itemsText: itemsToCsv(PUC_COLOMBIA_DATASET.items),
      baseTask: PUC_COLOMBIA_DATASET.task,
      name: 'Copia',
      takenIds: [],
    })
    expect(plan.ok && plan.dataset.items).toEqual(PUC_COLOMBIA_DATASET.items)
  })
  it('reporta errores por fila con el origen', () => {
    const plan = planItemsImport({ itemsText: 'concepto,esperado\nUno,ZZ\n,A\n', baseTask: CUSTOM.task, name: 'x', takenIds: [] })
    const errors = errorsOf(plan)
    expect(errors.length).toBeGreaterThanOrEqual(2)
    expect(errors.every((e) => e.startsWith('Conceptos · Fila '))).toBe(true)
    const badCategories = planItemsImport({
      itemsText: 'concepto,esperado\nUno,A\n',
      categoriesText: 'id,nombre\n,Algo\n',
      baseTask: CUSTOM.task,
      name: 'x',
      takenIds: [],
    })
    expect(errorsOf(badCategories)[0]).toMatch(/^Categorías · Fila 2/)
  })
})

describe('plantillas CSV', () => {
  it('las plantillas se pueden volver a importar', () => {
    const categories = parseCategoriesCsv(categoriesTemplateCsv())
    expect(categories.ok).toBe(true)
    if (!categories.ok) return
    expect(categories.categories).toHaveLength(2)
    const items = parseItemsCsv(itemsTemplateCsv(categories.categories), categories.categories)
    expect(items.ok && items.items).toHaveLength(1)
    expect(items.ok && items.items[0]?.expected).toBe('513530')
  })
})
