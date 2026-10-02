import clsx from 'clsx'
import type { ReactNode } from 'react'
import { selectRunValidity, useBench } from '../../bench/useBench.ts'
import { ENGINE_IDS } from '../../shared/contracts.ts'
import { pct, type ValidityCode } from '../../metrics/index.ts'
import { CAUTION_CODES } from '../compare/panelData.ts'
import { globalProgress } from '../lane/laneView.ts'
import { useComparison } from '../metrics/hooks.ts'
import { UI } from '../ui/theme.ts'

/** Validity codes the status area does not repeat. */
const HIDDEN_ISSUES: ReadonlySet<ValidityCode> = new Set<ValidityCode>(['mock', 'mixed_mode', 'mode_mismatch', 'running', 'no_data'])

/** Also hidden mid-run: lanes naturally cover different items until both finish. */
const HIDDEN_WHILE_RUNNING: ReadonlySet<ValidityCode> = new Set<ValidityCode>([...HIDDEN_ISSUES, 'coverage_mismatch', 'incomplete'])

const STATUS_TEXT = {
  idle: 'Lista para iniciar',
  running: 'En curso',
  done: 'Terminada',
  aborted: 'Detenida',
} as const

function Banner({ tone, title, children }: { tone: 'warn' | 'ok'; title: string; children?: ReactNode }) {
  return (
    <div
      role="status"
      className={clsx(
        'rounded-lg border px-3.5 py-2.5 text-sm',
        tone === 'warn'
          ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
          : 'border-green-200 bg-green-50 text-green-900 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200',
      )}
    >
      <p className="font-semibold">
        <span aria-hidden>{tone === 'warn' ? '⚠ ' : '✓ '}</span>
        {title}
      </p>
      {children}
    </div>
  )
}

/** Global progress plus the validity banner (SIMULADO / mixed modes / failure-rate warnings). */
export function RunStatus() {
  const status = useBench((s) => s.status)
  const hasRun = useBench((s) => s.run !== null)
  const gptRecords = useBench((s) => s.lanes.gpt.records.length)
  const jevRecords = useBench((s) => s.lanes.jev.records.length)
  const gptTotal = useBench((s) => s.lanes.gpt.info.total)
  const jevTotal = useBench((s) => s.lanes.jev.info.total)
  const validity = useBench(selectRunValidity)
  const comparison = useComparison()

  const progress = globalProgress([
    { completed: gptRecords, total: gptTotal },
    { completed: jevRecords, total: jevTotal },
  ])
  const percent = Math.round((progress.fraction ?? 0) * 100)
  // Notes from the comparison (aborted / incomplete runs, high failure rate...). Mode issues are
  // already covered by the banner above and "still running" is obvious from the progress bar.
  const hidden = status === 'running' ? HIDDEN_WHILE_RUNNING : HIDDEN_ISSUES
  // Live in both lanes, but a stopped / incomplete / mismatched run is not a valid comparison:
  // do not greet it with the green "measures the real models" banner.
  const finishedInvalid = hasRun && status !== 'running' && comparison !== null && !comparison.validity.validForComparison
  const notes = (comparison?.validity.issues ?? []).filter((i) => !hidden.has(i.code)).map((i) => i.message)
  // Valid but worrying (e.g. > 20 % errors / timeouts in a lane): never under the green banner.
  const caution = (comparison?.validity.issues ?? []).some((i) => !i.blocking && CAUTION_CODES.has(i.code))

  return (
    <section aria-label="Estado de la corrida" className="space-y-2.5">
      {validity.simulated || validity.mixedModes ? (
        <Banner
          tone="warn"
          title={
            validity.simulated
              ? 'Modo SIMULADO: este resultado no mide nada real'
              : 'Los carriles usan modos distintos: la comparación no es válida'
          }
        >
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px]">
            {validity.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
            {validity.simulated && (
              <li>Sirve para probar la pantalla. Para comparar a GPT y a Jev, pon ambos carriles en Live (requiere las API keys en el backend).</li>
            )}
          </ul>
        </Banner>
      ) : finishedInvalid ? (
        <Banner tone="warn" title="Ambos carriles usaron Live, pero esta corrida no es válida para comparar (detalle abajo)" />
      ) : caution ? (
        <Banner tone="warn" title="Ambos carriles en Live, pero con muchos errores o timeouts: la comparación vale, léela con cautela (detalle abajo)" />
      ) : (
        <Banner tone="ok" title={hasRun ? 'Ambos carriles corrieron en Live: la comparación mide a los modelos reales' : 'Ambos carriles en Live: la comparación medirá a los modelos reales'} />
      )}

      {notes.length > 0 && (
        <Banner tone="warn" title="Ten en cuenta al leer el resultado">
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px]">
            {notes.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Banner>
      )}

      <div className={clsx(UI.card, 'px-4 py-3')}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
          <span className="font-medium">
            Progreso global <span className="font-normal text-zinc-500 dark:text-zinc-400">· {STATUS_TEXT[status]}</span>
          </span>
          <span className="text-zinc-600 tabular-nums dark:text-zinc-300">
            {progress.completed} / {progress.total} clasificaciones ({ENGINE_IDS.length} carriles) · {pct(progress.fraction, 0)}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="Progreso global"
          aria-valuemin={0}
          aria-valuemax={Math.max(progress.total, 1)}
          aria-valuenow={progress.completed}
          className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
        >
          <div
            className="h-full rounded-full bg-linear-to-r from-(--engine-gpt) to-(--engine-jev) transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
    </section>
  )
}
