import clsx from 'clsx'
import type { EngineMode } from '../../shared/contracts.ts'

/** LIVE (real calls) vs SIMULADO (local mock, measures nothing real). Always text + color. */
export function ModeBadge({ mode, className }: { mode: EngineMode; className?: string }) {
  const live = mode === 'live'
  return (
    <span
      title={live ? 'Llamadas reales al modelo a través del backend.' : 'Motor simulado: no mide al modelo real.'}
      className={clsx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] leading-none font-semibold tracking-wide',
        live
          ? 'bg-green-100 text-green-800 dark:bg-green-950/60 dark:text-green-300'
          : 'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-300',
        className,
      )}
    >
      <span aria-hidden>{live ? '●' : '⚠'}</span>
      {live ? 'LIVE' : 'SIMULADO'}
    </span>
  )
}
