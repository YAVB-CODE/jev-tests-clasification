/**
 * Dataset manager: pick the active dataset, see its task / categories / items, edit custom datasets
 * (the included one is read-only: duplicate it first), import and export. Reads the bench store.
 *
 * Editing works on a local working copy (`draft`) that is only saved with «Guardar cambios»
 * (`upsertCustomDataset` validates and persists). While the copy has unsaved changes the dataset
 * cannot be switched, duplicated, deleted or imported over, so the copy always matches one dataset.
 */
import { useMemo, useState } from 'react'
import clsx from 'clsx'
import type { Dataset } from '../../shared/contracts.ts'
import { selectActiveDataset, selectCanConfigure, useBench } from '../../bench/useBench.ts'
import { UI } from '../ui/theme.ts'
import CategoriesPanel from './CategoriesPanel.tsx'
import ItemsPanel from './ItemsPanel.tsx'
import TaskPanel from './TaskPanel.tsx'
import TransferPanel from './TransferPanel.tsx'
import { duplicateDataset } from './datasetEdit.ts'
import { DIFFICULTY_LABELS, summarizeDataset, type DifficultyCounts } from './datasetView.ts'
import { Field, MessageList, Notice } from './fields.tsx'
import { buttonClass, dangerButtonClass, inputClass, primaryButtonClass } from './styles.ts'

interface Draft {
  /** Dataset the copy was made from. */
  baseId: string
  dataset: Dataset
}

interface Message {
  forId: string
  text: string
}

const SEGMENTS: ReadonlyArray<{ key: keyof DifficultyCounts; label: string; bar: string }> = [
  { key: 'easy', label: DIFFICULTY_LABELS.easy, bar: 'bg-sky-500' },
  { key: 'medium', label: DIFFICULTY_LABELS.medium, bar: 'bg-amber-500' },
  { key: 'hard', label: DIFFICULTY_LABELS.hard, bar: 'bg-orange-500' },
  { key: 'unset', label: 'Sin definir', bar: 'bg-zinc-300 dark:bg-zinc-600' },
]

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
      <p className="text-lg font-semibold tabular-nums leading-tight">{value}</p>
      <p className={clsx('text-xs', UI.muted)}>{label}</p>
    </div>
  )
}

function DifficultyDistribution({ counts, total }: { counts: DifficultyCounts; total: number }) {
  const present = SEGMENTS.filter((s) => counts[s.key] > 0)
  const summary = present.map((s) => `${s.label}: ${counts[s.key]}`).join(', ')
  return (
    <div className="min-w-0 flex-1 basis-56">
      <p className={UI.label}>Distribución por dificultad</p>
      {total > 0 ? (
        <>
          <div role="img" aria-label={summary} className="mt-1.5 flex h-2.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            {present.map((s) => (
              <div key={s.key} className={s.bar} style={{ width: `${(counts[s.key] / total) * 100}%` }} />
            ))}
          </div>
          <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
            {present.map((s) => (
              <li key={s.key} className="inline-flex items-center gap-1">
                <span aria-hidden="true" className={clsx('h-2 w-2 rounded-full', s.bar)} />
                {s.label} <span className="tabular-nums">{counts[s.key]}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className={clsx('mt-1 text-sm', UI.muted)}>Sin conceptos.</p>
      )}
    </div>
  )
}

export default function DatasetManager() {
  const datasets = useBench((s) => s.datasets)
  const active = useBench(selectActiveDataset)
  const canConfigure = useBench(selectCanConfigure)
  const selectDataset = useBench((s) => s.selectDataset)
  const upsertCustomDataset = useBench((s) => s.upsertCustomDataset)
  const deleteCustomDataset = useBench((s) => s.deleteCustomDataset)

  const [draft, setDraft] = useState<Draft | null>(null)
  const [saveErrors, setSaveErrors] = useState<string[]>([])
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  // Reset transient UI when the active dataset changes (it can change from elsewhere in the app too).
  const activeId = active?.id ?? null
  const [seenId, setSeenId] = useState(activeId)
  if (seenId !== activeId) {
    setSeenId(activeId)
    setConfirmDelete(false)
    setSaveErrors([])
    setMessage((m) => (m !== null && m.forId === activeId ? m : null))
    setDraft((d) => (d !== null && d.baseId === activeId ? d : null))
  }

  const dirty = draft !== null && draft.baseId === activeId
  const working: Dataset | undefined = dirty ? draft.dataset : active
  const summary = useMemo(() => (working ? summarizeDataset(working) : null), [working])

  if (active === undefined || working === undefined || summary === null) {
    return (
      <Notice tone="warn">
        No hay un dataset seleccionado. Importa uno o elige uno de la lista.
      </Notice>
    )
  }

  const isCustom = active.source === 'custom'
  const editable = isCustom && canConfigure
  const seeds = datasets.filter((d) => d.source !== 'custom')
  const customs = datasets.filter((d) => d.source === 'custom')
  const lockSwitch = !canConfigure || dirty

  const update = (change: (dataset: Dataset) => Dataset): void => {
    setDraft({ baseId: active.id, dataset: change(working) })
    setMessage(null)
  }

  const save = (): void => {
    const result = upsertCustomDataset(working)
    if (result.ok) {
      setDraft(null)
      setSaveErrors([])
      setMessage({ forId: result.value.id, text: 'Cambios guardados en este navegador.' })
    } else {
      setSaveErrors(result.errors)
    }
  }

  const discard = (): void => {
    setDraft(null)
    setSaveErrors([])
  }

  const duplicate = (): void => {
    const copy = duplicateDataset(working, datasets.map((d) => d.id))
    const result = upsertCustomDataset(copy)
    if (!result.ok) {
      setSaveErrors(result.errors)
      return
    }
    setSaveErrors([])
    setMessage({ forId: result.value.id, text: `Copia creada: «${result.value.name}». Ya puedes editarla.` })
    selectDataset(result.value.id)
  }

  const remove = (): void => {
    setConfirmDelete(false)
    deleteCustomDataset(active.id)
  }

  const blockedReason = !canConfigure
    ? 'Hay una corrida en curso: no se puede importar hasta que termine.'
    : dirty
      ? 'Guarda o descarta los cambios pendientes antes de importar.'
      : null

  return (
    <div className="space-y-4">
      {!canConfigure ? (
        <Notice tone="warn">
          Hay una corrida en curso: el dataset no se puede cambiar, editar, duplicar, eliminar ni importar hasta que termine. Mientras
          tanto puedes explorarlo.
        </Notice>
      ) : null}
      {/* storageWarning (no se pudo guardar en el navegador) lo muestra App.tsx para todas las pestañas. */}

      <section aria-labelledby="dataset-header-title" className={clsx(UI.card, UI.cardPadding, 'space-y-4')}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 flex-1 basis-72">
            <h2 id="dataset-header-title" className="sr-only">
              Dataset activo
            </h2>
            <Field label="Dataset activo" hint={lockSwitch && canConfigure ? 'Guarda o descarta los cambios pendientes para cambiar de dataset.' : undefined}>
              <select className={inputClass} value={active.id} disabled={lockSwitch} onChange={(e) => selectDataset(e.target.value)}>
                {seeds.length > 0 ? (
                  <optgroup label="Incluidos">
                    {seeds.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} · {d.items.length} conceptos
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {customs.length > 0 ? (
                  <optgroup label="Personalizados">
                    {customs.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} · {d.items.length} conceptos
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={isCustom ? buttonClass : primaryButtonClass} disabled={lockSwitch} onClick={duplicate}>
              {isCustom ? 'Duplicar' : 'Duplicar para editar'}
            </button>
            {isCustom ? (
              <button type="button" className={dangerButtonClass} disabled={lockSwitch} onClick={() => setConfirmDelete(true)}>
                Eliminar dataset
              </button>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className={clsx(UI.badge, isCustom ? 'bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300' : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300')}>
            {isCustom ? 'Personalizado' : 'Incluido · solo lectura'}
          </span>
          {working.locale ? <span className={clsx('text-xs', UI.muted)}>{working.locale}</span> : null}
          {working.description ? <span className={clsx('min-w-0 text-sm', UI.muted)}>{working.description}</span> : null}
        </div>

        {!isCustom ? (
          <Notice tone="info">
            Este dataset viene con la app y no se puede editar. Usa «Duplicar para editar» para crear una copia personalizada con la que
            sí puedes cambiar la tarea, las categorías y los conceptos.
          </Notice>
        ) : null}

        {confirmDelete ? (
          <Notice tone="warn">
            <p className="font-medium">
              ¿Eliminar «{active.name}» con sus {active.items.length} conceptos? No se puede deshacer.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className={dangerButtonClass} disabled={!canConfigure} onClick={remove}>
                Sí, eliminar
              </button>
              <button type="button" className={buttonClass} onClick={() => setConfirmDelete(false)}>
                Cancelar
              </button>
            </div>
          </Notice>
        ) : null}

        {message !== null && message.forId === active.id ? <Notice tone="success">{message.text}</Notice> : null}
        {!dirty && saveErrors.length > 0 ? (
          <Notice tone="error">
            <MessageList messages={saveErrors} />
          </Notice>
        ) : null}

        <div className="flex flex-wrap items-stretch gap-3">
          <Stat value={summary.categories} label={summary.categories === 1 ? 'categoría' : 'categorías'} />
          <Stat value={summary.groups} label={summary.groups === 1 ? 'grupo' : 'grupos'} />
          <Stat value={summary.items} label={summary.items === 1 ? 'concepto' : 'conceptos'} />
          <DifficultyDistribution counts={summary.byDifficulty} total={summary.items} />
        </div>
      </section>

      <TaskPanel key={`task-${active.id}`} dataset={working} editable={editable} onChange={update} />
      <CategoriesPanel key={`cats-${active.id}`} dataset={working} editable={editable} onChange={update} />
      <ItemsPanel key={`items-${active.id}`} dataset={working} editable={editable} onChange={update} />
      <TransferPanel dataset={working} blockedReason={blockedReason} />

      {dirty ? (
        <div
          role="region"
          aria-label="Cambios sin guardar"
          className="sticky bottom-3 z-10 space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 shadow-lg dark:border-amber-800 dark:bg-zinc-900"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              Cambios sin guardar en «{working.name}». Guárdalos para que las corridas usen esta versión.
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={primaryButtonClass} disabled={!canConfigure} onClick={save}>
                Guardar cambios
              </button>
              <button type="button" className={buttonClass} onClick={discard}>
                Descartar
              </button>
            </div>
          </div>
          {saveErrors.length > 0 ? (
            <Notice tone="error">
              <p className="font-medium">No se pudo guardar:</p>
              <MessageList messages={saveErrors} className="mt-1 max-h-40 overflow-auto" />
            </Notice>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
