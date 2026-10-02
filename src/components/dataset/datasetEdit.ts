/**
 * Pure helpers to edit a custom dataset: unique ids, duplication, merging imported items and the
 * form-to-model builders for categories and items. The store re-validates everything on save
 * (`upsertCustomDataset`); these checks only give immediate, field-level feedback.
 */
import { isDifficulty, type Category, type Dataset, type Difficulty, type LabeledConcept } from '../../shared/contracts.ts'
import { CATEGORY_ID_PATTERN, LIMITS } from '../../shared/task.ts'
import { parseAmount } from '../../data/importDataset.ts'

export type BuildResult<T> = { ok: true; value: T } | { ok: false; errors: string[] }

// ─────────────────────────────── Ids ────────────────────────────────

/** `base`, else `base-2`, `base-3`… (trimmed so the result never exceeds `max` characters). */
export function uniqueId(base: string, taken: Iterable<string>, max: number = LIMITS.datasetIdLength): string {
  const used = new Set(taken)
  const root = base.slice(0, max)
  if (!used.has(root)) return root
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const candidate = `${root.slice(0, max - suffix.length)}${suffix}`
    if (!used.has(candidate)) return candidate
  }
}

/** URL-safe lowercase slug: "Mi dataset Nº 1" → "mi-dataset-n-1". */
export function slugify(text: string, max = 50): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
}

/**
 * Next free id that continues the dataset's own numbering ("puc-060" → "puc-061", same padding);
 * `item-001`, `item-002`… when no id ends in a number.
 */
export function nextItemId(items: readonly Pick<LabeledConcept, 'id'>[]): string {
  const used = new Set(items.map((item) => item.id))
  let prefix = 'item-'
  let width = 3
  let n = 0
  for (const id of used) {
    const match = /^(.*?)(\d{1,9})$/.exec(id)
    if (match?.[2] === undefined) continue
    const value = Number(match[2])
    if (value > n || (value === n && n === 0)) {
      prefix = match[1] ?? ''
      width = match[2].length
      n = value
    }
  }
  let candidate: string
  do {
    n++
    candidate = `${prefix}${String(n).padStart(width, '0')}`
  } while (used.has(candidate))
  return candidate.length <= LIMITS.itemIdLength ? candidate : uniqueId('item', used, LIMITS.itemIdLength)
}

// ─────────────────────────────── Dataset operations ────────────────────────────────

/** Deep copy as a custom dataset with a fresh id and a "(copia)" name. */
export function duplicateDataset(source: Dataset, takenIds: Iterable<string>): Dataset {
  const copy = structuredClone(source)
  const suffix = ' (copia)'
  return {
    ...copy,
    id: uniqueId(`${source.id}-copia`, takenIds),
    name: `${source.name.slice(0, LIMITS.nameLength - suffix.length)}${suffix}`,
    source: 'custom',
  }
}

export interface MergeResult {
  items: LabeledConcept[]
  /** Imported items whose id already existed and received a new `item-###` id. */
  renumbered: number
}

/** Appends `incoming` to `existing`, renumbering the incoming ids that collide. */
export function mergeItems(existing: readonly LabeledConcept[], incoming: readonly LabeledConcept[]): MergeResult {
  const existingIds = new Set(existing.map((item) => item.id))
  const used = new Set(existingIds)
  for (const item of incoming) if (!existingIds.has(item.id)) used.add(item.id)
  let counter = 0
  let renumbered = 0
  const merged = incoming.map((item) => {
    if (!existingIds.has(item.id)) return item
    let candidate: string
    do {
      counter++
      candidate = `item-${String(counter).padStart(3, '0')}`
    } while (used.has(candidate))
    used.add(candidate)
    renumbered++
    return { ...item, id: candidate }
  })
  return { items: [...existing, ...merged], renumbered }
}

/** Reason why a category cannot be removed, or null when it can. */
export function categoryRemovalBlocker(dataset: Pick<Dataset, 'task' | 'items'>, categoryId: string): string | null {
  const used = dataset.items.filter((item) => item.expected === categoryId).length
  if (used > 0) {
    return `${used} ${used === 1 ? 'concepto usa' : 'conceptos usan'} la categoría ${categoryId} como respuesta esperada: reasígnalos o elimínalos primero.`
  }
  if (dataset.task.categories.length <= LIMITS.minCategories) {
    return `Debe quedar al menos ${LIMITS.minCategories} categorías.`
  }
  return null
}

/** Adds a category or replaces `editingId`; a renamed id is propagated to the items' expected answers. */
export function applyCategory(dataset: Dataset, category: Category, editingId: string | null): Dataset {
  const categories = dataset.task.categories
  if (editingId === null) return { ...dataset, task: { ...dataset.task, categories: [...categories, category] } }
  return {
    ...dataset,
    task: { ...dataset.task, categories: categories.map((c) => (c.id === editingId ? category : c)) },
    items:
      editingId === category.id
        ? dataset.items
        : dataset.items.map((item) => (item.expected === editingId ? { ...item, expected: category.id } : item)),
  }
}

export function removeCategory(dataset: Dataset, categoryId: string): Dataset {
  return { ...dataset, task: { ...dataset.task, categories: dataset.task.categories.filter((c) => c.id !== categoryId) } }
}

/** Adds an item or replaces `editingId`. */
export function applyItem(dataset: Dataset, item: LabeledConcept, editingId: string | null): Dataset {
  const items = editingId === null ? [...dataset.items, item] : dataset.items.map((it) => (it.id === editingId ? item : it))
  return { ...dataset, items }
}

export function removeItem(dataset: Dataset, itemId: string): Dataset {
  return { ...dataset, items: dataset.items.filter((item) => item.id !== itemId) }
}

// ─────────────────────────────── Forms ────────────────────────────────

export interface CategoryFormValues {
  id: string
  name: string
  group: string
  description: string
}

export function emptyCategoryForm(): CategoryFormValues {
  return { id: '', name: '', group: '', description: '' }
}

export function categoryToForm(category: Category): CategoryFormValues {
  return { id: category.id, name: category.name, group: category.group ?? '', description: category.description }
}

/** Builds a category from the form; `editingId` is the id being edited (null = new). */
export function buildCategory(
  form: CategoryFormValues,
  categories: readonly Category[],
  editingId: string | null,
): BuildResult<Category> {
  const errors: string[] = []
  const id = form.id.trim()
  const name = form.name.trim()
  const group = form.group.trim()
  const description = form.description.trim()

  if (id === '') errors.push('El código es obligatorio.')
  else if (id.length > LIMITS.idLength) errors.push(`El código admite máximo ${LIMITS.idLength} caracteres.`)
  else if (!CATEGORY_ID_PATTERN.test(id)) errors.push('El código solo admite letras, números, «_», «.» y «-».')
  else if (id === '__proto__') errors.push('Ese código está reservado.')
  else if (categories.some((c) => c.id !== editingId && c.id.toLowerCase() === id.toLowerCase())) {
    errors.push(`Ya existe una categoría con el código ${id} (no se distingue entre mayúsculas y minúsculas).`)
  }
  if (name === '') errors.push('El nombre es obligatorio.')
  else if (name.length > LIMITS.nameLength) errors.push(`El nombre admite máximo ${LIMITS.nameLength} caracteres.`)
  if (group.length > LIMITS.nameLength) errors.push(`El grupo admite máximo ${LIMITS.nameLength} caracteres.`)
  if (description.length > LIMITS.textLength) errors.push(`El criterio admite máximo ${LIMITS.textLength} caracteres.`)
  if (errors.length > 0) return { ok: false, errors }

  const category: Category = { id, name, description }
  if (group !== '') category.group = group
  return { ok: true, value: category }
}

export interface ItemFormValues {
  id: string
  concept: string
  supplier: string
  /** Free text; accepts "1.234.567,89" or "1234567.89". */
  amount: string
  currency: string
  notes: string
  expected: string
  difficulty: Difficulty | ''
  rationale: string
}

export function emptyItemForm(items: readonly Pick<LabeledConcept, 'id'>[], expected = ''): ItemFormValues {
  return {
    id: nextItemId(items),
    concept: '',
    supplier: '',
    amount: '',
    currency: 'COP',
    notes: '',
    expected,
    difficulty: '',
    rationale: '',
  }
}

export function itemToForm(item: LabeledConcept): ItemFormValues {
  return {
    id: item.id,
    concept: item.concept,
    supplier: item.supplier ?? '',
    amount: item.amount === undefined ? '' : String(item.amount).replace('.', ','),
    currency: item.currency ?? '',
    notes: item.notes ?? '',
    expected: item.expected,
    difficulty: item.difficulty ?? '',
    rationale: item.rationale ?? '',
  }
}

/** Builds an item from the form; `editingId` is the id being edited (null = new). */
export function buildItem(
  form: ItemFormValues,
  items: readonly LabeledConcept[],
  categories: readonly Category[],
  editingId: string | null,
): BuildResult<LabeledConcept> {
  const errors: string[] = []
  const id = form.id.trim()
  const concept = form.concept.trim()
  const supplier = form.supplier.trim()
  const amountText = form.amount.trim()
  const currency = form.currency.trim().toUpperCase()
  const notes = form.notes.trim()
  const rationale = form.rationale.trim()

  if (id === '') errors.push('El id es obligatorio.')
  else if (id.length > LIMITS.itemIdLength) errors.push(`El id admite máximo ${LIMITS.itemIdLength} caracteres.`)
  else if (items.some((item) => item.id !== editingId && item.id === id)) errors.push(`Ya existe un concepto con el id ${id}.`)

  if (concept === '') errors.push('El concepto es obligatorio.')
  else if (concept.length > LIMITS.conceptLength) errors.push(`El concepto admite máximo ${LIMITS.conceptLength} caracteres.`)
  if (supplier.length > LIMITS.supplierLength) errors.push(`El proveedor admite máximo ${LIMITS.supplierLength} caracteres.`)
  if (currency.length > LIMITS.currencyLength) errors.push(`La moneda admite máximo ${LIMITS.currencyLength} caracteres.`)
  if (notes.length > LIMITS.textLength) errors.push(`Las notas admiten máximo ${LIMITS.textLength} caracteres.`)
  if (rationale.length > LIMITS.textLength) errors.push(`La justificación admite máximo ${LIMITS.textLength} caracteres.`)

  let amount: number | undefined
  if (amountText !== '') {
    const parsed = parseAmount(amountText)
    if (parsed === null) errors.push(`El valor «${amountText}» no es un monto válido (usa 1234567,89 o 1.234.567,89).`)
    else if (Math.abs(parsed) > LIMITS.maxAbsAmount) errors.push('El valor está fuera de rango.')
    else amount = parsed
  }

  if (form.expected === '') errors.push('Elige la categoría esperada.')
  else if (!categories.some((c) => c.id === form.expected)) errors.push(`La categoría esperada ${form.expected} no existe en la tarea.`)

  if (form.difficulty !== '' && !isDifficulty(form.difficulty)) errors.push('La dificultad debe ser fácil, media o difícil.')
  if (errors.length > 0) return { ok: false, errors }

  const item: LabeledConcept = { id, concept, expected: form.expected }
  if (supplier !== '') item.supplier = supplier
  if (amount !== undefined) item.amount = amount
  if (currency !== '') item.currency = currency
  if (notes !== '') item.notes = notes
  if (form.difficulty !== '') item.difficulty = form.difficulty
  if (rationale !== '') item.rationale = rationale
  return { ok: true, value: item }
}
