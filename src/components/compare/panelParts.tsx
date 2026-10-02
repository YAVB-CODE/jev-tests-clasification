/** Small presentational pieces shared by the verdict, pillar cards, table and paired test. */
import clsx from 'clsx'
import type { EngineId } from '../../shared/contracts.ts'
import type { Winner } from '../../metrics/index.ts'
import { ENGINE_THEME } from '../ui/theme.ts'
import { MarkerShape } from './chartParts.tsx'
import { isEngineWinner, winnerLabel } from './panelData.ts'

/** Engine mark (circle = GPT, diamond = Jev) in the validated series color. */
export function EngineMark({ engine, size = 12 }: { engine: EngineId; size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 12 12" className="shrink-0">
      <MarkerShape engine={engine} cx={6} cy={6} r={3.6} hit={false} />
    </svg>
  )
}

/** Engine name with its mark; the name is text, not colored by the series. */
export function EngineName({ engine, className }: { engine: EngineId; className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-1.5 font-medium', className)}>
      <EngineMark engine={engine} />
      {ENGINE_THEME[engine].label}
    </span>
  )
}

/** Winner of a metric / pillar: engine chip in its lane colors, "Empate" or "Sin datos". Never color-only. */
export function WinnerChip({ winner, className }: { winner: Winner | undefined; className?: string }) {
  if (isEngineWinner(winner)) {
    const t = ENGINE_THEME[winner]
    return (
      <span className={clsx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold', t.soft, t.border, t.text, className)}>
        <EngineMark engine={winner} size={11} />
        {t.label}
      </span>
    )
  }
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-100 px-2.5 py-0.5 text-xs font-semibold text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
        className,
      )}
    >
      {winner === 'tie' ? '= ' : ''}
      {winnerLabel(winner)}
    </span>
  )
}

/** Check mark for "better value" with an accessible name. */
export function BestMark() {
  return (
    <span role="img" aria-label="mejor" title="Mejor valor" className="mr-1 text-[0.8em]">
      ✓
    </span>
  )
}
