import { describe, expect, it } from 'vitest'
import type { Category } from '../shared/contracts.ts'
import { DEFAULT_TASK_INSTRUCTIONS, DEFAULT_TASK_QUESTION, validateDataset } from '../shared/task.ts'
import {
  categoriesToCsv,
  datasetToJson,
  itemsToCsv,
  normalizeKey,
  parseAmount,
  parseCategoriesCsv,
  parseDatasetJson,
  parseDifficulty,
  parseItemsCsv,
} from './importDataset.ts'
import { PUC_COLOMBIA_DATASET } from './puc-colombia.ts'

const CATEGORIES: Category[] = [
  { id: '513530', name: 'Energía eléctrica', description: 'Consumo de energía.', group: '5135 Servicios' },
  { id: '513535', name: 'Teléfono', description: 'Telefonía e internet.', group: '5135 Servicios' },
  { id: 'A-1', name: 'Otra', description: '' },
]

function expectFailure<T extends { ok: boolean }>(result: T): string[] {
  expect(result.ok).toBe(false)
  return (result as unknown as { errors: string[] }).errors
}

describe('normalizeKey', () => {
  it('quita tildes, mayúsculas, paréntesis y signos', () => {
    expect(normalizeKey(' Justificación (breve) ')).toBe('justificacion')
    expect(normalizeKey('Código_PUC')).toBe('codigo puc')
    expect(normalizeKey('DIFÍCIL')).toBe('dificil')
  })
})

describe('parseAmount', () => {
  it.each([
    ['$ 1.234.567,89', 1234567.89],
    ['1.234.567', 1234567],
    ['1234567.89', 1234567.89],
    ['1234567,89', 1234567.89],
    ['1,234,567.89', 1234567.89],
    ['1,234,567', 1234567],
    ['150.000', 150000],
    ['COP 4.800.000', 4800000],
    ['12.5', 12.5],
    ['0.125', 0.125],
    ['1,5', 1.5],
    ['980000', 980000],
    ['-1.200,50', -1200.5],
    ['(1.200)', -1200],
    ['  $ 2.350.000  ', 2350000],
  ])('%s → %s', (text, expected) => {
    expect(parseAmount(text)).toBeCloseTo(expected, 6)
  })

  it.each(['abc', '12a', '1.2.3,4,5', '1,23,456', '--5', '$', ''])('rechaza «%s»', (text) => {
    expect(parseAmount(text)).toBeNull()
  })
})

describe('parseDifficulty', () => {
  it('acepta español e inglés sin importar tildes ni mayúsculas', () => {
    expect(parseDifficulty('Fácil')).toBe('easy')
    expect(parseDifficulty('media')).toBe('medium')
    expect(parseDifficulty('DIFÍCIL')).toBe('hard')
    expect(parseDifficulty('easy')).toBe('easy')
    expect(parseDifficulty('Medium')).toBe('medium')
    expect(parseDifficulty('hard')).toBe('hard')
    expect(parseDifficulty('constructor')).toBeUndefined()
    expect(parseDifficulty('')).toBeUndefined()
  })
})

describe('parseItemsCsv', () => {
  it('lee encabezados en español, con tildes y mayúsculas, y montos colombianos', () => {
    const csv = [
      'Concepto,Cuenta,Proveedor,Valor (COP),Moneda,Notas,Dificultad,Justificación',
      'CONSUMO ENERGIA SEP,513530,Energía S.A.,"$ 1.234.567,89",cop,Periodo 09/2026,Fácil,Es energía',
      'Plan 50 GB,513535,,150000,,,media,',
    ].join('\n')
    const result = parseItemsCsv(csv, CATEGORIES)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items).toEqual([
      {
        id: 'item-001',
        concept: 'CONSUMO ENERGIA SEP',
        supplier: 'Energía S.A.',
        amount: 1234567.89,
        currency: 'COP',
        notes: 'Periodo 09/2026',
        expected: '513530',
        difficulty: 'easy',
        rationale: 'Es energía',
      },
      { id: 'item-002', concept: 'Plan 50 GB', amount: 150000, expected: '513535', difficulty: 'medium' },
    ])
  })

  it('lee encabezados en inglés y separador «;» (Excel en español)', () => {
    const csv = 'concept;expected;supplier;amount;currency;notes;difficulty;rationale\nENERGIA;513530;ACME;1234567.89;COP;nota;HARD;porque\n'
    const result = parseItemsCsv(csv, CATEGORIES)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items[0]).toMatchObject({ concept: 'ENERGIA', expected: '513530', supplier: 'ACME', amount: 1234567.89, difficulty: 'hard' })
  })

  it('tolera BOM, filas en blanco, ids explícitos y genera el resto sin chocar', () => {
    const csv = '﻿id,concepto,esperado\nitem-001,Uno,513530\n\n,Dos,513535\nx-9,Tres,A-1\n,Cuatro,513530\n'
    const result = parseItemsCsv(csv, CATEGORIES)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items.map((i) => i.id)).toEqual(['item-001', 'item-002', 'x-9', 'item-003'])
    expect(result.items.map((i) => i.concept)).toEqual(['Uno', 'Dos', 'Tres', 'Cuatro'])
  })

  it('resuelve «esperado» por id exacto, otra capitalización o nombre de la categoría', () => {
    const csv = 'concepto,esperado\na,a-1\nb,Energía eléctrica\nc,513530\n'
    const result = parseItemsCsv(csv, CATEGORIES)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items.map((i) => i.expected)).toEqual(['A-1', '513530', '513530'])
  })

  it('reporta errores por fila, en español y con el número de fila del archivo', () => {
    const csv = [
      'concepto,esperado,valor,dificultad',
      'Ok,513530,100,fácil',
      ',513530,,',
      'Sin cuenta,,,',
      'Cuenta rara,999999,,',
      'Monto malo,513530,doce pesos,',
      'Dificultad mala,513530,,imposible',
    ].join('\n')
    const errors = expectFailure(parseItemsCsv(csv, CATEGORIES))
    expect(errors).toContain('Fila 3: «concepto» está vacío.')
    expect(errors).toContain('Fila 4: «esperado» está vacío.')
    expect(errors.some((e) => e.startsWith('Fila 5: «esperado» «999999» no coincide con ninguna categoría'))).toBe(true)
    expect(errors.some((e) => e.startsWith('Fila 6: «valor» «doce pesos» no es un monto válido'))).toBe(true)
    expect(errors.some((e) => e.startsWith('Fila 7: «dificultad» «imposible» no es válida'))).toBe(true)
    expect(errors).toHaveLength(5)
  })

  it('detecta ids repetidos y límites de largo con el número de fila', () => {
    const csv = `id,concepto,esperado\na,Uno,513530\na,Dos,513530\nb,${'x'.repeat(600)},513530\n`
    const errors = expectFailure(parseItemsCsv(csv, CATEGORIES))
    expect(errors).toContain('Fila 3: el id «a» está repetido (ya se usó en la fila 2).')
    expect(errors.some((e) => e.startsWith('Fila 4, «concepto»: máximo 500 caracteres'))).toBe(true)
  })

  it('exige las columnas obligatorias y avisa de las desconocidas', () => {
    expect(expectFailure(parseItemsCsv('proveedor,valor\nA,1\n', CATEGORIES)).join('\n')).toMatch(/Falta la columna obligatoria «concepto»[\s\S]*«esperado»/)
    const ok = parseItemsCsv('concepto,esperado,color\nA,513530,rojo\n', CATEGORIES)
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.warnings).toEqual(['Se ignoró la columna «color» (no es un campo conocido).'])
  })

  it('rechaza archivos vacíos, sin filas o sin categorías', () => {
    expect(expectFailure(parseItemsCsv('', CATEGORIES))).toEqual(['El archivo está vacío.'])
    expect(expectFailure(parseItemsCsv('   \n\n', CATEGORIES))).toEqual(['El archivo está vacío.'])
    expect(expectFailure(parseItemsCsv('concepto,esperado\n', CATEGORIES))[0]).toMatch(/no tiene filas/)
    expect(expectFailure(parseItemsCsv('concepto,esperado\nA,x\n', []))[0]).toMatch(/Define primero las categorías/)
  })

  it('detecta comillas sin cerrar', () => {
    const errors = expectFailure(parseItemsCsv('concepto,esperado\n"abierto,513530\n', CATEGORIES))
    expect(errors[0]).toMatch(/^Fila \d+: comillas/)
  })

  it('resume los errores cuando son demasiados', () => {
    const rows = Array.from({ length: 40 }, () => ',513530').join('\n')
    const errors = expectFailure(parseItemsCsv(`concepto,esperado\n${rows}\n`, CATEGORIES))
    expect(errors).toHaveLength(26)
    expect(errors[25]).toBe('… y 15 errores más')
  })

  it('exportar y volver a importar el dataset semilla no pierde nada', () => {
    for (const delimiter of [',', ';']) {
      const csv = itemsToCsv(PUC_COLOMBIA_DATASET.items, { delimiter })
      const result = parseItemsCsv(csv, PUC_COLOMBIA_DATASET.task.categories)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.items).toEqual(PUC_COLOMBIA_DATASET.items)
    }
  })
})

describe('itemsToCsv', () => {
  it('escribe encabezados en español, dificultad en español y montos simples', () => {
    const csv = itemsToCsv([
      { id: 'a', concept: 'Con, coma "y comillas"', expected: '513530', amount: 1234.5, difficulty: 'hard' },
      { id: 'b', concept: '=SUMA(A1)', expected: '513530', amount: 234.567 },
    ])
    const [header, first, second] = csv.split('\n')
    expect(header).toBe('id,concepto,proveedor,valor,moneda,notas,esperado,dificultad,justificacion')
    expect(first).toBe('a,"Con, coma ""y comillas""",,1234.5,,,513530,difícil,')
    // Las fórmulas se neutralizan y un decimal ambiguo con el separador de miles sale con coma.
    expect(second).toBe('b,"\'=SUMA(A1)",,"234,567",,,513530,,')
  })

  it('el round-trip conserva fórmulas, saltos de línea y decimales ambiguos', () => {
    const items = [
      { id: 'a', concept: '=SUMA(A1)', expected: '513530', amount: 234.567, notes: 'línea 1\nlínea 2' },
      { id: 'b', concept: '@usuario', expected: 'A-1', amount: -1500.25 },
    ]
    const result = parseItemsCsv(itemsToCsv(items), CATEGORIES)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.items).toEqual(items)
  })
})

describe('parseCategoriesCsv', () => {
  it('lee id|codigo, nombre|name, descripcion y grupo', () => {
    const csv = 'Código;Nombre;Descripción;Grupo\n513530;Energía eléctrica;Consumo;5135 Servicios\nA-1;Otra;;\n'
    const result = parseCategoriesCsv(csv)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.categories).toEqual([
      { id: '513530', name: 'Energía eléctrica', description: 'Consumo', group: '5135 Servicios' },
      { id: 'A-1', name: 'Otra', description: '' },
    ])
  })

  it('reporta filas inválidas con su número', () => {
    const csv = 'id,name\n513530,Energía\n,Sin id\nA B,Id con espacio\n513530,Repetida\nX,\n'
    const errors = expectFailure(parseCategoriesCsv(csv))
    expect(errors).toContain('Fila 3: «id» está vacío.')
    expect(errors.some((e) => e.startsWith('Fila 4: «id» «A B» no es válido'))).toBe(true)
    expect(errors).toContain('Fila 6: «nombre» está vacío.')
  })

  it('detecta ids duplicados y el mínimo de categorías mediante validateTask', () => {
    const dup = expectFailure(parseCategoriesCsv('id,nombre\n513530,Uno\n513530,Dos\n'))
    expect(dup).toEqual(['Fila 3, «id»: duplicado (igual que la fila 2)'])
    const few = expectFailure(parseCategoriesCsv('id,nombre\n513530,Uno\n'))
    expect(few[0]).toMatch(/^Categorías: mínimo 2 categorías/)
  })

  it('exige id y nombre', () => {
    expect(expectFailure(parseCategoriesCsv('descripcion\nalgo\n')).join('\n')).toMatch(/«id»[\s\S]*«nombre»/)
  })

  it('exportar y volver a importar las categorías semilla no pierde nada', () => {
    const result = parseCategoriesCsv(categoriesToCsv(PUC_COLOMBIA_DATASET.task.categories))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.categories).toEqual(PUC_COLOMBIA_DATASET.task.categories)
  })
})

describe('parseDatasetJson / datasetToJson', () => {
  const minimal = {
    name: 'Mi dataset',
    task: { categories: CATEGORIES },
    items: [
      { concept: 'ENERGIA', expected: '513530' },
      { id: 'item-001', concept: 'PLAN', expected: 513535 },
      { concept: 'OTRO', expected: 'A-1', difficulty: 'hard' },
    ],
  }

  it('importa un dataset mínimo: marca custom, genera ids y usa instrucciones por defecto', () => {
    const result = parseDatasetJson(JSON.stringify(minimal))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { dataset } = result
    expect(dataset.source).toBe('custom')
    expect(dataset.id).toMatch(/^custom-/)
    expect(dataset.name).toBe('Mi dataset')
    expect(dataset.task.instructions).toBe(DEFAULT_TASK_INSTRUCTIONS)
    expect(dataset.task.question).toBe(DEFAULT_TASK_QUESTION)
    // «item-001» ya está tomado: el generado salta al siguiente libre.
    expect(dataset.items.map((i) => i.id)).toEqual(['item-002', 'item-001', 'item-003'])
    expect(dataset.items[1]?.expected).toBe('513535')
    expect(validateDataset(dataset).ok).toBe(true)
  })

  it('no confía en `source` ni en campos desconocidos del archivo', () => {
    const result = parseDatasetJson(JSON.stringify({ ...minimal, id: 'mio', source: 'seed', extra: 1 }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dataset.id).toBe('mio')
    expect(result.dataset.source).toBe('custom')
    expect(result.dataset).not.toHaveProperty('extra')
  })

  it('renombra el id si coincide con el de un dataset semilla', () => {
    const result = parseDatasetJson(JSON.stringify({ ...minimal, id: PUC_COLOMBIA_DATASET.id }))
    expect(result.ok && result.dataset.id).toBe(`${PUC_COLOMBIA_DATASET.id}-copia`)
  })

  it('reporta JSON inválido, tipos incorrectos y etiquetas fuera de las categorías', () => {
    expect(expectFailure(parseDatasetJson('{no es json'))[0]).toMatch(/^El archivo no es un JSON válido/)
    expect(expectFailure(parseDatasetJson('[1,2]'))[0]).toMatch(/debe ser un objeto/)
    expect(expectFailure(parseDatasetJson('{}')).join('\n')).toMatch(/task: debe ser un objeto[\s\S]*items: requerido/)
    const bad = { ...minimal, items: [{ concept: '', expected: '513530' }, { concept: 'X', expected: '000000' }, { id: 'd', concept: 'Y', expected: 'A-1' }, { id: 'd', concept: 'Z', expected: 'A-1' }] }
    const errors = expectFailure(parseDatasetJson(JSON.stringify(bad))).join('\n')
    expect(errors).toMatch(/items\[0\]\.concept: no puede estar vacío/)
    expect(errors).toMatch(/items\[1\]\.expected: "000000" no es una categoría de la tarea/)
    expect(errors).toMatch(/items\[3\]\.id: duplicado/)
  })

  it('exportar el dataset semilla y reimportarlo conserva tarea e items', () => {
    const json = datasetToJson(PUC_COLOMBIA_DATASET)
    const result = parseDatasetJson(json)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dataset.task).toEqual(PUC_COLOMBIA_DATASET.task)
    expect(result.dataset.items).toEqual(PUC_COLOMBIA_DATASET.items)
    expect(result.dataset.source).toBe('custom')
    expect(result.dataset.id).toBe(`${PUC_COLOMBIA_DATASET.id}-copia`)
  })
})
