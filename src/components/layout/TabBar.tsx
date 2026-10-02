import clsx from 'clsx'
import { useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { TAB_LABELS, panelDomId, tabDomId } from './labels.ts'
import { TAB_IDS, type TabId } from './query.ts'

/** Accessible tablist (arrow keys, Home / End). The panel is rendered by the caller with `panelDomId`. */
export function TabBar({ active, onChange }: { active: TabId; onChange: (tab: TabId) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  const onKeyDown = (event: KeyboardEvent, index: number): void => {
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % TAB_IDS.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + TAB_IDS.length) % TAB_IDS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = TAB_IDS.length - 1
    else return
    event.preventDefault()
    onChange(TAB_IDS[next])
    refs.current[next]?.focus()
  }

  return (
    <div role="tablist" aria-label="Secciones" className="flex gap-1 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800">
      {TAB_IDS.map((id, i) => {
        const selected = id === active
        return (
          <button
            key={id}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="tab"
            id={tabDomId(id)}
            aria-selected={selected}
            aria-controls={panelDomId(id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={clsx(
              '-mb-px shrink-0 border-b-2 px-4 py-2.5 text-sm whitespace-nowrap transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-500',
              selected
                ? 'border-zinc-900 font-semibold text-zinc-900 dark:border-zinc-100 dark:text-zinc-100'
                : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100',
            )}
          >
            {TAB_LABELS[id]}
          </button>
        )
      })}
    </div>
  )
}
