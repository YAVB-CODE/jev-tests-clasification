/**
 * Datasets personalizados en localStorage. Toda lectura/escritura va en try/catch (puede no haber
 * localStorage, estar bloqueado o lleno) y lo guardado se revalida al cargar: lo corrupto se descarta.
 */
import type { Dataset } from '../shared/contracts.ts'
import { validateDataset } from '../shared/task.ts'
import { SEED_DATASETS } from './datasets.ts'

export const CUSTOM_DATASETS_KEY = 'jev-classify-lab:datasets:v1'

/** Lo mínimo que se usa de `Storage` (facilita inyectar un doble en tests). */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function defaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined // acceder a localStorage puede lanzar (p. ej. cookies bloqueadas)
  }
}

/**
 * Lee los datasets personalizados. Nunca lanza: sin storage, sin datos o con JSON roto devuelve [].
 * Se descartan los datasets inválidos, los repetidos (queda el primero) y los que usan el id de un
 * dataset semilla. Todos salen con `source: 'custom'`.
 */
export function loadCustomDatasets(storage: StorageLike | undefined = defaultStorage()): Dataset[] {
  if (storage === undefined) return []
  let raw: string | null
  try {
    raw = storage.getItem(CUSTOM_DATASETS_KEY)
  } catch {
    return []
  }
  if (raw === null || raw === '') return []

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const list: unknown = Array.isArray(parsed) ? parsed : (parsed as { datasets?: unknown } | null)?.datasets
  if (!Array.isArray(list)) return []

  const reserved = new Set(SEED_DATASETS.map((dataset) => dataset.id))
  const seen = new Set<string>()
  const datasets: Dataset[] = []
  for (const entry of list as unknown[]) {
    const result = validateDataset(entry)
    if (!result.ok) continue
    const { id } = result.value
    if (reserved.has(id) || seen.has(id)) continue
    seen.add(id)
    datasets.push({ ...result.value, source: 'custom' })
  }
  return datasets
}

/** Guarda los datasets personalizados. Devuelve false si no se pudo (sin storage, cuota llena, etc.). */
export function saveCustomDatasets(datasets: readonly Dataset[], storage: StorageLike | undefined = defaultStorage()): boolean {
  if (storage === undefined) return false
  try {
    storage.setItem(CUSTOM_DATASETS_KEY, JSON.stringify({ version: 1, datasets }))
    return true
  } catch {
    return false
  }
}
