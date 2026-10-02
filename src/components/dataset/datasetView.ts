/** Pure helpers to read, summarize and filter a dataset in the manager UI. */
import type { Category, Dataset, Difficulty, LabeledConcept } from '../../shared/contracts.ts'
import { fixed } from '../../metrics/format.ts'

export const DIFFICULTY_LABELS: Record<Difficulty, string> = { easy: 'Fácil', medium: 'Media', hard: 'Difícil' }

export type DifficultyCounts = Record<Difficulty | 'unset', number>

export interface DatasetSummary {
  categories: number
  /** Distinct `Category.group` values. */
  groups: number
  items: number
  byDifficulty: DifficultyCounts
}

export function summarizeDataset(dataset: Pick<Dataset, 'task' | 'items'>): DatasetSummary {
  const byDifficulty: DifficultyCounts = { easy: 0, medium: 0, hard: 0, unset: 0 }
  for (const item of dataset.items) byDifficulty[item.difficulty ?? 'unset']++
  const groups = new Set<string>()
  for (const category of dataset.task.categories) {
    const group = category.group?.trim()
    if (group) groups.add(group)
  }
  return {
    categories: dataset.task.categories.length,
    groups: groups.size,
    items: dataset.items.length,
    byDifficulty,
  }
}

/** Number of items per expected category id. */
export function countByCategory(items: readonly LabeledConcept[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item.expected, (counts.get(item.expected) ?? 0) + 1)
  return counts
}

/** "513530 · Energía eléctrica"; the bare id when the category is unknown. */
export function categoryLabel(categories: readonly Category[], id: string): string {
  const category = categories.find((c) => c.id === id)
  return category ? `${category.id} · ${category.name}` : id
}

/** Lowercase, accent-free text for forgiving searches. */
export function normalizeSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
}

export type DifficultyFilter = Difficulty | 'unset' | 'all'

export interface ItemFilter {
  query: string
  difficulty: DifficultyFilter
  /** Expected category id; '' = every category. */
  category: string
}

export const EMPTY_FILTER: Readonly<ItemFilter> = Object.freeze({ query: '', difficulty: 'all', category: '' })

/** Items matching every search word (concept, supplier, notes, id, expected code and name) and both filters. */
export function filterItems(
  items: readonly LabeledConcept[],
  categories: readonly Category[],
  filter: ItemFilter,
): LabeledConcept[] {
  const names = new Map(categories.map((c) => [c.id, c.name]))
  const words = normalizeSearch(filter.query).split(/\s+/).filter(Boolean)
  return items.filter((item) => {
    if (filter.difficulty !== 'all' && (item.difficulty ?? 'unset') !== filter.difficulty) return false
    if (filter.category !== '' && item.expected !== filter.category) return false
    if (words.length === 0) return true
    const haystack = normalizeSearch(
      [item.id, item.concept, item.supplier, item.notes, item.expected, names.get(item.expected)].filter(Boolean).join(' '),
    )
    return words.every((word) => haystack.includes(word))
  })
}

/** "COP 1.234.567" / "USD 12,50"; "—" when there is no amount. Currency defaults to COP. */
export function formatAmount(amount: number | undefined, currency?: string): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—'
  const digits = Number.isInteger(amount) ? 0 : 2
  return `${currency?.trim() || 'COP'} ${fixed(amount, digits)}`
}
