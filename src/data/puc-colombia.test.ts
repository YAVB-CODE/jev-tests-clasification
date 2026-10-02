import { describe, expect, it } from 'vitest'
import { SEED_DATASET_ID, type Difficulty, type LabeledConcept } from '../shared/contracts.ts'
import { CATEGORY_ID_PATTERN, LIMITS, buildCanonicalPrompt, validateDataset, validateTask } from '../shared/task.ts'
import { DEFAULT_DATASET_ID, SEED_DATASETS, getSeedDataset } from './datasets.ts'
import { CAPITALIZATION_THRESHOLD_COP, PUC_COLOMBIA_DATASET as dataset } from './puc-colombia.ts'

const { task, items } = dataset

function countBy<T>(list: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of list) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1)
  return counts
}

/** Cantidad de unidades que declara el concepto («x2 UND», «1 UND»), si la declara. */
function quantity(item: LabeledConcept): number | undefined {
  const match = /\bx?(\d+)\s*UND\b/i.exec(item.concept)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

describe('dataset semilla PUC Colombia', () => {
  it('es un dataset válido y está registrado como semilla por defecto', () => {
    expect(validateDataset(dataset).ok).toBe(true)
    expect(dataset.id).toBe(SEED_DATASET_ID)
    expect(dataset.source).toBe('seed')
    expect(dataset.locale).toBe('es-CO')
    expect(SEED_DATASETS).toContain(dataset)
    expect(DEFAULT_DATASET_ID).toBe(SEED_DATASET_ID)
    expect(getSeedDataset(DEFAULT_DATASET_ID)).toBe(dataset)
    expect(getSeedDataset('no-existe')).toBeUndefined()
  })

  it('la tarea pasa validateTask sin cambios', () => {
    const result = validateTask(task)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual(task)
  })

  it('cabe en los límites de texto', () => {
    expect(task.instructions.length).toBeLessThanOrEqual(LIMITS.textLength)
    expect(task.question.length).toBeLessThanOrEqual(LIMITS.textLength)
    for (const category of task.categories) {
      expect(category.description.length).toBeLessThanOrEqual(LIMITS.textLength)
      expect(category.description.length).toBeGreaterThan(40)
    }
    for (const item of items) expect(item.concept.length).toBeLessThanOrEqual(LIMITS.conceptLength)
  })

  it('tiene ~27 subcuentas con id PUC, grupo y descripción', () => {
    expect(task.categories.length).toBeGreaterThanOrEqual(20)
    expect(task.categories.length).toBeLessThanOrEqual(30)
    const ids = task.categories.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const category of task.categories) {
      expect(category.id).toMatch(CATEGORY_ID_PATTERN)
      expect(category.id).toMatch(/^\d{4}(\d{2})?$/)
      expect(category.group).toMatch(/^\d{4} \S/)
      // La cuenta de 4 dígitos del grupo es el prefijo del código de la subcuenta.
      expect(category.id.startsWith(category.group?.slice(0, 4) ?? '?')).toBe(true)
    }
    // Orden canónico: por código.
    expect(ids).toEqual([...ids].sort())
  })

  it('las instrucciones traen las políticas que resuelven los casos frontera', () => {
    expect(task.instructions).toContain('2.500.000')
    expect(task.instructions).toMatch(/licencias perpetuas/i)
    expect(task.instructions).toMatch(/suscripciones/i)
    expect(task.instructions).toMatch(/IVA/)
    expect(task.question).toMatch(/subcuenta del PUC/)
  })

  it('tiene 60 items con ids estables puc-001…puc-060 y sin repetidos', () => {
    expect(items).toHaveLength(60)
    expect(items.map((item) => item.id)).toEqual(Array.from({ length: 60 }, (_, i) => `puc-${String(i + 1).padStart(3, '0')}`))
  })

  it('cada etiqueta esperada es una categoría y cada categoría tiene al menos 2 items', () => {
    const categoryIds = new Set(task.categories.map((c) => c.id))
    for (const item of items) expect(categoryIds.has(item.expected)).toBe(true)
    const counts = countBy(items, (item) => item.expected)
    for (const category of task.categories) expect(counts.get(category.id) ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('distribución de dificultad aproximada (~20 fáciles, ~25 medias, ~15 difíciles)', () => {
    const counts = countBy(items, (item) => item.difficulty ?? 'none')
    expect(counts.get('none')).toBeUndefined()
    const of = (d: Difficulty): number => counts.get(d) ?? 0
    expect(of('easy')).toBeGreaterThanOrEqual(18)
    expect(of('easy')).toBeLessThanOrEqual(22)
    expect(of('medium')).toBeGreaterThanOrEqual(22)
    expect(of('medium')).toBeLessThanOrEqual(28)
    expect(of('hard')).toBeGreaterThanOrEqual(13)
    expect(of('hard')).toBeLessThanOrEqual(17)
  })

  it('todos los items tienen justificación, proveedor, monto positivo en COP y conceptos distintos', () => {
    for (const item of items) {
      expect(item.rationale?.trim().length ?? 0).toBeGreaterThan(10)
      expect(item.supplier?.trim()).toBeTruthy()
      expect(item.amount ?? 0).toBeGreaterThan(0)
      expect(item.currency).toBe('COP')
    }
    expect(new Set(items.map((item) => item.concept)).size).toBe(items.length)
  })

  it('el orden está mezclado: ninguna subcuenta ni grupo aparece dos veces seguidas', () => {
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1]
      const current = items[i]
      expect(current?.expected.slice(0, 4)).not.toBe(prev?.expected.slice(0, 4))
    }
  })

  it('respeta el umbral de capitalización de las instrucciones (valor unitario)', () => {
    let checked = 0
    for (const item of items) {
      const units = quantity(item)
      if (units === undefined || item.amount === undefined) continue
      const unit = item.amount / units
      if (item.expected === '152405' || item.expected === '152805') {
        expect(unit).toBeGreaterThanOrEqual(CAPITALIZATION_THRESHOLD_COP)
        checked++
      } else if (item.expected === '519530' && /PORTATIL|SILLA/.test(item.concept)) {
        expect(unit).toBeLessThan(CAPITALIZATION_THRESHOLD_COP)
        checked++
      }
    }
    expect(checked).toBeGreaterThanOrEqual(6)
  })

  it('suscripción vs. licencia perpetua es coherente con la política', () => {
    for (const item of items) {
      if (/PERPETUA/.test(item.concept)) expect(item.expected).toBe('1635')
      if (/SUSCRIPCION|PLAN ANUAL|HOSTING/.test(item.concept)) expect(item.expected).toBe('513520')
    }
  })

  it('los modelos no ven la etiqueta ni la justificación (equidad)', () => {
    for (const item of items) {
      const prompt = buildCanonicalPrompt(task, item)
      const seen = JSON.stringify(prompt.state)
      expect(seen).not.toContain(item.rationale ?? '\u0000')
      expect(Object.keys(prompt.item)).not.toContain('expected')
      expect(Object.keys(prompt.item)).not.toContain('id')
    }
  })
})
