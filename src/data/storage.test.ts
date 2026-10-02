import { describe, expect, it } from 'vitest'
import type { Dataset } from '../shared/contracts.ts'
import { SEED_DATASET_ID } from '../shared/contracts.ts'
import { CUSTOM_DATASETS_KEY, loadCustomDatasets, saveCustomDatasets, type StorageLike } from './storage.ts'

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  }
}

function makeDataset(id: string, overrides: Partial<Dataset> = {}): Dataset {
  return {
    id,
    name: `Dataset ${id}`,
    description: '',
    source: 'custom',
    task: {
      instructions: 'Clasifica.',
      question: '¿Dónde va?',
      categories: [
        { id: '513530', name: 'Energía', description: 'Consumo', group: '5135 Servicios' },
        { id: '513535', name: 'Teléfono', description: '' },
      ],
    },
    items: [
      { id: 'item-001', concept: 'ENERGIA', expected: '513530', amount: 100, currency: 'COP', difficulty: 'easy' },
      { id: 'item-002', concept: 'PLAN', expected: '513535' },
    ],
    ...overrides,
  }
}

describe('storage de datasets personalizados', () => {
  it('guarda y vuelve a leer lo mismo', () => {
    const storage = memoryStorage()
    const datasets = [makeDataset('uno'), makeDataset('dos')]
    expect(saveCustomDatasets(datasets, storage)).toBe(true)
    expect(storage.data.has(CUSTOM_DATASETS_KEY)).toBe(true)
    expect(loadCustomDatasets(storage)).toEqual(datasets)
  })

  it('usa la clave versionada jev-classify-lab:datasets:v1', () => {
    expect(CUSTOM_DATASETS_KEY).toBe('jev-classify-lab:datasets:v1')
  })

  it('sin datos devuelve una lista vacía', () => {
    expect(loadCustomDatasets(memoryStorage())).toEqual([])
  })

  it('con JSON corrupto o de forma inesperada devuelve una lista vacía', () => {
    for (const raw of ['{no es json', 'null', '42', '"texto"', '{"datasets":"x"}', '']) {
      expect(loadCustomDatasets(memoryStorage({ [CUSTOM_DATASETS_KEY]: raw }))).toEqual([])
    }
  })

  it('descarta los datasets inválidos y conserva los buenos', () => {
    const good = makeDataset('bueno')
    const noItems = { ...makeDataset('sin-items'), items: [] }
    const badLabel = makeDataset('mala-etiqueta', { items: [{ id: 'x', concept: 'Y', expected: 'no-existe' }] })
    const stored = JSON.stringify({ version: 1, datasets: [noItems, good, badLabel, 'basura', null, { id: 'x' }] })
    expect(loadCustomDatasets(memoryStorage({ [CUSTOM_DATASETS_KEY]: stored }))).toEqual([good])
  })

  it('descarta ids repetidos (queda el primero) y los que usan el id de una semilla', () => {
    const first = makeDataset('dup', { name: 'Primero' })
    const second = makeDataset('dup', { name: 'Segundo' })
    const seedClash = makeDataset(SEED_DATASET_ID)
    const stored = JSON.stringify({ version: 1, datasets: [first, second, seedClash] })
    expect(loadCustomDatasets(memoryStorage({ [CUSTOM_DATASETS_KEY]: stored }))).toEqual([first])
  })

  it('fuerza source custom y descarta campos desconocidos al cargar', () => {
    const stored = JSON.stringify([{ ...makeDataset('a'), source: 'seed', extra: true }])
    const [loaded] = loadCustomDatasets(memoryStorage({ [CUSTOM_DATASETS_KEY]: stored }))
    expect(loaded?.source).toBe('custom')
    expect(loaded).not.toHaveProperty('extra')
  })

  it('no lanza si el storage falla al leer o escribir', () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(loadCustomDatasets(broken)).toEqual([])
    expect(saveCustomDatasets([makeDataset('a')], broken)).toBe(false)
  })

  it('sin localStorage disponible (entorno Node) se comporta como vacío', () => {
    expect(() => loadCustomDatasets(undefined)).not.toThrow()
    expect(() => saveCustomDatasets([], undefined)).not.toThrow()
  })
})
