import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TAB,
  TAB_STORAGE_KEY,
  parseQuery,
  parseTab,
  queryToConfigPatch,
  readStoredTab,
  resolveInitialTab,
  withTab,
  writeStoredTab,
  type TabStorage,
} from './query.ts'

function fakeStorage(initial: Record<string, string> = {}): TabStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value
    },
  }
}

const brokenStorage: TabStorage = {
  getItem: () => {
    throw new Error('blocked')
  },
  setItem: () => {
    throw new Error('blocked')
  },
}

describe('parseTab', () => {
  it('accepts canonical ids and aliases, ignoring case and spaces', () => {
    expect(parseTab('benchmark')).toBe('benchmark')
    expect(parseTab(' Detalle ')).toBe('detalle')
    expect(parseTab('DATASET')).toBe('dataset')
    expect(parseTab('prueba-rapida')).toBe('prueba')
    expect(parseTab('quick')).toBe('prueba')
    expect(parseTab('detail')).toBe('detalle')
  })

  it('rejects anything else', () => {
    expect(parseTab('nope')).toBeNull()
    expect(parseTab('')).toBeNull()
    expect(parseTab(null)).toBeNull()
    expect(parseTab(undefined)).toBeNull()
  })
})

describe('parseQuery', () => {
  it('returns neutral defaults for an empty query', () => {
    expect(parseQuery('')).toEqual({ mock: false, autostart: false, tab: null })
  })

  it('reads every switch', () => {
    expect(parseQuery('?mock=1&limit=12&seed=7&autostart=1&tab=detalle')).toEqual({
      mock: true,
      limit: 12,
      seed: 7,
      autostart: true,
      tab: 'detalle',
    })
  })

  it('treats a bare flag as on and 0 / false / off as off', () => {
    expect(parseQuery('?mock').mock).toBe(true)
    expect(parseQuery('?mock=true').mock).toBe(true)
    expect(parseQuery('?mock=0').mock).toBe(false)
    expect(parseQuery('?autostart=false').autostart).toBe(false)
    expect(parseQuery('?autostart=OFF').autostart).toBe(false)
  })

  it('validates numbers: integers, limit >= 1, seed >= 0', () => {
    expect(parseQuery('?limit=0').limit).toBeUndefined()
    expect(parseQuery('?limit=-3').limit).toBeUndefined()
    expect(parseQuery('?limit=abc').limit).toBeUndefined()
    expect(parseQuery('?limit=').limit).toBeUndefined()
    expect(parseQuery('?limit=9.9').limit).toBe(9)
    expect(parseQuery('?seed=0').seed).toBe(0)
    expect(parseQuery('?seed=-1').seed).toBeUndefined()
    expect(parseQuery('?seed=Infinity').seed).toBeUndefined()
  })

  it('ignores an unknown tab', () => {
    expect(parseQuery('?tab=zzz').tab).toBeNull()
  })
})

describe('queryToConfigPatch', () => {
  it('only carries the fields present in the URL', () => {
    expect(queryToConfigPatch(parseQuery(''))).toEqual({})
    expect(queryToConfigPatch(parseQuery('?limit=5'))).toEqual({ limit: 5 })
    expect(queryToConfigPatch(parseQuery('?limit=5&seed=0&mock=1'))).toEqual({ limit: 5, seed: 0 })
  })
})

describe('withTab', () => {
  it('sets the tab and keeps the other parameters', () => {
    expect(withTab('', 'dataset')).toBe('?tab=dataset')
    expect(withTab('?mock=1&tab=benchmark', 'detalle')).toBe('?mock=1&tab=detalle')
    expect(withTab('?autostart=1', 'prueba')).toBe('?autostart=1&tab=prueba')
  })
})

describe('resolveInitialTab', () => {
  it('prefers the URL, then the remembered tab, then the default', () => {
    expect(resolveInitialTab({ tab: 'dataset', autostart: false }, 'detalle')).toBe('dataset')
    expect(resolveInitialTab({ tab: null, autostart: false }, 'detalle')).toBe('detalle')
    expect(resolveInitialTab({ tab: null, autostart: false }, null)).toBe(DEFAULT_TAB)
  })

  it('opens the benchmark when autostarting without an explicit tab', () => {
    expect(resolveInitialTab({ tab: null, autostart: true }, 'dataset')).toBe('benchmark')
    expect(resolveInitialTab({ tab: 'detalle', autostart: true }, 'dataset')).toBe('detalle')
  })
})

describe('stored tab', () => {
  it('round-trips through storage', () => {
    const storage = fakeStorage()
    expect(readStoredTab(storage)).toBeNull()
    expect(writeStoredTab('prueba', storage)).toBe(true)
    expect(storage.data[TAB_STORAGE_KEY]).toBe('prueba')
    expect(readStoredTab(storage)).toBe('prueba')
  })

  it('ignores an invalid stored value', () => {
    expect(readStoredTab(fakeStorage({ [TAB_STORAGE_KEY]: 'garbage' }))).toBeNull()
  })

  it('never throws when storage is blocked or missing', () => {
    expect(readStoredTab(brokenStorage)).toBeNull()
    expect(writeStoredTab('dataset', brokenStorage)).toBe(false)
    expect(readStoredTab(null)).toBeNull()
    expect(writeStoredTab('dataset', null)).toBe(false)
  })
})
