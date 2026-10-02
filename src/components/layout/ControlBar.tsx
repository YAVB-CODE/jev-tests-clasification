import clsx from 'clsx'
import { useMemo } from 'react'
import { selectPlanItems } from '../../bench/plan.ts'
import {
  selectActiveDataset,
  selectCanConfigure,
  selectFailedCount,
  selectLiveAvailable,
  useBench,
} from '../../bench/useBench.ts'
import {
  CONCURRENCY_OPTIONS,
  DIFFICULTIES,
  ENGINE_IDS,
  REPETITION_OPTIONS,
  BENCH_LIMITS,
  type EngineId,
  type EngineMode,
} from '../../shared/contracts.ts'
import { ENGINE_THEME, UI } from '../ui/theme.ts'
import { ActionButton, Field, NumberField, SegmentedControl } from './controls.tsx'
import { DIFFICULTY_LABELS, LIVE_UNAVAILABLE_HINT } from './labels.ts'
import { ModelPicker } from './ModelPicker.tsx'
import { INPUT_CLASS } from './styles.ts'

const SEED_MAX = 2 ** 31 - 1

function DatasetField() {
  const datasets = useBench((s) => s.datasets)
  const activeId = useBench((s) => s.activeDatasetId)
  const canConfigure = useBench(selectCanConfigure)
  const selectDataset = useBench((s) => s.selectDataset)
  const active = datasets.find((d) => d.id === activeId)

  return (
    <Field label="Dataset" hint={active?.description} className="min-w-44 flex-1 sm:max-w-72">
      <select
        className={clsx(INPUT_CLASS, 'w-full truncate')}
        value={activeId}
        disabled={!canConfigure}
        onChange={(e) => selectDataset(e.target.value)}
      >
        {datasets.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name} · {d.items.length} items{d.source === 'custom' ? ' · propio' : ''}
          </option>
        ))}
      </select>
    </Field>
  )
}

function DifficultyField() {
  const dataset = useBench(selectActiveDataset)
  const selected = useBench((s) => s.config.difficulties)
  const canConfigure = useBench(selectCanConfigure)
  const setConfig = useBench((s) => s.setConfig)

  const counts = useMemo(() => {
    const result = { easy: 0, medium: 0, hard: 0 }
    for (const item of dataset?.items ?? []) if (item.difficulty) result[item.difficulty] += 1
    return result
  }, [dataset])

  const toggle = (d: (typeof DIFFICULTIES)[number]): void => {
    const current = selected ?? []
    setConfig({ difficulties: current.includes(d) ? current.filter((x) => x !== d) : [...current, d] })
  }

  return (
    <Field as="div" label="Dificultad" hint="Sin selección se usan todas. Los conceptos sin dificultad se excluyen al filtrar.">
      <span className="inline-flex h-8 overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700" role="group" aria-label="Filtro de dificultad">
        <button
          type="button"
          aria-pressed={!selected || selected.length === 0}
          disabled={!canConfigure}
          onClick={() => setConfig({ difficulties: [] })}
          className={clsx(
            'px-2.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50',
            !selected || selected.length === 0
              ? 'bg-zinc-900 font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900'
              : 'bg-white text-zinc-600 hover:bg-zinc-100 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800',
          )}
        >
          Todas
        </button>
        {DIFFICULTIES.map((d) => {
          const on = selected?.includes(d) === true
          return (
            <button
              key={d}
              type="button"
              aria-pressed={on}
              disabled={!canConfigure}
              onClick={() => toggle(d)}
              className={clsx(
                'border-l border-zinc-300 px-2.5 text-xs tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700',
                on
                  ? 'bg-zinc-900 font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900'
                  : 'bg-white text-zinc-600 hover:bg-zinc-100 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800',
              )}
            >
              {DIFFICULTY_LABELS[d]} <span className="opacity-60">{counts[d]}</span>
            </button>
          )
        })}
      </span>
    </Field>
  )
}

function SettingsRow() {
  const config = useBench((s) => s.config)
  const canConfigure = useBench(selectCanConfigure)
  const setConfig = useBench((s) => s.setConfig)

  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
      <DatasetField />
      <DifficultyField />

      <Field label="Límite de items" hint="Máximo de conceptos por carril (después de filtrar y barajar). Vacío = todos.">
        <NumberField
          className="w-24"
          value={config.limit}
          min={1}
          max={100_000}
          allowEmpty
          placeholder="Todos"
          disabled={!canConfigure}
          onCommit={(limit) => setConfig({ limit })}
        />
      </Field>

      <Field as="div" label="Barajar y semilla" hint="Con barajar, ambos carriles reciben el mismo orden aleatorio determinado por la semilla.">
        <span className="flex items-center gap-1.5">
          <label className="inline-flex h-8 items-center gap-1.5 text-xs text-zinc-700 dark:text-zinc-300">
            <input
              type="checkbox"
              className="size-4 accent-zinc-800 dark:accent-zinc-200"
              checked={config.shuffle}
              disabled={!canConfigure}
              onChange={(e) => setConfig({ shuffle: e.target.checked })}
            />
            Barajar
          </label>
          <NumberField
            className="w-24"
            ariaLabel="Semilla"
            value={config.seed}
            min={0}
            max={SEED_MAX}
            disabled={!canConfigure || !config.shuffle}
            onCommit={(seed) => seed !== undefined && setConfig({ seed })}
          />
          <ActionButton
            aria-label="Semilla aleatoria"
            title="Semilla aleatoria"
            className="w-8 px-0 text-sm"
            disabled={!canConfigure || !config.shuffle}
            onClick={() => setConfig({ seed: Math.floor(Math.random() * 1_000_000) })}
          >
            <span aria-hidden>🎲</span>
          </ActionButton>
        </span>
      </Field>

      <Field as="div" label="Concurrencia por carril" hint="Requests simultáneas de cada carril (igual para ambos). El total no pasa de 6 por el límite de conexiones del navegador.">
        <SegmentedControl
          label="Concurrencia por carril"
          value={config.concurrency}
          disabled={!canConfigure}
          onChange={(concurrency) => setConfig({ concurrency })}
          options={CONCURRENCY_OPTIONS.map((n) => ({ value: n, label: String(n) }))}
        />
      </Field>

      <Field as="div" label="Repeticiones" hint="Veces que se clasifica cada concepto. Con más de una se mide la consistencia entre repeticiones.">
        <SegmentedControl
          label="Repeticiones"
          value={config.repetitions}
          disabled={!canConfigure}
          onChange={(repetitions) => setConfig({ repetitions })}
          options={REPETITION_OPTIONS.map((n) => ({ value: n, label: String(n) }))}
        />
      </Field>

      <Field label="Timeout (s)" hint="Tiempo máximo por clasificación, igual para ambos carriles. Al vencer cuenta como timeout (fallo).">
        <NumberField
          className="w-20"
          value={config.timeoutMs / 1000}
          min={BENCH_LIMITS.minTimeoutMs / 1000}
          max={BENCH_LIMITS.maxTimeoutMs / 1000}
          disabled={!canConfigure}
          onCommit={(seconds) => seconds !== undefined && setConfig({ timeoutMs: seconds * 1000 })}
        />
      </Field>
    </div>
  )
}

const MODE_TEXT: Record<EngineMode, string> = { live: 'Live', mock: 'Simulado' }

function LaneConfig({ engine }: { engine: EngineId }) {
  const mode = useBench((s) => s.lanes[engine].mode)
  const live = useBench((s) => selectLiveAvailable(s, engine))
  const canConfigure = useBench(selectCanConfigure)
  const setLaneMode = useBench((s) => s.setLaneMode)
  const theme = ENGINE_THEME[engine]

  return (
    <Field
      as="div"
      className="min-w-0"
      label={
        <>
          <span aria-hidden className={clsx('size-2 rounded-full', theme.solid)} />
          <span className={clsx('font-semibold', theme.text)}>{theme.label}</span>
          <span>· modo y modelo</span>
        </>
      }
    >
      <span className="flex min-w-0 items-center gap-2">
        <SegmentedControl<EngineMode>
          label={`Modo de ${theme.label}`}
          value={mode}
          disabled={!canConfigure}
          onChange={(m) => setLaneMode(engine, m)}
          options={[
            {
              value: 'live',
              label: MODE_TEXT.live,
              disabled: !live,
              title: live ? 'Llamadas reales al modelo a través del backend.' : LIVE_UNAVAILABLE_HINT[engine],
              activeClass: 'bg-green-600 font-semibold text-white dark:bg-green-500 dark:text-zinc-950',
            },
            {
              value: 'mock',
              label: MODE_TEXT.mock,
              title: 'Motor local con parámetros ilustrativos: no mide al modelo real.',
              activeClass: 'bg-amber-400 font-semibold text-zinc-900 dark:bg-amber-500',
            },
          ]}
        />
        <ModelPicker engine={engine} />
      </span>
    </Field>
  )
}

/** Run configuration, per-lane mode / model and the run buttons. Locked while a run is in flight. */
export function ControlBar() {
  const canConfigure = useBench(selectCanConfigure)
  const status = useBench((s) => s.status)
  const failed = useBench(selectFailedCount)
  const dataset = useBench(selectActiveDataset)
  const config = useBench((s) => s.config)
  const start = useBench((s) => s.start)
  const stop = useBench((s) => s.stop)
  const reset = useBench((s) => s.reset)
  const rerunFailed = useBench((s) => s.rerunFailed)
  const hasRun = useBench((s) => s.run !== null)
  const error = useBench((s) => s.error)

  const plan = useMemo(() => {
    if (!dataset) return null
    const items = selectPlanItems(dataset, config).length
    return { items, perLane: items * config.repetitions }
  }, [dataset, config])

  return (
    <section aria-label="Controles del benchmark" className={clsx(UI.card, 'space-y-3 p-3.5 sm:p-4')}>
      <SettingsRow />

      <div className="grid gap-x-4 gap-y-3 md:grid-cols-2">
        {ENGINE_IDS.map((id) => (
          <LaneConfig key={id} engine={id} />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-3.5 dark:border-zinc-800">
        <ActionButton variant="primary" className="min-w-24" disabled={!canConfigure || !dataset} onClick={start}>
          <span aria-hidden>▶</span> {status === 'idle' ? 'Iniciar' : 'Iniciar de nuevo'}
        </ActionButton>
        <ActionButton variant="danger" disabled={canConfigure} onClick={stop}>
          <span aria-hidden>■</span> Detener
        </ActionButton>
        <ActionButton disabled={!canConfigure || (!hasRun && status === 'idle')} onClick={reset}>
          <span aria-hidden>↺</span> Reiniciar
        </ActionButton>
        <ActionButton
          disabled={!canConfigure || failed === 0}
          onClick={rerunFailed}
          title="Vuelve a clasificar solo los conceptos con error, timeout o respuesta inválida"
        >
          <span aria-hidden>⟳</span> Reintentar fallidos ({failed})
        </ActionButton>
        <span className="ml-auto min-w-0 text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
          {!canConfigure
            ? 'La configuración se bloquea mientras corre el benchmark.'
            : plan
              ? `${plan.items} concepto${plan.items === 1 ? '' : 's'} × ${config.repetitions} = ${plan.perLane} clasificaciones por carril (${plan.perLane * ENGINE_IDS.length} llamadas)`
              : 'Selecciona un dataset'}
        </span>
      </div>

      {error && (
        <p role="alert" className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </p>
      )}
    </section>
  )
}
