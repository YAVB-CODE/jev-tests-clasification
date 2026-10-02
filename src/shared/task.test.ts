import { describe, expect, it } from 'vitest'
import type { ClassificationTask, ConceptInput, LabeledConcept } from './contracts.ts'
import {
  CANONICAL_CONTEXT,
  CATEGORY_ID_PATTERN,
  LIMITS,
  STATE_KEYS,
  buildCanonicalPrompt,
  buildCriteria,
  criterionText,
  matchCategoryId,
  serializeConcept,
  toConceptInput,
  validateConceptInput,
  validateDataset,
  validateLabeledConcept,
  validateTask,
} from './task.ts'

const TASK: ClassificationTask = {
  instructions: '  Clasifica la línea de factura en una subcuenta del PUC.  ',
  question: '¿En qué subcuenta va? ',
  categories: [
    { id: '513530', name: 'Energía eléctrica', description: 'Consumo de energía.', group: '5135 Servicios' },
    { id: '513525', name: 'Acueducto y alcantarillado', description: 'Agua y alcantarillado.', group: '5135 Servicios' },
    { id: 'otros', name: 'Otros', description: '' },
  ],
}

const LABELED: LabeledConcept = {
  id: 'c-001',
  concept: '  Servicio de energía marzo  ',
  supplier: 'Enel ',
  amount: 154_300,
  currency: 'COP',
  notes: '',
  expected: '513530',
  difficulty: 'easy',
  rationale: 'Es energía.',
}

const errorsOf = (r: { ok: boolean; errors?: string[] }) => ('errors' in r ? r.errors : []) ?? []

describe('serializeConcept', () => {
  it('usa orden de claves estable, recorta y omite vacíos', () => {
    const s = serializeConcept({ notes: ' nota ', currency: ' COP', amount: 10, supplier: ' X ', concept: ' Y ', id: 'z' })
    expect(Object.keys(s)).toEqual(['concept', 'supplier', 'amount', 'currency', 'notes'])
    expect(s).toEqual({ concept: 'Y', supplier: 'X', amount: 10, currency: 'COP', notes: 'nota' })
    expect(JSON.stringify(s)).toBe('{"concept":"Y","supplier":"X","amount":10,"currency":"COP","notes":"nota"}')
  })

  it('nunca incluye id ni la etiqueta, aunque reciba un LabeledConcept', () => {
    const s = serializeConcept(LABELED)
    expect(s).toEqual({ concept: 'Servicio de energía marzo', supplier: 'Enel', amount: 154_300, currency: 'COP' })
    const json = JSON.stringify(s)
    for (const leak of ['c-001', 'expected', '513530', 'difficulty', 'rationale', 'Es energía']) {
      expect(json).not.toContain(leak)
    }
  })

  it('omite amount no finito y conserva amount 0', () => {
    expect(serializeConcept({ id: 'a', concept: 'x', amount: Number.NaN })).toEqual({ concept: 'x' })
    expect(serializeConcept({ id: 'a', concept: 'x', amount: 0 })).toEqual({ concept: 'x', amount: 0 })
  })

  it('es determinista: mismo item → mismo JSON', () => {
    const a: ConceptInput = { id: '1', concept: 'Papel', amount: 5, supplier: 'S' }
    const b: ConceptInput = { supplier: 'S', amount: 5, concept: 'Papel', id: '2' }
    expect(JSON.stringify(serializeConcept(a))).toBe(JSON.stringify(serializeConcept(b)))
  })
})

describe('criterios', () => {
  it('criterionText incluye nombre, grupo y descripción', () => {
    expect(criterionText(TASK.categories[0])).toBe('Energía eléctrica (grupo: 5135 Servicios): Consumo de energía.')
    expect(criterionText(TASK.categories[2])).toBe('Otros')
    expect(criterionText({ id: 'a', name: 'A', description: 'Desc' })).toBe('A: Desc')
  })

  it('buildCriteria mapea id → criterio para todas las categorías', () => {
    const criteria = buildCriteria(TASK.categories)
    expect(Object.keys(criteria).sort()).toEqual(['513525', '513530', 'otros'])
    for (const c of TASK.categories) expect(criteria[c.id]).toBe(criterionText(c))
  })
})

describe('buildCanonicalPrompt', () => {
  it('produce el mismo prompt para el mismo task/item (equidad)', () => {
    const forGpt = buildCanonicalPrompt(TASK, toConceptInput(LABELED))
    const forJev = buildCanonicalPrompt(TASK, toConceptInput(LABELED))
    expect(JSON.stringify(forGpt)).toBe(JSON.stringify(forJev))
  })

  it('arma state con STATE_KEYS, textos recortados y categoryIds en orden de la tarea', () => {
    const p = buildCanonicalPrompt(TASK, LABELED)
    expect(p.instructions).toBe('Clasifica la línea de factura en una subcuenta del PUC.')
    expect(p.question).toBe('¿En qué subcuenta va?')
    expect(p.context).toBe(CANONICAL_CONTEXT)
    expect(p.categoryIds).toEqual(['513530', '513525', 'otros'])
    expect(p.state).toEqual({ [STATE_KEYS.task]: p.instructions, [STATE_KEYS.item]: p.item })
    expect(Object.keys(p.state)).toEqual(['task', 'invoice_line'])
    expect(CANONICAL_CONTEXT).toContain('`task`')
    expect(CANONICAL_CONTEXT).toContain('`invoice_line`')
  })

  it('no filtra la etiqueta al recibir un LabeledConcept', () => {
    const json = JSON.stringify(buildCanonicalPrompt(TASK, LABELED))
    expect(json).not.toContain('Es energía')
    expect(json).not.toContain('expected')
    expect(json).not.toContain('c-001')
  })
})

describe('matchCategoryId', () => {
  it('solo acepta coincidencia exacta', () => {
    const ids = ['513530', 'otros']
    expect(matchCategoryId('513530', ids)).toBe('513530')
    expect(matchCategoryId(' 513530', ids)).toBeNull()
    expect(matchCategoryId('OTROS', ids)).toBeNull()
    expect(matchCategoryId(513530, ids)).toBeNull()
    expect(matchCategoryId(undefined, ids)).toBeNull()
  })
})

describe('toConceptInput', () => {
  it('quita expected, difficulty, rationale y campos extra', () => {
    const extra = { ...LABELED, secret: 'x' } as LabeledConcept
    const input = toConceptInput(extra)
    expect(input).toEqual({ id: 'c-001', concept: LABELED.concept, supplier: 'Enel ', amount: 154_300, currency: 'COP', notes: '' })
    expect(input).not.toHaveProperty('expected')
    expect(input).not.toHaveProperty('secret')
  })
})

describe('validateTask', () => {
  it('acepta una tarea válida y la normaliza', () => {
    const r = validateTask({ ...TASK, extra: 1, categories: [...TASK.categories.map((c) => ({ ...c, foo: 'bar' }))] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.instructions).toBe('Clasifica la línea de factura en una subcuenta del PUC.')
    expect(r.value).not.toHaveProperty('extra')
    expect(r.value.categories[0]).toEqual(TASK.categories[0])
    expect(r.value.categories[2]).toEqual({ id: 'otros', name: 'Otros', description: '' })
    expect(r.value.categories[0]).not.toHaveProperty('foo')
  })

  it('convierte ids numéricos a texto y tolera description ausente', () => {
    const r = validateTask({ instructions: 'i', question: 'q', categories: [{ id: 513530, name: 'A' }, { id: 'b', name: 'B' }] })
    expect(r.ok && r.value.categories[0]).toEqual({ id: '513530', name: 'A', description: '' })
  })

  it('rechaza entradas que no son objeto', () => {
    expect(errorsOf(validateTask(null))).toEqual(['task: debe ser un objeto'])
    expect(errorsOf(validateTask([]))).toEqual(['task: debe ser un objeto'])
  })

  it('exige instrucciones, pregunta y categorías', () => {
    const errors = errorsOf(validateTask({ instructions: '  ', question: 5 }))
    expect(errors).toEqual([
      'task.instructions: no puede estar vacío',
      'task.question: debe ser texto',
      'task.categories: requerido',
    ])
  })

  it('exige mínimo 2 categorías', () => {
    const errors = errorsOf(validateTask({ ...TASK, categories: [TASK.categories[0]] }))
    expect(errors).toEqual(['task.categories: mínimo 2 categorías (tiene 1)'])
  })

  it('rechaza más de LIMITS.maxCategories categorías', () => {
    const categories = Array.from({ length: LIMITS.maxCategories + 1 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, description: '' }))
    expect(errorsOf(validateTask({ ...TASK, categories }))[0]).toMatch(/^task\.categories: máximo 80 categorías/)
  })

  it('detecta ids duplicados (sin distinguir mayúsculas) con la ruta del campo', () => {
    const categories = [
      { id: 'a', name: 'A', description: '' },
      { id: 'b', name: 'B', description: '' },
      { id: 'c', name: 'C', description: '' },
      { id: 'B', name: 'B2', description: '' },
    ]
    const errors = errorsOf(validateTask({ ...TASK, categories }))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/^task\.categories\[3\]\.id: duplicado/)
    expect(errors[0]).toContain('task.categories[1].id')
  })

  it('valida el patrón y la longitud de los ids', () => {
    expect(CATEGORY_ID_PATTERN.test('5135.30_a-b')).toBe(true)
    expect(CATEGORY_ID_PATTERN.test('')).toBe(false)
    const categories = [
      { id: '5135 30', name: 'A', description: '' },
      { id: 'x'.repeat(LIMITS.idLength + 1), name: 'B', description: '' },
      { id: 'ñandú', name: 'C', description: '' },
      { id: '__proto__', name: 'D', description: '' },
      { id: '', name: 'E', description: '' },
      { id: -3, name: 'F', description: '' },
    ]
    const errors = errorsOf(validateTask({ ...TASK, categories }))
    expect(errors).toEqual([
      expect.stringMatching(/^task\.categories\[0\]\.id: formato inválido/),
      expect.stringMatching(/^task\.categories\[1\]\.id: máximo 40 caracteres/),
      expect.stringMatching(/^task\.categories\[2\]\.id: formato inválido/),
      'task.categories[3].id: valor reservado',
      'task.categories[4].id: no puede estar vacío',
      'task.categories[5].id: debe ser texto',
    ])
  })

  it('valida límites de textos y objetos de categoría', () => {
    const errors = errorsOf(
      validateTask({
        instructions: 'x'.repeat(LIMITS.textLength + 1),
        question: 'q',
        categories: ['a', { id: 'b', name: 'B', description: 'd'.repeat(LIMITS.textLength + 1) }, { id: 'c' }],
      }),
    )
    expect(errors).toEqual([
      `task.instructions: máximo ${LIMITS.textLength} caracteres (tiene ${LIMITS.textLength + 1})`,
      'task.categories[0]: debe ser un objeto',
      `task.categories[1].description: máximo ${LIMITS.textLength} caracteres (tiene ${LIMITS.textLength + 1})`,
      'task.categories[2].name: requerido',
    ])
  })

  it('usa la ruta indicada y limita la cantidad de errores', () => {
    const categories = Array.from({ length: 40 }, () => ({ id: '!', name: '' }))
    const errors = errorsOf(validateTask({ instructions: 'i', question: 'q', categories }, 'dataset.task'))
    expect(errors).toHaveLength(LIMITS.maxErrors + 1)
    expect(errors[0]).toMatch(/^dataset\.task\.categories\[0\]\.id: formato inválido/)
    expect(errors.at(-1)).toBe(`… y ${80 - LIMITS.maxErrors} errores más`)
  })
})

describe('validateConceptInput', () => {
  it('acepta un concepto válido y descarta la etiqueta y campos desconocidos', () => {
    const body: unknown = JSON.parse(JSON.stringify({ ...LABELED, hack: true }).replace('{', '{"__proto__":{"polluted":1},'))
    const r = validateConceptInput(body)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ id: 'c-001', concept: 'Servicio de energía marzo', supplier: 'Enel', amount: 154_300, currency: 'COP' })
    for (const key of ['expected', 'difficulty', 'rationale', 'hack', 'notes', 'polluted']) expect(r.value).not.toHaveProperty(key)
    expect(Object.getPrototypeOf(r.value)).toBe(Object.prototype)
    expect(JSON.stringify(r.value)).not.toContain('513530')
  })

  it('trata null como ausente en opcionales y convierte id numérico', () => {
    const r = validateConceptInput({ id: 7, concept: 'Papel', supplier: null, amount: null })
    expect(r).toEqual({ ok: true, value: { id: '7', concept: 'Papel' } })
  })

  it('rechaza tipos y límites inválidos', () => {
    const errors = errorsOf(
      validateConceptInput({
        id: '',
        concept: 'x'.repeat(LIMITS.conceptLength + 1),
        supplier: 3,
        amount: '1000',
        currency: 'PESOS COLOMBIANOS',
      }),
    )
    expect(errors).toEqual([
      'item.id: no puede estar vacío',
      `item.concept: máximo ${LIMITS.conceptLength} caracteres (tiene ${LIMITS.conceptLength + 1})`,
      'item.supplier: debe ser texto',
      'item.amount: debe ser un número finito',
      `item.currency: máximo ${LIMITS.currencyLength} caracteres (tiene 17)`,
    ])
  })

  it('exige concept y rechaza no-objetos', () => {
    expect(errorsOf(validateConceptInput({ id: 'a' }))).toEqual(['item.concept: requerido'])
    expect(errorsOf(validateConceptInput('texto'))).toEqual(['item: debe ser un objeto'])
    expect(errorsOf(validateConceptInput({ id: 'a', concept: 'b', amount: Infinity }))).toEqual(['item.amount: debe ser un número finito'])
    expect(errorsOf(validateConceptInput({ id: 'a', concept: 'b', amount: 1e16 }))[0]).toMatch(/^item\.amount: fuera de rango/)
  })
})

describe('validateLabeledConcept', () => {
  const ids = TASK.categories.map((c) => c.id)

  it('acepta un concepto etiquetado válido y normaliza la dificultad', () => {
    const r = validateLabeledConcept({ ...LABELED, difficulty: ' Hard ' }, ids)
    expect(r.ok && r.value).toEqual({
      id: 'c-001',
      concept: 'Servicio de energía marzo',
      supplier: 'Enel',
      amount: 154_300,
      currency: 'COP',
      expected: '513530',
      difficulty: 'hard',
      rationale: 'Es energía.',
    })
  })

  it('rechaza expected fuera de la tarea y dificultad inválida', () => {
    const errors = errorsOf(validateLabeledConcept({ id: 'a', concept: 'b', expected: '999999', difficulty: 'facil' }, ids, 'items[2]'))
    expect(errors).toEqual(['items[2].expected: "999999" no es una categoría de la tarea', 'items[2].difficulty: debe ser easy, medium o hard'])
    expect(errorsOf(validateLabeledConcept({ id: 'a', concept: 'b' }))).toEqual(['item.expected: requerido'])
  })
})

describe('validateDataset', () => {
  const dataset = {
    id: 'puc-colombia',
    name: 'PUC Colombia',
    description: 'Semilla',
    locale: 'es-CO',
    source: 'seed',
    task: TASK,
    items: [LABELED, { id: 'c-002', concept: 'Agua', expected: '513525' }],
  }

  it('acepta un dataset válido', () => {
    const r = validateDataset({ ...dataset, extra: true })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(Object.keys(r.value)).toEqual(['id', 'name', 'description', 'locale', 'source', 'task', 'items'])
    expect(r.value.items).toHaveLength(2)
    expect(r.value.items[1]).toEqual({ id: 'c-002', concept: 'Agua', expected: '513525' })
  })

  it('detecta ids de item duplicados, etiquetas desconocidas y source inválido', () => {
    const items = [LABELED, { ...LABELED, expected: 'nope' }]
    const errors = errorsOf(validateDataset({ ...dataset, source: 'web', items }))
    expect(errors).toEqual([
      'dataset.source: debe ser seed o custom',
      'dataset.items[1].expected: "nope" no es una categoría de la tarea',
      'dataset.items[1].id: duplicado (igual que dataset.items[0].id)',
    ])
  })

  it('propaga los errores de la tarea y exige items', () => {
    const errors = errorsOf(validateDataset({ id: 'x', name: 'X', task: { instructions: 'i', question: 'q', categories: [] }, items: [] }))
    expect(errors).toEqual(['dataset.task.categories: mínimo 2 categorías (tiene 0)', 'dataset.items: debe tener al menos 1 concepto'])
  })
})
