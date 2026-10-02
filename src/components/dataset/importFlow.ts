/**
 * Pure planning of a dataset import: parse the text (JSON or CSV), build the dataset that would be
 * saved and collect warnings. Nothing is saved here; the UI shows the plan and commits it with
 * `upsertCustomDataset` after the user confirms.
 */
import type { Category, ClassificationTask, Dataset } from '../../shared/contracts.ts'
import { DEFAULT_TASK_INSTRUCTIONS, DEFAULT_TASK_QUESTION, LIMITS } from '../../shared/task.ts'
import {
  categoriesToCsv,
  itemsToCsv,
  parseCategoriesCsv,
  parseDatasetJson,
  parseItemsCsv,
} from '../../data/importDataset.ts'
import { mergeItems, slugify, uniqueId } from './datasetEdit.ts'

export interface ImportPlanOk {
  ok: true
  /** Dataset to save (new, or the current one with the imported items appended). */
  dataset: Dataset
  mode: 'create' | 'append'
  /** Imported items. */
  itemCount: number
  warnings: string[]
}

export interface ImportPlanError {
  ok: false
  errors: string[]
}

export type ImportPlan = ImportPlanOk | ImportPlanError

export const DEFAULT_IMPORT_NAME = 'Dataset importado'

/** Complete dataset (JSON). It always becomes a new custom dataset; a repeated id gets a suffix. */
export function planJsonImport(text: string, takenIds: Iterable<string>): ImportPlan {
  const parsed = parseDatasetJson(text)
  if (!parsed.ok) return parsed
  const warnings: string[] = []
  const id = uniqueId(parsed.dataset.id, takenIds)
  if (id !== parsed.dataset.id) warnings.push(`Ya existe un dataset con el id «${parsed.dataset.id}»: se guardó como «${id}».`)
  return {
    ok: true,
    mode: 'create',
    dataset: { ...parsed.dataset, id, source: 'custom' },
    itemCount: parsed.dataset.items.length,
    warnings,
  }
}

export interface ItemsImportOptions {
  /** CSV of labeled concepts. */
  itemsText: string
  /**
   * CSV of categories. Omitted: the categories (and the whole task) of `baseTask` are used.
   * Given: the categories come from this CSV and the task text falls back to the defaults.
   */
  categoriesText?: string
  /** Task of the selected dataset. */
  baseTask: ClassificationTask
  /** Name of the new dataset (ignored when appending). */
  name: string
  takenIds: Iterable<string>
  /** Current custom dataset to append the items to; omitted = create a new one. */
  appendTo?: Dataset
}

export function planItemsImport(options: ItemsImportOptions): ImportPlan {
  const warnings: string[] = []
  let categories: readonly Category[]
  let task: ClassificationTask

  if (options.categoriesText !== undefined && options.appendTo === undefined) {
    const parsedCategories = parseCategoriesCsv(options.categoriesText)
    if (!parsedCategories.ok) return { ok: false, errors: parsedCategories.errors.map((e) => `Categorías · ${e}`) }
    warnings.push(...parsedCategories.warnings.map((w) => `Categorías · ${w}`))
    categories = parsedCategories.categories
    task = { instructions: DEFAULT_TASK_INSTRUCTIONS, question: DEFAULT_TASK_QUESTION, categories: [...categories] }
  } else {
    task = options.appendTo?.task ?? options.baseTask
    categories = task.categories
  }

  const parsedItems = parseItemsCsv(options.itemsText, categories)
  if (!parsedItems.ok) return { ok: false, errors: parsedItems.errors.map((e) => `Conceptos · ${e}`) }
  warnings.push(...parsedItems.warnings.map((w) => `Conceptos · ${w}`))

  if (options.appendTo !== undefined) {
    const merged = mergeItems(options.appendTo.items, parsedItems.items)
    if (merged.renumbered > 0) {
      warnings.push(`${merged.renumbered} concepto(s) repetían el id de uno existente y recibieron un id nuevo (item-###).`)
    }
    if (merged.items.length > LIMITS.maxItems) {
      return { ok: false, errors: [`El dataset quedaría con ${merged.items.length} conceptos; el máximo es ${LIMITS.maxItems}.`] }
    }
    return {
      ok: true,
      mode: 'append',
      dataset: { ...options.appendTo, items: merged.items },
      itemCount: parsedItems.items.length,
      warnings,
    }
  }

  const name = options.name.trim() === '' ? DEFAULT_IMPORT_NAME : options.name.trim().slice(0, LIMITS.nameLength)
  const base = slugify(name) || 'dataset'
  return {
    ok: true,
    mode: 'create',
    dataset: {
      id: uniqueId(base, options.takenIds),
      name,
      description: '',
      locale: 'es-CO',
      source: 'custom',
      task: structuredClone(task),
      items: parsedItems.items,
    },
    itemCount: parsedItems.items.length,
    warnings,
  }
}

/** CSV template of concepts: header plus one example row (its `esperado` is the first category). */
export function itemsTemplateCsv(categories: readonly Category[]): string {
  return itemsToCsv([
    {
      id: 'item-001',
      concept: 'Ejemplo: servicio de energía eléctrica, periodo marzo',
      supplier: 'Proveedor de ejemplo S.A.S.',
      amount: 150_000,
      currency: 'COP',
      expected: categories[0]?.id ?? '513530',
      difficulty: 'easy',
      rationale: 'Por qué esta es la categoría correcta (solo local).',
    },
  ])
}

/** CSV template of categories: header plus two example rows (a task needs at least two). */
export function categoriesTemplateCsv(): string {
  return categoriesToCsv([
    { id: '513530', name: 'Energía eléctrica', description: 'Consumo de energía eléctrica de la oficina.', group: '5135 Servicios' },
    { id: '513535', name: 'Teléfono', description: 'Telefonía fija, móvil e internet.', group: '5135 Servicios' },
  ])
}
