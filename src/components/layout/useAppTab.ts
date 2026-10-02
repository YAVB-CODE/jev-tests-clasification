import { useCallback, useState } from 'react'
import { parseQuery, readStoredTab, resolveInitialTab, withTab, writeStoredTab, type TabId } from './query.ts'

/** Mirrors the tab into `?tab=` (replaceState: no history spam) without touching the other params. */
function syncUrl(tab: TabId): void {
  try {
    const next = withTab(window.location.search, tab)
    if (next !== window.location.search) {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${next}${window.location.hash}`)
    }
  } catch {
    // history can be unavailable in sandboxed frames; the tab still works
  }
}

/** Active tab: initial value from the URL, then localStorage; every change is written to both. */
export function useAppTab(): readonly [TabId, (tab: TabId) => void] {
  const [tab, setTab] = useState<TabId>(() => {
    const initial = resolveInitialTab(parseQuery(window.location.search), readStoredTab())
    syncUrl(initial)
    return initial
  })

  const change = useCallback((next: TabId) => {
    setTab(next)
    writeStoredTab(next)
    syncUrl(next)
  }, [])

  return [tab, change] as const
}
