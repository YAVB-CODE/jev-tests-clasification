/**
 * Jev Classify Lab — texto canónico de la tarea y validación de entradas.
 *
 * ── Regla de equidad ─────────────────────────────────────────────────────────────────────────
 * GPT y Jev reciben EXACTAMENTE la misma información; solo cambia el empaque nativo de cada API.
 * Ambos adaptadores (server/adapters/gpt.ts y jev.ts) arman su request únicamente a partir de
 * `buildCanonicalPrompt(task, item)`:
 *  - Mismo texto: `instructions`, `question`, `context` y el criterio de cada categoría
 *    (`criteria`, id → texto) salen de aquí, verbatim, para los dos.
 *  - Mismo item: el concepto se serializa una sola vez con `serializeConcept` (orden de claves
 *    estable, sin `id`, sin etiqueta). Ese objeto es todo lo que los modelos ven del item.
 *  - Sin etiqueta: `expected`, `difficulty` y `rationale` nunca llegan a un modelo ni al
 *    servidor. `validateConceptInput` descarta cualquier campo desconocido (incluido `expected`).
 *
 * Empaque (mismo `state` para ambos):
 *  - Jev: `state = prompt.state`; una pregunta `choice` con
 *    `instructions: { question: prompt.question, context: prompt.context }` y `criteria: prompt.criteria`.
 *  - GPT: mensaje de usuario = `JSON.stringify(prompt.state)`; system/developer = `prompt.question`,
 *    `prompt.context`, las opciones (`- "<id>": prompt.criteria[id]`) y una frase corta de formato de
 *    salida; el JSON schema usa esos mismos ids como enum.
 *  - Ambos interpretan la respuesta con `matchCategoryId` contra `prompt.categoryIds` (coincidencia
 *    exacta, sin normalizar).
 *
 * Orden de las opciones = `Object.keys(prompt.criteria)` para AMBOS motores. JS/JSON ordena las claves
 * con forma de entero (p. ej. códigos PUC "513530") de menor a mayor antes que las demás, así que ese
 * orden puede diferir del de la tarea; pero es el orden en que `criteria` viaja a Jev, y el adaptador de
 * GPT lista sus opciones y su enum igual (`gptOptionIds`, server/adapters/gpt.ts). `prompt.categoryIds`
 * (orden de la tarea) es el conjunto válido de respuestas, no el orden en que se muestran.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
import {
  isDifficulty,
  type Category,
  type ClassificationTask,
  type ConceptInput,
  type Dataset,
  type DatasetSource,
  type LabeledConcept,
} from './contracts.ts'

// ─────────────────────────────── Límites ────────────────────────────────

export const LIMITS = {
  minCategories: 2,
  maxCategories: 80,
  /** Longitud máxima de `Category.id`. */
  idLength: 40,
  /** Longitud máxima de `ConceptInput.id`. */
  itemIdLength: 80,
  /** Longitud máxima de `Dataset.id`. */
  datasetIdLength: 80,
  /** Nombres y grupos de categoría, nombre de dataset. */
  nameLength: 200,
  /** Textos largos: instrucciones, pregunta, descripción de categoría, notas, rationale. */
  textLength: 2000,
  /** `ConceptInput.concept`. */
  conceptLength: 500,
  supplierLength: 200,
  currencyLength: 10,
  localeLength: 20,
  /** |amount| máximo aceptado. */
  maxAbsAmount: 1e15,
  /** Items por dataset. */
  maxItems: 2000,
  /** Errores de validación devueltos como máximo (el resto se resume en una línea). */
  maxErrors: 25,
} as const

/** Ids de categoría: letras ASCII, dígitos, `_`, `.` y `-`; no vacío. */
export const CATEGORY_ID_PATTERN = /^[A-Za-z0-9_.-]+$/

/** Ids que romperían objetos JS planos usados como mapas (criteria, probabilities). */
const RESERVED_IDS: ReadonlySet<string> = new Set(['__proto__'])

// ─────────────────────────────── Texto canónico ────────────────────────────────

/** Nombres de los campos de `state` con los que ambos motores se refieren a la tarea y al item. */
export const STATE_KEYS = { task: 'task', item: 'invoice_line' } as const

/** Campos de un concepto que ven los modelos, en el orden estable de serialización. */
export const CONCEPT_FIELDS = ['concept', 'supplier', 'amount', 'currency', 'notes'] as const
export type ConceptField = (typeof CONCEPT_FIELDS)[number]

/** Instrucciones por defecto (para datasets importados que no traen las suyas). */
export const DEFAULT_TASK_INSTRUCTIONS =
  'Clasifica una línea (concepto) de una factura de compra recibida por una empresa en Colombia en la ' +
  'subcuenta del Plan Único de Cuentas (PUC, Decreto 2650 de 1993) donde debe registrarse. Decide por la ' +
  'naturaleza del bien o servicio adquirido y su uso en la empresa; el proveedor, el valor, la moneda y las ' +
  'notas, cuando aparecen, son contexto adicional. Elige exactamente una de las categorías ofrecidas, ' +
  'aplicando su criterio.'

/** Pregunta por defecto. */
export const DEFAULT_TASK_QUESTION = '¿En qué subcuenta del PUC se registra esta línea de factura de compra?'

/**
 * Frase que indica dónde está cada cosa en `state`. Igual para ambos motores; no añade
 * información de la tarea, solo nombra los campos.
 */
export const CANONICAL_CONTEXT =
  `La tarea está en \`${STATE_KEYS.task}\`; la línea de factura a clasificar está en \`${STATE_KEYS.item}\`: ` +
  '`concept` es su descripción y, si aparecen, `supplier` es el proveedor, `amount` el valor, ' +
  '`currency` la moneda y `notes` notas adicionales.'

/** Lo que ambos motores ven de un item. Claves en el orden de `CONCEPT_FIELDS`. */
export interface SerializedConcept {
  concept: string
  supplier?: string
  amount?: number
  currency?: string
  notes?: string
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

/**
 * Serializa un concepto para los modelos: claves en orden estable (`concept`, `supplier`, `amount`,
 * `currency`, `notes`), sin `id` ni campos de etiqueta, textos recortados y vacíos/undefined
 * omitidos (`amount` solo si es un número finito). Lista blanca: cualquier otro campo se ignora.
 */
export function serializeConcept(item: ConceptInput): SerializedConcept {
  const out: SerializedConcept = { concept: cleanText(item.concept) ?? '' }
  const supplier = cleanText(item.supplier)
  if (supplier !== undefined) out.supplier = supplier
  if (typeof item.amount === 'number' && Number.isFinite(item.amount)) out.amount = item.amount
  const currency = cleanText(item.currency)
  if (currency !== undefined) out.currency = currency
  const notes = cleanText(item.notes)
  if (notes !== undefined) out.notes = notes
  return out
}

/**
 * Texto del criterio de una categoría (mismo para ambos motores):
 * `"<nombre> (grupo: <grupo>): <descripción>"`; sin grupo o sin descripción se omite esa parte.
 */
export function criterionText(c: Category): string {
  const name = c.name.trim()
  const group = cleanText(c.group)
  const description = cleanText(c.description)
  let text = group !== undefined ? `${name} (grupo: ${group})` : name
  if (description !== undefined) text += `: ${description}`
  return text
}

/** id → texto del criterio. Sus claves (`Object.keys`) dan el orden en que ambos motores ven las opciones (ver cabecera). */
export function buildCriteria(categories: readonly Category[]): Record<string, string> {
  return Object.fromEntries(categories.map((c) => [c.id, criterionText(c)]))
}

/** `state` compartido: la tarea y el item bajo los nombres de `STATE_KEYS`. */
export type CanonicalState = Record<typeof STATE_KEYS.task, string> & Record<typeof STATE_KEYS.item, SerializedConcept>

/** Todo lo que un adaptador necesita para armar su request. Mismo objeto para GPT y Jev. */
export interface CanonicalPrompt {
  /** `task.instructions` recortado (también va dentro de `state`). */
  instructions: string
  /** `task.question` recortado. */
  question: string
  /** `CANONICAL_CONTEXT`. */
  context: string
  /** id → criterio (`criterionText`). */
  criteria: Record<string, string>
  /** El item serializado (`serializeConcept`). También va dentro de `state`. */
  item: SerializedConcept
  /** Ids de categoría en el orden de la tarea: el conjunto válido de respuestas (no el orden mostrado; ver cabecera). */
  categoryIds: string[]
  /** `{ task: instructions, invoice_line: item }`. */
  state: CanonicalState
}

/**
 * Construye el prompt canónico. Asume datos ya validados (`validateTask` / `validateConceptInput`).
 * Acepta un `LabeledConcept` sin riesgo: la serialización es por lista blanca y la etiqueta no pasa.
 */
export function buildCanonicalPrompt(task: ClassificationTask, item: ConceptInput): CanonicalPrompt {
  const instructions = task.instructions.trim()
  const serialized = serializeConcept(item)
  return {
    instructions,
    question: task.question.trim(),
    context: CANONICAL_CONTEXT,
    criteria: buildCriteria(task.categories),
    item: serialized,
    categoryIds: task.categories.map((c) => c.id),
    state: { [STATE_KEYS.task]: instructions, [STATE_KEYS.item]: serialized },
  }
}

/**
 * Interpreta la respuesta de un modelo: devuelve el id si coincide EXACTAMENTE con uno de
 * `categoryIds`, si no null. Sin trim ni mayúsculas: responder fuera del conjunto es una respuesta
 * inválida, y eso se mide. Ambos adaptadores deben usar esta misma regla.
 */
export function matchCategoryId(value: unknown, categoryIds: readonly string[]): string | null {
  return typeof value === 'string' && categoryIds.includes(value) ? value : null
}

/** Quita la etiqueta y todo lo que no sea parte de `ConceptInput` (lista blanca). */
export function toConceptInput(item: LabeledConcept): ConceptInput {
  const out: ConceptInput = { id: item.id, concept: item.concept }
  if (item.supplier !== undefined) out.supplier = item.supplier
  if (item.amount !== undefined) out.amount = item.amount
  if (item.currency !== undefined) out.currency = item.currency
  if (item.notes !== undefined) out.notes = item.notes
  return out
}

// ─────────────────────────────── Validación ────────────────────────────────
// Para input no confiable (body de la API, archivos importados, localStorage). Devuelve un valor
// NUEVO y normalizado (textos recortados, opcionales vacíos omitidos, ids numéricos → texto) que
// contiene solo los campos conocidos: todo lo demás se descarta. Mensajes en español con la ruta
// del campo, p. ej. "task.categories[3].id: duplicado (igual que task.categories[1].id)".

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] }

type Source = Record<string, unknown>

function isRecord(value: unknown): value is Source {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail<T>(errors: string[]): ValidationResult<T> {
  if (errors.length <= LIMITS.maxErrors) return { ok: false, errors }
  const rest = errors.length - LIMITS.maxErrors
  return { ok: false, errors: [...errors.slice(0, LIMITS.maxErrors), `… y ${rest} errores más`] }
}

/**
 * Lee un texto. undefined / null → ausente. Recorta; vacío cuenta como ausente.
 * Si es requerido y falta, o si es inválido, agrega un error y devuelve undefined.
 */
function readText(source: Source, key: string, path: string, max: number, required: boolean, errors: string[]): string | undefined {
  const at = `${path}.${key}`
  const raw = source[key]
  if (raw === undefined || raw === null) {
    if (required) errors.push(`${at}: requerido`)
    return undefined
  }
  if (typeof raw !== 'string') {
    errors.push(`${at}: debe ser texto`)
    return undefined
  }
  const text = raw.trim()
  if (text === '') {
    if (required) errors.push(`${at}: no puede estar vacío`)
    return undefined
  }
  if (text.length > max) {
    errors.push(`${at}: máximo ${max} caracteres (tiene ${text.length})`)
    return undefined
  }
  return text
}

/** Como `readText` (requerido) pero acepta enteros no negativos y los convierte a texto (ids). */
function readId(source: Source, key: string, path: string, max: number, errors: string[]): string | undefined {
  const raw = source[key]
  if (typeof raw === 'number') {
    if (Number.isSafeInteger(raw) && raw >= 0) return readText({ [key]: String(raw) }, key, path, max, true, errors)
    errors.push(`${path}.${key}: debe ser texto`)
    return undefined
  }
  return readText(source, key, path, max, true, errors)
}

function readCategoryId(source: Source, key: string, path: string, errors: string[]): string | undefined {
  const id = readId(source, key, path, LIMITS.idLength, errors)
  if (id === undefined) return undefined
  if (!CATEGORY_ID_PATTERN.test(id)) {
    errors.push(`${path}.${key}: formato inválido "${id.slice(0, 40)}" (solo letras, números, "_", "." y "-")`)
    return undefined
  }
  if (RESERVED_IDS.has(id)) {
    errors.push(`${path}.${key}: valor reservado`)
    return undefined
  }
  return id
}

function readAmount(source: Source, path: string, errors: string[]): number | undefined {
  const raw = source.amount
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    errors.push(`${path}.amount: debe ser un número finito`)
    return undefined
  }
  if (Math.abs(raw) > LIMITS.maxAbsAmount) {
    errors.push(`${path}.amount: fuera de rango (|valor| ≤ ${LIMITS.maxAbsAmount})`)
    return undefined
  }
  return raw
}

function readCategories(raw: unknown, path: string, errors: string[]): Category[] | undefined {
  if (raw === undefined || raw === null) {
    errors.push(`${path}: requerido`)
    return undefined
  }
  if (!Array.isArray(raw)) {
    errors.push(`${path}: debe ser una lista`)
    return undefined
  }
  if (raw.length > LIMITS.maxCategories) {
    errors.push(`${path}: máximo ${LIMITS.maxCategories} categorías (tiene ${raw.length})`)
    return undefined
  }
  if (raw.length < LIMITS.minCategories) {
    errors.push(`${path}: mínimo ${LIMITS.minCategories} categorías (tiene ${raw.length})`)
  }
  const firstIndexById = new Map<string, number>() // id en minúsculas → índice
  const out: Category[] = []
  for (let i = 0; i < raw.length; i++) {
    const at = `${path}[${i}]`
    const entry: unknown = raw[i]
    if (!isRecord(entry)) {
      errors.push(`${at}: debe ser un objeto`)
      continue
    }
    const id = readCategoryId(entry, 'id', at, errors)
    if (id !== undefined) {
      const first = firstIndexById.get(id.toLowerCase())
      if (first !== undefined) errors.push(`${at}.id: duplicado (igual que ${path}[${first}].id)`)
      else firstIndexById.set(id.toLowerCase(), i)
    }
    const name = readText(entry, 'name', at, LIMITS.nameLength, true, errors)
    const description = readText(entry, 'description', at, LIMITS.textLength, false, errors) ?? ''
    const group = readText(entry, 'group', at, LIMITS.nameLength, false, errors)
    if (id === undefined || name === undefined) continue
    const category: Category = { id, name, description }
    if (group !== undefined) category.group = group
    out.push(category)
  }
  return out
}

/**
 * Valida una `ClassificationTask` no confiable: instrucciones y pregunta no vacías, entre
 * `LIMITS.minCategories` y `LIMITS.maxCategories` categorías, ids con `CATEGORY_ID_PATTERN` y únicos
 * (sin distinguir mayúsculas), nombre requerido. Descarta campos desconocidos.
 */
export function validateTask(value: unknown, path = 'task'): ValidationResult<ClassificationTask> {
  if (!isRecord(value)) return fail([`${path}: debe ser un objeto`])
  const errors: string[] = []
  const instructions = readText(value, 'instructions', path, LIMITS.textLength, true, errors)
  const question = readText(value, 'question', path, LIMITS.textLength, true, errors)
  const categories = readCategories(value.categories, `${path}.categories`, errors)
  if (errors.length > 0 || instructions === undefined || question === undefined || categories === undefined) {
    return fail(errors)
  }
  return { ok: true, value: { instructions, question, categories } }
}

function readConcept(value: unknown, path: string, errors: string[]): ConceptInput | undefined {
  if (!isRecord(value)) {
    errors.push(`${path}: debe ser un objeto`)
    return undefined
  }
  const id = readId(value, 'id', path, LIMITS.itemIdLength, errors)
  const concept = readText(value, 'concept', path, LIMITS.conceptLength, true, errors)
  const supplier = readText(value, 'supplier', path, LIMITS.supplierLength, false, errors)
  const amount = readAmount(value, path, errors)
  const currency = readText(value, 'currency', path, LIMITS.currencyLength, false, errors)
  const notes = readText(value, 'notes', path, LIMITS.textLength, false, errors)
  if (id === undefined || concept === undefined) return undefined
  const item: ConceptInput = { id, concept }
  if (supplier !== undefined) item.supplier = supplier
  if (amount !== undefined) item.amount = amount
  if (currency !== undefined) item.currency = currency
  if (notes !== undefined) item.notes = notes
  return item
}

/**
 * Valida un `ConceptInput` no confiable (`id` y `concept` requeridos; `supplier`, `amount`,
 * `currency`, `notes` opcionales). Descarta todo lo demás — en particular `expected`, `difficulty`
 * y `rationale`, para que el servidor jamás vea la etiqueta.
 */
export function validateConceptInput(value: unknown, path = 'item'): ValidationResult<ConceptInput> {
  const errors: string[] = []
  const item = readConcept(value, path, errors)
  if (errors.length > 0 || item === undefined) return fail(errors)
  return { ok: true, value: item }
}

function readLabeled(
  value: unknown,
  categoryIds: readonly string[] | undefined,
  path: string,
  errors: string[],
): LabeledConcept | undefined {
  const base = readConcept(value, path, errors)
  if (!isRecord(value)) return undefined
  const expected = readCategoryId(value, 'expected', path, errors)
  if (expected !== undefined && categoryIds !== undefined && !categoryIds.includes(expected)) {
    errors.push(`${path}.expected: "${expected}" no es una categoría de la tarea`)
  }
  let difficulty: LabeledConcept['difficulty']
  const rawDifficulty = value.difficulty
  if (rawDifficulty !== undefined && rawDifficulty !== null && rawDifficulty !== '') {
    const normalized = typeof rawDifficulty === 'string' ? rawDifficulty.trim().toLowerCase() : rawDifficulty
    if (isDifficulty(normalized)) difficulty = normalized
    else errors.push(`${path}.difficulty: debe ser easy, medium o hard`)
  }
  const rationale = readText(value, 'rationale', path, LIMITS.textLength, false, errors)
  if (base === undefined || expected === undefined) return undefined
  const item: LabeledConcept = { ...base, expected }
  if (difficulty !== undefined) item.difficulty = difficulty
  if (rationale !== undefined) item.rationale = rationale
  return item
}

/**
 * Valida un `LabeledConcept` (para importadores y storage del cliente; el servidor usa
 * `validateConceptInput`). Si se pasan `categoryIds`, `expected` debe ser uno de ellos (exacto).
 */
export function validateLabeledConcept(
  value: unknown,
  categoryIds?: readonly string[],
  path = 'item',
): ValidationResult<LabeledConcept> {
  const errors: string[] = []
  const item = readLabeled(value, categoryIds, path, errors)
  if (errors.length > 0 || item === undefined) return fail(errors)
  return { ok: true, value: item }
}

const DATASET_SOURCES: readonly DatasetSource[] = ['seed', 'custom']

/**
 * Valida un `Dataset` completo: metadatos, tarea (`validateTask`), 1..`LIMITS.maxItems` items
 * (`validateLabeledConcept` contra las categorías de la tarea) e ids de item únicos.
 */
export function validateDataset(value: unknown, path = 'dataset'): ValidationResult<Dataset> {
  if (!isRecord(value)) return fail([`${path}: debe ser un objeto`])
  const errors: string[] = []
  const id = readId(value, 'id', path, LIMITS.datasetIdLength, errors)
  const name = readText(value, 'name', path, LIMITS.nameLength, true, errors)
  const description = readText(value, 'description', path, LIMITS.textLength, false, errors) ?? ''
  const locale = readText(value, 'locale', path, LIMITS.localeLength, false, errors)
  let source: DatasetSource | undefined
  if (value.source !== undefined && value.source !== null) {
    if (typeof value.source === 'string' && (DATASET_SOURCES as readonly string[]).includes(value.source)) {
      source = value.source as DatasetSource
    } else {
      errors.push(`${path}.source: debe ser seed o custom`)
    }
  }

  const taskResult = validateTask(value.task, `${path}.task`)
  if (!taskResult.ok) errors.push(...taskResult.errors)
  const categoryIds = taskResult.ok ? taskResult.value.categories.map((c) => c.id) : undefined

  const items: LabeledConcept[] = []
  const rawItems = value.items
  if (rawItems === undefined || rawItems === null) {
    errors.push(`${path}.items: requerido`)
  } else if (!Array.isArray(rawItems)) {
    errors.push(`${path}.items: debe ser una lista`)
  } else if (rawItems.length === 0) {
    errors.push(`${path}.items: debe tener al menos 1 concepto`)
  } else if (rawItems.length > LIMITS.maxItems) {
    errors.push(`${path}.items: máximo ${LIMITS.maxItems} conceptos (tiene ${rawItems.length})`)
  } else {
    const firstIndexById = new Map<string, number>()
    for (let i = 0; i < rawItems.length; i++) {
      const at = `${path}.items[${i}]`
      const item = readLabeled(rawItems[i], categoryIds, at, errors)
      if (item === undefined) continue
      const first = firstIndexById.get(item.id)
      if (first !== undefined) errors.push(`${at}.id: duplicado (igual que ${path}.items[${first}].id)`)
      else firstIndexById.set(item.id, i)
      items.push(item)
    }
  }

  if (errors.length > 0 || id === undefined || name === undefined || !taskResult.ok) return fail(errors)
  const dataset: Dataset = {
    id,
    name,
    description,
    ...(locale !== undefined ? { locale } : {}),
    ...(source !== undefined ? { source } : {}),
    task: taskResult.value,
    items,
  }
  return { ok: true, value: dataset }
}
