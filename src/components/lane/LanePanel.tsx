import clsx from 'clsx'
import { useBench } from '../../bench/useBench.ts'
import { pct, seconds } from '../../metrics/index.ts'
import type { EngineId, LaneRunInfo } from '../../shared/contracts.ts'
import { Chip } from '../layout/controls.tsx'
import { useLaneMetrics } from '../metrics/hooks.ts'
import { ENGINE_THEME } from '../ui/theme.ts'
import { LaneFeed } from './LaneFeed.tsx'
import { LANE_STATUS_VIEW, elapsedMs } from './laneView.ts'
import { ModeBadge } from './ModeBadge.tsx'
import { CostLine, PillarCards } from './PillarCards.tsx'
import { useNow } from './useNow.ts'
import { useRunLookup } from './useRunLookup.ts'

/** Completed / total bar with the elapsed time of the lane. The clock only ticks while it runs. */
function LaneProgress({ engine, info, completed }: { engine: EngineId; info: LaneRunInfo; completed: number }) {
  const theme = ENGINE_THEME[engine]
  const running = info.status === 'running'
  const now = useNow(running)
  const elapsed = elapsedMs(info, now)
  const total = info.total
  const fraction = total > 0 ? Math.min(1, completed / total) : 0

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs tabular-nums">
        <span className="font-medium">
          {completed} / {total}
          <span className="font-normal text-zinc-500 dark:text-zinc-400"> · {total > 0 ? pct(fraction, 0) : '—'}</span>
        </span>
        <span className="text-zinc-500 dark:text-zinc-400" title="Tiempo transcurrido del carril">
          <span aria-hidden>⏱ </span>
          {elapsed !== null ? seconds(elapsed) : '—'}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`Progreso de ${theme.label}`}
        aria-valuemin={0}
        aria-valuemax={Math.max(total, 1)}
        aria-valuenow={completed}
        className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
      >
        <div className={clsx('h-full rounded-full transition-[width] duration-300', theme.solid)} style={{ width: `${fraction * 100}%` }} />
      </div>
    </div>
  )
}

/** One lane of the split screen. Both lanes render the same structure with the same heights. */
export function LanePanel({ engine }: { engine: EngineId }) {
  const theme = ENGINE_THEME[engine]
  const info = useBench((s) => s.lanes[engine].info)
  const records = useBench((s) => s.lanes[engine].records)
  const metrics = useLaneMetrics(engine)
  const lookup = useRunLookup()
  const status = LANE_STATUS_VIEW[info.status]
  const completed = metrics?.counts.completed ?? records.length

  return (
    <section aria-label={`Carril ${theme.label}`} className={clsx('@container flex min-w-0 flex-col gap-3 rounded-xl border bg-white p-3 shadow-sm dark:bg-zinc-900', theme.border)}>
      <header className={clsx('rounded-lg border px-3 py-2', theme.border, theme.soft)}>
        <div className="flex items-center gap-2">
          <span aria-hidden className={clsx('h-5 w-1 shrink-0 rounded-full', theme.solid)} />
          <h2 className={clsx('min-w-0 truncate text-base font-semibold', theme.text)}>{theme.label}</h2>
          <span className="ml-auto flex shrink-0 items-center gap-2">
            <ModeBadge mode={info.mode} />
            <Chip tone={status.tone} className="px-2 py-1">
              {status.text}
            </Chip>
          </span>
        </div>
        <p className="mt-1 truncate text-xs text-zinc-600 dark:text-zinc-300" title={`${theme.vendor} · ${info.model}`}>
          {theme.vendor} · <span className="font-mono">{info.model}</span>
        </p>
      </header>

      <PillarCards engine={engine} metrics={metrics} />
      <CostLine metrics={metrics} />
      <LaneProgress engine={engine} info={info} completed={completed} />
      <LaneFeed records={records} items={lookup.items} categories={lookup.categories} />
    </section>
  )
}
