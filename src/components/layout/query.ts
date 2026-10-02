/**
 * URL switches for dev / QA, plus the helpers that remember the active tab (URL + localStorage).
 *
 *   ?mock=1        both lanes in SIMULADO mode (no keys, no network)
 *   ?limit=N       max items per run (N >= 1)
 *   ?seed=N        shuffle seed (N >= 0)
 *   ?autostart=1   start the run as soon as health / models have loaded
 *   ?tab=          benchmark | detalle | dataset | prueba
 *
 * Everything here is pure (or takes an injectable storage) so it can be unit tested in node.
 */
import type { BenchConfig } from '../../shared/contracts.ts'

export const TAB_IDS = ['benchmark', 'detalle', 'dataset', 'prueba'] as const
export type TabId = (typeof TAB_IDS)[number]

export const DEFAULT_TAB: TabId = 'benchmark'
export const TAB_STORAGE_KEY = 'jev-classify-lab:tab'

const TAB_ALIASES: Readonly<Record<string, TabId>> = {
  detail: 'detalle',
  datasets: 'dataset',
  quick: 'prueba',
  rapida: 'prueba',
  'prueba-rapida': 'prueba',
  prueba_rapida: 'prueba',
}

/** Accepts canonical ids and a few aliases (case-insensitive); anything else → null. */
export function parseTab(value: string | null | undefined): TabId | null {
  if (typeof value !== 'string') return null
  const key = value.trim().toLowerCase()
  if ((TAB_IDS as readonly string[]).includes(key)) return key as TabId
  return TAB_ALIASES[key] ?? null
}

export interface AppQuery {
  /** Both lanes in SIMULADO mode. */
  mock: boolean
  limit?: number
  seed?: number
  autostart: boolean
  /** Tab requested in the URL, or null. */
  tab: TabId | null
}

const FALSE_WORDS: ReadonlySet<string> = new Set(['0', 'false', 'no', 'off'])

/** `?flag` and `?flag=1|true|yes` are on; absent, `0`, `false`, `no`, `off` are off. */
function parseFlag(value: string | null): boolean {
  if (value === null) return false
  return !FALSE_WORDS.has(value.trim().toLowerCase())
}

/** Integer >= `min` from a query value; otherwise undefined. Decimals are rounded down. */
function parseInteger(value: string | null, min: number): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const n = Number(value)
  if (!Number.isFinite(n)) return undefined
  const whole = Math.floor(n)
  return whole >= min ? whole : undefined
}

export function parseQuery(search: string): AppQuery {
  const q = new URLSearchParams(search)
  const query: AppQuery = {
    mock: parseFlag(q.get('mock')),
    autostart: parseFlag(q.get('autostart')),
    tab: parseTab(q.get('tab')),
  }
  const limit = parseInteger(q.get('limit'), 1)
  if (limit !== undefined) query.limit = limit
  const seed = parseInteger(q.get('seed'), 0)
  if (seed !== undefined) query.seed = seed
  return query
}

/** Config fields requested by the URL (the store sanitizes / clamps them again). */
export function queryToConfigPatch(query: AppQuery): Partial<BenchConfig> {
  const patch: Partial<BenchConfig> = {}
  if (query.limit !== undefined) patch.limit = query.limit
  if (query.seed !== undefined) patch.seed = query.seed
  return patch
}

/** Returns `search` with `tab` set, keeping the other parameters. Always starts with "?". */
export function withTab(search: string, tab: TabId): string {
  const q = new URLSearchParams(search)
  q.set('tab', tab)
  return `?${q.toString()}`
}

/**
 * Tab shown on load: URL first, then the remembered one. `?autostart=1` without an explicit tab
 * opens the benchmark so the run is visible.
 */
export function resolveInitialTab(query: Pick<AppQuery, 'tab' | 'autostart'>, stored: TabId | null): TabId {
  if (query.tab) return query.tab
  if (query.autostart) return DEFAULT_TAB
  return stored ?? DEFAULT_TAB
}

/** Minimal Storage surface (lets tests inject a fake and the app survive blocked storage). */
export interface TabStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function defaultStorage(): TabStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** Remembered tab, or null (nothing stored, invalid value or storage unavailable). */
export function readStoredTab(storage: TabStorage | null = defaultStorage()): TabId | null {
  try {
    return parseTab(storage?.getItem(TAB_STORAGE_KEY))
  } catch {
    return null
  }
}

/** Remembers the tab; returns false when storage is unavailable. */
export function writeStoredTab(tab: TabId, storage: TabStorage | null = defaultStorage()): boolean {
  try {
    if (!storage) return false
    storage.setItem(TAB_STORAGE_KEY, tab)
    return true
  } catch {
    return false
  }
}
