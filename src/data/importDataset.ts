/**
 * Importadores y exportadores de datasets personalizados (JSON y CSV).
 *
 * - JSON: un `Dataset` completo; se valida con `validateDataset` (task.ts) y siempre queda `source: 'custom'`.
 * - CSV: conceptos (`parseItemsCsv`) y categorías (`parseCategoriesCsv`) por separado. Encabezados en
 *   español o inglés, sin importar mayúsculas ni tildes. Los errores llevan el número de fila del archivo
 *   (la fila 1 es el encabezado) y están en español.
 */
import * as Papa from 'papaparse'
import type { Category, Dataset, Difficulty, LabeledConcept } from '../shared/contracts.ts'
import {
  CATEGORY_ID_PATTERN,
  DEFAULT_TASK_INSTRUCTIONS,
  DEFAULT_TASK_QUESTION,
  LIMITS,
  validateDataset,
  validateLabeledConcept,
  validateTask,
} from '../shared/task.ts'
import { SEED_DATASETS } from './datasets.ts'

// ─────────────────────────────── Resultados ────────────────────────────────

export interface ImportFailure {
  ok: false
  errors: string[]
}
export type DatasetImport = { ok: true; dataset: Dataset } | ImportFailure
export type ItemsImport = { ok: true; items: LabeledConcept[]; warnings: string[] } | ImportFailure
export type CategoriesImport = { ok: true; categories: Category[]; warnings: string[] } | ImportFailure

function fail(errors: string[]): ImportFailure {
  if (errors.length <= LIMITS.maxErrors) return { ok: false, errors }
  const rest = errors.length - LIMITS.maxErrors
  return { ok: false, errors: [...errors.slice(0, LIMITS.maxErrors), `… y ${rest} errores más`] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ─────────────────────────────── Normalización ────────────────────────────────

/** Minúsculas, sin tildes ni paréntesis ni signos: «Justificación (breve)» → «justificacion». */
export function normalizeKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Convierte un monto de texto a número. Acepta formato colombiano (`$ 1.234.567,89`: punto de miles, coma
 * decimal), simple (`1234567.89`, `1234567,89`) y anglosajón (`1,234,567.89`); ignora símbolos de moneda
 * (`$`, `COP`, `USD`…). Un único separador es ambiguo, así que se resuelve así: una sola coma es decimal
 * (`1,5` → 1.5); un punto seguido de exactamente tres dígitos tras 1–3 dígitos iniciales es de miles
 * (`150.000` → 150000), y en cualquier otro caso es decimal (`1234.5`, `0.125`). Devuelve null si no es un monto.
 */
export function parseAmount(raw: string): number | null {
  let text = raw.replace(/[\s ]/g, '').replace(/cop|usd|eur|mxn|[$€£]/gi, '')
  let negative = false
  const wrapped = /^\((.*)\)$/.exec(text)
  if (wrapped?.[1] !== undefined) {
    negative = true
    text = wrapped[1]
  }
  if (text.startsWith('-')) {
    negative = !negative
    text = text.slice(1)
  } else if (text.startsWith('+')) {
    text = text.slice(1)
  }
  if (!/^[\d.,]+$/.test(text)) return null

  const count = (char: string): number => text.split(char).length - 1
  let normalized: string
  if (count('.') > 0 && count(',') > 0) {
    // Con ambos signos, el último es el decimal y el otro el de miles.
    const decimal = text.lastIndexOf(',') > text.lastIndexOf('.') ? ',' : '.'
    const thousands = decimal === ',' ? '.' : ','
    if (count(decimal) !== 1) return null
    const [intPart = '', fraction = ''] = text.split(decimal)
    const groups = new RegExp(`^\\d{1,3}(?:\\${thousands}\\d{3})+$`)
    if (!(groups.test(intPart) || /^\d+$/.test(intPart)) || !/^\d+$/.test(fraction)) return null
    normalized = `${intPart.split(thousands).join('')}.${fraction}`
  } else if (count(',') > 0) {
    if (count(',') === 1) normalized = text.replace(',', '.')
    else if (/^\d{1,3}(?:,\d{3})+$/.test(text)) normalized = text.split(',').join('')
    else return null
  } else if (count('.') > 1) {
    if (!/^\d{1,3}(?:\.\d{3})+$/.test(text)) return null
    normalized = text.split('.').join('')
  } else if (/^[1-9]\d{0,2}\.\d{3}$/.test(text)) {
    normalized = text.replace('.', '')
  } else {
    normalized = text
  }
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null
  const value = Number(normalized)
  if (!Number.isFinite(value)) return null
  return negative ? -value : value
}

const DIFFICULTY_ALIASES: ReadonlyMap<string, Difficulty> = new Map([
  ['facil', 'easy'],
  ['easy', 'easy'],
  ['baja', 'easy'],
  ['bajo', 'easy'],
  ['media', 'medium'],
  ['medio', 'medium'],
  ['medium', 'medium'],
  ['intermedia', 'medium'],
  ['dificil', 'hard'],
  ['hard', 'hard'],
  ['alta', 'hard'],
  ['alto', 'hard'],
])

/** «fácil / media / difícil» o «easy / medium / hard» (sin importar mayúsculas ni tildes). undefined si no se reconoce. */
export function parseDifficulty(raw: string): Difficulty | undefined {
  return DIFFICULTY_ALIASES.get(normalizeKey(raw))
}

const DIFFICULTY_LABEL_ES: Record<Difficulty, string> = { easy: 'fácil', medium: 'media', hard: 'difícil' }

// ─────────────────────────────── Tabla CSV ────────────────────────────────

interface TableRow {
  /** Número de fila del archivo (el encabezado es la 1). */
  row: number
  cells: string[]
}

interface Table {
  headers: string[]
  rows: TableRow[]
}

function readTable(text: string): { ok: true; table: Table } | ImportFailure {
  const source = text.replace(/^﻿/, '')
  if (source.trim() === '') return fail(['El archivo está vacío.'])
  const parsed = Papa.parse<string[]>(source, { skipEmptyLines: false, delimitersToGuess: [',', ';', '\t', '|'] })
  const errors: string[] = []
  for (const error of parsed.errors) {
    if (error.type === 'Quotes') errors.push(`Fila ${(error.row ?? 0) + 1}: comillas sin cerrar o mal escapadas.`)
  }
  if (errors.length > 0) return fail(errors)

  const isBlank = (cells: readonly string[]): boolean => cells.every((cell) => cell.trim() === '')
  const headerIndex = parsed.data.findIndex((cells) => !isBlank(cells))
  if (headerIndex === -1) return fail(['El archivo está vacío.'])
  const headers = (parsed.data[headerIndex] ?? []).map((cell) => cell.trim())
  const rows: TableRow[] = []
  for (let i = headerIndex + 1; i < parsed.data.length; i++) {
    const cells = parsed.data[i] ?? []
    if (isBlank(cells)) continue
    rows.push({ row: i + 1, cells })
  }
  const extra = rows.filter(({ cells }) => cells.slice(headers.length).some((cell) => cell.trim() !== ''))
  if (extra.length > 0) {
    return fail(
      extra.map(
        ({ row, cells }) => `Fila ${row}: tiene ${cells.length} columnas y el encabezado solo ${headers.length} (¿falta cerrar unas comillas?).`,
      ),
    )
  }
  return { ok: true, table: { headers, rows } }
}

interface ColumnMap<F extends string> {
  index: Partial<Record<F, number>>
  warnings: string[]
}

function mapColumns<F extends string>(headers: readonly string[], aliases: Record<F, readonly string[]>): ColumnMap<F> {
  const lookup = new Map<string, F>()
  for (const field of Object.keys(aliases) as F[]) {
    for (const alias of aliases[field]) lookup.set(alias, field)
  }
  const index: Partial<Record<F, number>> = {}
  const warnings: string[] = []
  headers.forEach((header, position) => {
    if (header === '') return
    const field = lookup.get(normalizeKey(header))
    if (field === undefined) warnings.push(`Se ignoró la columna «${header}» (no es un campo conocido).`)
    else if (index[field] !== undefined) warnings.push(`Se ignoró la columna repetida «${header}».`)
    else index[field] = position
  })
  return { index, warnings }
}

function missingColumnErrors<F extends string>(
  index: Partial<Record<F, number>>,
  required: readonly F[],
  aliases: Record<F, readonly string[]>,
  label: Record<F, string>,
): string[] {
  return required
    .filter((field) => index[field] === undefined)
    .map((field) => `Falta la columna obligatoria «${label[field]}» (también se acepta: ${aliases[field].join(', ')}).`)
}

/** Texto de una celda: recortado, sin el apóstrofo que `itemsToCsv` antepone a las fórmulas. */
function cellText(cells: readonly string[], position: number | undefined): string {
  if (position === undefined) return ''
  return (cells[position] ?? '').trim().replace(/^'(?=[=+@])/, '')
}

// ─────────────────────────────── CSV de conceptos ────────────────────────────────

type ItemField = 'id' | 'concept' | 'expected' | 'supplier' | 'amount' | 'currency' | 'notes' | 'difficulty' | 'rationale'

const ITEM_ALIASES: Record<ItemField, readonly string[]> = {
  id: ['id', 'identificador', 'item'],
  concept: ['concepto', 'concept', 'descripcion', 'description', 'detalle', 'linea'],
  expected: [
    'esperado',
    'expected',
    'cuenta',
    'codigo',
    'categoria',
    'category',
    'subcuenta',
    'puc',
    'codigo puc',
    'cuenta puc',
    'cuenta esperada',
    'categoria esperada',
    'respuesta',
  ],
  supplier: ['proveedor', 'supplier', 'vendor'],
  amount: ['valor', 'amount', 'monto', 'importe'],
  currency: ['moneda', 'currency'],
  notes: ['notas', 'notes', 'nota', 'observaciones'],
  difficulty: ['dificultad', 'difficulty', 'nivel'],
  rationale: ['justificacion', 'rationale', 'razon', 'explicacion'],
}

/** Nombre en español de cada campo, para mensajes de error. */
const ITEM_LABELS: Record<ItemField, string> = {
  id: 'id',
  concept: 'concepto',
  expected: 'esperado',
  supplier: 'proveedor',
  amount: 'valor',
  currency: 'moneda',
  notes: 'notas',
  difficulty: 'dificultad',
  rationale: 'justificacion',
}

/** `Fila 5.concept: …` (mensaje de validateLabeledConcept) → `Fila 5, «concepto»: …`. */
function localizeItemError(message: string): string {
  const match = /^Fila (\d+)\.(\w+): ([\s\S]*)$/.exec(message)
  if (match === null) return message
  const label = ITEM_LABELS[match[2] as ItemField] ?? match[2]
  return `Fila ${match[1]}, «${label}»: ${match[3]}`
}

function categoryResolver(categories: readonly Category[]): (value: string) => string | undefined {
  const byId = new Set(categories.map((c) => c.id))
  const byLowerId = new Map(categories.map((c) => [c.id.toLowerCase(), c.id]))
  const nameCounts = new Map<string, string[]>()
  for (const category of categories) {
    const key = normalizeKey(category.name)
    nameCounts.set(key, [...(nameCounts.get(key) ?? []), category.id])
  }
  return (value) => {
    if (byId.has(value)) return value
    const lower = byLowerId.get(value.toLowerCase())
    if (lower !== undefined) return lower
    const byName = nameCounts.get(normalizeKey(value))
    return byName?.length === 1 ? byName[0] : undefined
  }
}

interface ItemDraft {
  row: number
  raw: Record<string, unknown>
}

/**
 * Importa conceptos etiquetados desde CSV. `expected` debe ser el id de una de `categories` (se tolera otra
 * capitalización o el nombre exacto de la categoría). Sin columna `id`, o con la celda vacía, se genera
 * `item-001`, `item-002`… Todo o nada: si alguna fila falla, se devuelven los errores de todas las filas.
 */
export function parseItemsCsv(text: string, categories: readonly Category[]): ItemsImport {
  if (categories.length === 0) return fail(['Define primero las categorías: no hay contra qué validar la columna «esperado».'])
  const table = readTable(text)
  if (!table.ok) return table
  const { index, warnings } = mapColumns(table.table.headers, ITEM_ALIASES)
  const missing = missingColumnErrors(index, ['concept', 'expected'], ITEM_ALIASES, ITEM_LABELS)
  if (missing.length > 0) return fail(missing)
  if (table.table.rows.length === 0) return fail(['El archivo no tiene filas con datos (solo el encabezado).'])
  if (table.table.rows.length > LIMITS.maxItems) {
    return fail([`El archivo tiene ${table.table.rows.length} filas; el máximo es ${LIMITS.maxItems} conceptos.`])
  }

  const resolve = categoryResolver(categories)
  const categoryIds = categories.map((c) => c.id)
  const validIds = categoryIds.length > 6 ? `${categoryIds.slice(0, 6).join(', ')}…` : categoryIds.join(', ')
  const errors: string[] = []
  const drafts: ItemDraft[] = []
  const rowOfId = new Map<string, number>()

  for (const { row, cells } of table.table.rows) {
    const get = (field: ItemField): string => cellText(cells, index[field])
    const raw: Record<string, unknown> = {}
    let valid = true
    const reject = (message: string): void => {
      errors.push(`Fila ${row}: ${message}`)
      valid = false
    }

    const id = get('id')
    if (id !== '') {
      const first = rowOfId.get(id)
      if (first !== undefined) reject(`el id «${id}» está repetido (ya se usó en la fila ${first}).`)
      else rowOfId.set(id, row)
      raw.id = id
    }

    const concept = get('concept')
    if (concept === '') reject('«concepto» está vacío.')
    raw.concept = concept

    const expectedText = get('expected')
    if (expectedText === '') {
      reject('«esperado» está vacío.')
    } else {
      const expected = resolve(expectedText)
      if (expected === undefined) reject(`«esperado» «${expectedText}» no coincide con ninguna categoría (ids válidos: ${validIds}).`)
      else raw.expected = expected
    }

    const supplier = get('supplier')
    if (supplier !== '') raw.supplier = supplier
    const amountText = get('amount')
    if (amountText !== '') {
      const amount = parseAmount(amountText)
      if (amount === null) reject(`«valor» «${amountText}» no es un monto válido (usa 1234567,89 o 1.234.567,89).`)
      else raw.amount = amount
    }
    const currency = get('currency')
    if (currency !== '') raw.currency = currency.toUpperCase()
    const notes = get('notes')
    if (notes !== '') raw.notes = notes
    const difficultyText = get('difficulty')
    if (difficultyText !== '') {
      const difficulty = parseDifficulty(difficultyText)
      if (difficulty === undefined) reject(`«dificultad» «${difficultyText}» no es válida (usa fácil, media o difícil; o easy, medium, hard).`)
      else raw.difficulty = difficulty
    }
    const rationale = get('rationale')
    if (rationale !== '') raw.rationale = rationale

    if (valid) drafts.push({ row, raw })
  }

  // Ids generados: item-001… sin chocar con los explícitos.
  let counter = 0
  const items: LabeledConcept[] = []
  for (const { row, raw } of drafts) {
    if (raw.id === undefined) {
      let candidate: string
      do {
        counter++
        candidate = `item-${String(counter).padStart(3, '0')}`
      } while (rowOfId.has(candidate))
      rowOfId.set(candidate, row)
      raw.id = candidate
    }
    const result = validateLabeledConcept(raw, categoryIds, `Fila ${row}`)
    if (result.ok) items.push(result.value)
    else errors.push(...result.errors.map(localizeItemError))
  }

  if (errors.length > 0) return fail(errors)
  return { ok: true, items, warnings }
}

// ─────────────────────────────── CSV de categorías ────────────────────────────────

type CategoryField = 'id' | 'name' | 'description' | 'group'

const CATEGORY_ALIASES: Record<CategoryField, readonly string[]> = {
  id: ['id', 'codigo', 'code', 'cuenta'],
  name: ['nombre', 'name'],
  description: ['descripcion', 'description', 'criterio'],
  group: ['grupo', 'group'],
}

const CATEGORY_LABELS: Record<CategoryField, string> = {
  id: 'id',
  name: 'nombre',
  description: 'descripcion',
  group: 'grupo',
}

/**
 * Importa categorías desde CSV (`id|codigo`, `nombre|name`, `descripcion|description`, `grupo|group`).
 * Los ids siguen `CATEGORY_ID_PATTERN` y son únicos (sin distinguir mayúsculas).
 */
export function parseCategoriesCsv(text: string): CategoriesImport {
  const table = readTable(text)
  if (!table.ok) return table
  const { index, warnings } = mapColumns(table.table.headers, CATEGORY_ALIASES)
  const missing = missingColumnErrors(index, ['id', 'name'], CATEGORY_ALIASES, CATEGORY_LABELS)
  if (missing.length > 0) return fail(missing)
  if (table.table.rows.length === 0) return fail(['El archivo no tiene filas con datos (solo el encabezado).'])

  const errors: string[] = []
  const rows: number[] = []
  const candidates: Record<string, unknown>[] = []
  for (const { row, cells } of table.table.rows) {
    const get = (field: CategoryField): string => cellText(cells, index[field])
    const id = get('id')
    const name = get('name')
    if (id === '') errors.push(`Fila ${row}: «id» está vacío.`)
    else if (!CATEGORY_ID_PATTERN.test(id)) {
      errors.push(`Fila ${row}: «id» «${id.slice(0, 40)}» no es válido (solo letras, números, "_", "." y "-").`)
    }
    if (name === '') errors.push(`Fila ${row}: «nombre» está vacío.`)
    const candidate: Record<string, unknown> = { id, name, description: get('description') }
    const group = get('group')
    if (group !== '') candidate.group = group
    candidates.push(candidate)
    rows.push(row)
  }
  if (errors.length > 0) return fail(errors)

  // Red de seguridad: la misma validación que usa la tarea (duplicados, longitudes, mínimo de categorías).
  const result = validateTask({ instructions: '-', question: '-', categories: candidates }, 'task')
  if (!result.ok) {
    return fail(
      result.errors.map((message) => {
        const row = /^task\.categories\[(\d+)\]\.(\w+): ([\s\S]*)$/.exec(message)
        if (row === null) return message.replace(/^task\.categories: /, 'Categorías: ')
        const label = CATEGORY_LABELS[row[2] as CategoryField] ?? row[2]
        const detail = (row[3] ?? '').replace(/task\.categories\[(\d+)\]\.id/g, (_, i: string) => `la fila ${rows[Number(i)] ?? '?'}`)
        return `Fila ${rows[Number(row[1])] ?? '?'}, «${label}»: ${detail}`
      }),
    )
  }
  return { ok: true, categories: result.value.categories, warnings }
}

// ─────────────────────────────── JSON ────────────────────────────────

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false
  return typeof value !== 'string' || value.trim() !== ''
}

/**
 * Importa un `Dataset` desde JSON (el formato de `datasetToJson`). Tolerancias: sin `id` se genera uno
 * (`custom-…`); un id igual al de un dataset semilla recibe el sufijo `-copia`; sin `name` se usa un
 * nombre genérico; sin `task.instructions` / `task.question` se usan los textos por defecto; los items sin
 * `id` reciben `item-001`, `item-002`… Siempre queda `source: 'custom'`.
 */
export function parseDatasetJson(text: string): DatasetImport {
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^﻿/, ''))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return fail([`El archivo no es un JSON válido: ${reason}`])
  }
  if (!isRecord(data)) return fail(['El JSON debe ser un objeto con los campos «task» e «items» (usa la plantilla exportada).'])

  let task: unknown = data.task
  if (isRecord(task)) {
    task = {
      ...task,
      instructions: hasValue(task.instructions) ? task.instructions : DEFAULT_TASK_INSTRUCTIONS,
      question: hasValue(task.question) ? task.question : DEFAULT_TASK_QUESTION,
    }
  }

  let items: unknown = data.items
  if (Array.isArray(items)) {
    const used = new Set<string>()
    for (const item of items as unknown[]) {
      if (isRecord(item) && hasValue(item.id)) used.add(String(item.id).trim())
    }
    let counter = 0
    items = (items as unknown[]).map((item) => {
      if (!isRecord(item) || hasValue(item.id)) return item
      let candidate: string
      do {
        counter++
        candidate = `item-${String(counter).padStart(3, '0')}`
      } while (used.has(candidate))
      used.add(candidate)
      return { ...item, id: candidate }
    })
  }

  let id = hasValue(data.id) ? String(data.id).trim() : `custom-${Date.now().toString(36)}`
  if (SEED_DATASETS.some((seed) => seed.id === id)) id = `${id}-copia`

  const result = validateDataset({
    id,
    name: hasValue(data.name) ? data.name : 'Dataset importado',
    description: data.description,
    locale: data.locale,
    source: 'custom',
    task,
    items,
  })
  if (!result.ok) return fail(result.errors)
  return { ok: true, dataset: result.value }
}

/** Serializa un dataset a JSON legible (el formato que acepta `parseDatasetJson`). */
export function datasetToJson(dataset: Dataset): string {
  return JSON.stringify(dataset, null, 2)
}

// ─────────────────────────────── Exportación CSV ────────────────────────────────

export interface CsvExportOptions {
  /** Separador de columnas (por defecto «,»; usa «;» para Excel en español). */
  delimiter?: string
}

function unparse(fields: string[], data: string[][], options: CsvExportOptions | undefined): string {
  return Papa.unparse(
    { fields, data },
    { delimiter: options?.delimiter ?? ',', newline: '\n', escapeFormulae: /^[=+@\t\r]/ },
  )
}

/** Monto en formato simple; con coma decimal si el punto sería ambiguo con un separador de miles. */
function formatAmount(amount: number): string {
  const text = String(amount)
  return /^-?[1-9]\d{0,2}\.\d{3}$/.test(text) ? text.replace('.', ',') : text
}

/** Plantilla/exportación CSV de conceptos (encabezados en español; `parseItemsCsv` la lee de vuelta). */
export function itemsToCsv(items: readonly LabeledConcept[], options?: CsvExportOptions): string {
  const fields = ['id', 'concepto', 'proveedor', 'valor', 'moneda', 'notas', 'esperado', 'dificultad', 'justificacion']
  const data = items.map((item) => [
    item.id,
    item.concept,
    item.supplier ?? '',
    item.amount === undefined ? '' : formatAmount(item.amount),
    item.currency ?? '',
    item.notes ?? '',
    item.expected,
    item.difficulty === undefined ? '' : DIFFICULTY_LABEL_ES[item.difficulty],
    item.rationale ?? '',
  ])
  return unparse(fields, data, options)
}

/** Plantilla/exportación CSV de categorías (`parseCategoriesCsv` la lee de vuelta). */
export function categoriesToCsv(categories: readonly Category[], options?: CsvExportOptions): string {
  const data = categories.map((c) => [c.id, c.name, c.description, c.group ?? ''])
  return unparse(['id', 'nombre', 'descripcion', 'grupo'], data, options)
}
