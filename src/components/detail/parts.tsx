/** Small presentational pieces shared by the detail table and the expanded row. */
import clsx from 'clsx'
import type { Difficulty } from '../../shared/contracts.ts'
import { OUTCOME_STYLE, UI } from '../ui/theme.ts'
import { DIFFICULTY_LABELS, type Outcome } from './detailRows.ts'

const PENDING_LABEL = 'Pendiente'

/** ✓ / ✗ / ! in a circle. Never color-only: it carries the symbol and an accessible label. */
export function OutcomeIcon({ outcome, className }: { outcome: Outcome; className?: string }) {
  if (outcome === 'pending') {
    return (
      <span
        role="img"
        aria-label={PENDING_LABEL}
        title={PENDING_LABEL}
        className={clsx('inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs text-zinc-400 dark:bg-zinc-800', className)}
      >
        …
      </span>
    )
  }
  const style = OUTCOME_STYLE[outcome]
  return (
    <span
      role="img"
      aria-label={style.label}
      title={style.label}
      className={clsx('inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold', style.soft, style.text, className)}
    >
      {style.icon}
    </span>
  )
}

export function DifficultyBadge({ difficulty }: { difficulty: Difficulty | undefined }) {
  if (!difficulty) return <span className={UI.muted}>—</span>
  return <span className={clsx(UI.badge, 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300')}>{DIFFICULTY_LABELS[difficulty]}</span>
}

/** "513530 Energía eléctrica": the id in monospace, then the name. */
export function CategoryLabel({ id, name, className }: { id: string; name: string | undefined; className?: string }) {
  return (
    <span className={clsx('inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5', className)}>
      <span className="font-mono text-xs font-semibold tabular-nums">{id}</span>
      {name && name !== id ? <span className="text-sm">{name}</span> : null}
    </span>
  )
}
