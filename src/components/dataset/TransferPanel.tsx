/**
 * Import (file or pasted text: full JSON, or CSV of concepts with the selected dataset's categories or
 * a separate categories CSV) and export (JSON, CSV of concepts / categories, empty templates).
 * Importing is two steps: «Validar» builds a plan and lists row errors / warnings, «Importar» saves it.
 */
import { useState, type ChangeEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import type { Dataset } from '../../shared/contracts.ts'
import { categoriesToCsv, datasetToJson, itemsToCsv } from '../../data/importDataset.ts'
import { selectActiveDataset, useBench } from '../../bench/useBench.ts'
import { UI } from '../ui/theme.ts'
import { downloadText, fileStem } from './download.ts'
import { Field, MessageList, Notice, Section } from './fields.tsx'
import {
  DEFAULT_IMPORT_NAME,
  categoriesTemplateCsv,
  itemsTemplateCsv,
  planItemsImport,
  planJsonImport,
  type ImportPlanOk,
} from './importFlow.ts'
import { buttonClass, inputClass, primaryButtonClass } from './styles.ts'

type ImportKind = 'json' | 'items'
type CategorySource = 'dataset' | 'csv'
type Target = 'new' | 'append'

type Outcome =
  | { kind: 'idle' }
  | { kind: 'invalid'; errors: string[] }
  | { kind: 'ready'; plan: ImportPlanOk }
  | { kind: 'saved'; message: string; warnings: string[] }

const MAX_FILE_BYTES = 5_000_000

interface Props {
  /** Dataset shown in the manager (saved or working copy): what gets exported. */
  dataset: Dataset
  /** Why importing is blocked (benchmark running, unsaved changes), or null. */
  blockedReason: string | null
}

function Radio({
  name,
  checked,
  disabled,
  onChange,
  children,
}: {
  name: string
  checked: boolean
  disabled?: boolean
  onChange: () => void
  children: ReactNode
}) {
  return (
    <label className={clsx('flex items-start gap-2 text-sm', disabled && 'opacity-50')}>
      <input type="radio" name={name} className="mt-1" checked={checked} disabled={disabled} onChange={onChange} />
      <span>{children}</span>
    </label>
  )
}

export default function TransferPanel({ dataset, blockedReason }: Props) {
  const datasets = useBench((s) => s.datasets)
  const active = useBench(selectActiveDataset)
  const upsertCustomDataset = useBench((s) => s.upsertCustomDataset)
  const selectDataset = useBench((s) => s.selectDataset)

  const [kind, setKind] = useState<ImportKind>('json')
  const [categorySource, setCategorySource] = useState<CategorySource>('dataset')
  const [target, setTarget] = useState<Target>('new')
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [categoriesText, setCategoriesText] = useState('')
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' })

  const blocked = blockedReason !== null
  const activeIsCustom = active?.source === 'custom'
  const usesCategoriesCsv = kind === 'items' && categorySource === 'csv'
  const canAppend = kind === 'items' && !usesCategoriesCsv && activeIsCustom
  const effectiveTarget: Target = canAppend ? target : 'new'
  const idle = (): void => setOutcome({ kind: 'idle' })

  const readFile = async (event: ChangeEvent<HTMLInputElement>, setter: (value: string) => void): Promise<void> => {
    const input = event.target
    const file = input.files?.[0]
    if (file === undefined) return
    if (file.size > MAX_FILE_BYTES) {
      setOutcome({ kind: 'invalid', errors: [`«${file.name}» pesa más de ${MAX_FILE_BYTES / 1_000_000} MB: es demasiado grande para importarlo.`] })
    } else {
      try {
        setter(await file.text())
        idle()
      } catch {
        setOutcome({ kind: 'invalid', errors: [`No se pudo leer «${file.name}».`] })
      }
    }
    input.value = '' // allow picking the same file again
  }

  const validate = (): void => {
    if (text.trim() === '') {
      setOutcome({ kind: 'invalid', errors: ['Pega el contenido o elige un archivo primero.'] })
      return
    }
    const takenIds = datasets.map((d) => d.id)
    if (kind === 'json') {
      const plan = planJsonImport(text, takenIds)
      setOutcome(plan.ok ? { kind: 'ready', plan } : { kind: 'invalid', errors: plan.errors })
      return
    }
    if (usesCategoriesCsv && categoriesText.trim() === '') {
      setOutcome({ kind: 'invalid', errors: ['Pega el CSV de categorías o elige un archivo.'] })
      return
    }
    const plan = planItemsImport({
      itemsText: text,
      ...(usesCategoriesCsv ? { categoriesText } : {}),
      baseTask: dataset.task,
      name,
      takenIds,
      ...(effectiveTarget === 'append' && active !== undefined ? { appendTo: active } : {}),
    })
    setOutcome(plan.ok ? { kind: 'ready', plan } : { kind: 'invalid', errors: plan.errors })
  }

  const commit = (plan: ImportPlanOk): void => {
    const result = upsertCustomDataset(plan.dataset)
    if (!result.ok) {
      setOutcome({ kind: 'invalid', errors: result.errors })
      return
    }
    selectDataset(result.value.id)
    setText('')
    setCategoriesText('')
    const what = plan.mode === 'append' ? `Se agregaron ${plan.itemCount} conceptos a «${result.value.name}».` : `Dataset «${result.value.name}» importado: ${plan.dataset.task.categories.length} categorías y ${plan.itemCount} conceptos. Ya está seleccionado.`
    setOutcome({ kind: 'saved', message: what, warnings: plan.warnings })
  }

  const stem = fileStem(dataset.id)

  return (
    <Section
      id="dataset-transfer-title"
      title="Importar y exportar"
      description="Trae un dataset completo (JSON) o solo conceptos (CSV), o descarga el dataset que estás viendo."
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {/* ── Import ── */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Importar</h3>
          {blockedReason ? <Notice tone="warn">{blockedReason}</Notice> : null}
          <fieldset className="space-y-1.5" disabled={blocked}>
            <legend className={UI.label}>Qué importas</legend>
            <Radio name="import-kind" checked={kind === 'json'} onChange={() => { setKind('json'); idle() }}>
              Dataset completo (JSON): tarea, categorías y conceptos
            </Radio>
            <Radio name="import-kind" checked={kind === 'items'} onChange={() => { setKind('items'); idle() }}>
              Conceptos (CSV): una fila por línea de factura
            </Radio>
          </fieldset>

          {kind === 'items' ? (
            <>
              <fieldset className="space-y-1.5" disabled={blocked}>
                <legend className={UI.label}>Categorías</legend>
                <Radio name="import-cats" checked={categorySource === 'dataset'} onChange={() => { setCategorySource('dataset'); idle() }}>
                  Las del dataset seleccionado ({dataset.task.categories.length}) y su tarea
                </Radio>
                <Radio name="import-cats" checked={categorySource === 'csv'} onChange={() => { setCategorySource('csv'); idle() }}>
                  Importar un CSV de categorías aparte (con las instrucciones por defecto)
                </Radio>
              </fieldset>
              <fieldset className="space-y-1.5" disabled={blocked}>
                <legend className={UI.label}>Destino</legend>
                <Radio name="import-target" checked={effectiveTarget === 'new'} onChange={() => { setTarget('new'); idle() }}>
                  Crear un dataset nuevo
                </Radio>
                <Radio name="import-target" checked={effectiveTarget === 'append'} disabled={!canAppend} onChange={() => { setTarget('append'); idle() }}>
                  Agregar al dataset personalizado seleccionado
                  {!canAppend ? <span className={clsx('block text-xs', UI.muted)}>Requiere un dataset personalizado y sus categorías.</span> : null}
                </Radio>
              </fieldset>
              {effectiveTarget === 'new' ? (
                <Field label="Nombre del dataset nuevo">
                  <input
                    className={inputClass}
                    value={name}
                    placeholder={DEFAULT_IMPORT_NAME}
                    disabled={blocked}
                    onChange={(e) => { setName(e.target.value); idle() }}
                  />
                </Field>
              ) : null}
            </>
          ) : null}

          <Field
            label={kind === 'json' ? 'Contenido JSON' : 'CSV de conceptos'}
            hint={kind === 'items' ? 'Columnas: concepto y esperado son obligatorias; id, proveedor, valor, moneda, notas, dificultad y justificación son opcionales.' : undefined}
          >
            <textarea
              className={clsx(inputClass, 'font-mono text-xs')}
              rows={7}
              spellCheck={false}
              value={text}
              disabled={blocked}
              placeholder={kind === 'json' ? '{ "name": "…", "task": { … }, "items": [ … ] }' : 'concepto,proveedor,valor,esperado\nServicio de energía,Enel,150000,513530'}
              onChange={(e) => { setText(e.target.value); idle() }}
            />
          </Field>
          <Field label="…o elige un archivo">
            <input
              type="file"
              className={clsx(inputClass, 'file:mr-3 file:rounded file:border-0 file:bg-zinc-100 file:px-2 file:py-1 file:text-xs dark:file:bg-zinc-800')}
              accept={kind === 'json' ? '.json,application/json' : '.csv,.txt,text/csv,text/plain'}
              disabled={blocked}
              onChange={(e) => void readFile(e, setText)}
            />
          </Field>

          {usesCategoriesCsv ? (
            <>
              <Field label="CSV de categorías" hint="Columnas: id (o código) y nombre son obligatorias; descripción (criterio) y grupo son opcionales.">
                <textarea
                  className={clsx(inputClass, 'font-mono text-xs')}
                  rows={5}
                  spellCheck={false}
                  value={categoriesText}
                  disabled={blocked}
                  placeholder={'id,nombre,descripcion,grupo\n513530,Energía eléctrica,Consumo de energía,5135 Servicios'}
                  onChange={(e) => { setCategoriesText(e.target.value); idle() }}
                />
              </Field>
              <Field label="…o elige un archivo de categorías">
                <input
                  type="file"
                  className={clsx(inputClass, 'file:mr-3 file:rounded file:border-0 file:bg-zinc-100 file:px-2 file:py-1 file:text-xs dark:file:bg-zinc-800')}
                  accept=".csv,.txt,text/csv,text/plain"
                  disabled={blocked}
                  onChange={(e) => void readFile(e, setCategoriesText)}
                />
              </Field>
            </>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} disabled={blocked} onClick={validate}>
              Validar
            </button>
            {outcome.kind === 'ready' ? (
              <button type="button" className={primaryButtonClass} disabled={blocked} onClick={() => commit(outcome.plan)}>
                {outcome.plan.mode === 'append' ? `Agregar ${outcome.plan.itemCount} conceptos` : 'Importar como dataset nuevo'}
              </button>
            ) : null}
          </div>

          {outcome.kind === 'invalid' ? (
            <Notice tone="error">
              <p className="font-medium">No se pudo importar ({outcome.errors.length === 1 ? '1 problema' : `${outcome.errors.length} problemas`}):</p>
              <MessageList messages={outcome.errors} className="mt-1 max-h-56 overflow-auto" />
            </Notice>
          ) : null}
          {outcome.kind === 'ready' ? (
            <Notice tone="success">
              <p className="font-medium">
                Válido: {outcome.plan.dataset.task.categories.length} categorías y {outcome.plan.itemCount} conceptos
                {outcome.plan.mode === 'append' ? ' para agregar.' : ` para el dataset nuevo «${outcome.plan.dataset.name}».`}
              </p>
              {outcome.plan.warnings.length > 0 ? <MessageList messages={outcome.plan.warnings} className="mt-1 max-h-40 overflow-auto" /> : null}
              <p className="mt-1">Revisa y pulsa el botón para guardarlo en este navegador.</p>
            </Notice>
          ) : null}
          {outcome.kind === 'saved' ? (
            <Notice tone="success">
              <p className="font-medium">{outcome.message}</p>
              {outcome.warnings.length > 0 ? <MessageList messages={outcome.warnings} className="mt-1 max-h-40 overflow-auto" /> : null}
            </Notice>
          ) : null}
        </div>

        {/* ── Export ── */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Exportar</h3>
          <p className={clsx('text-sm', UI.muted)}>
            Descarga «{dataset.name}» (con la etiqueta esperada y la justificación: el archivo es para ti, no para los modelos).
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} onClick={() => downloadText(`${stem}.json`, datasetToJson(dataset), 'json')}>
              Dataset (JSON)
            </button>
            <button type="button" className={buttonClass} onClick={() => downloadText(`${stem}-conceptos.csv`, itemsToCsv(dataset.items), 'csv')}>
              Conceptos (CSV)
            </button>
            <button type="button" className={buttonClass} onClick={() => downloadText(`${stem}-categorias.csv`, categoriesToCsv(dataset.task.categories), 'csv')}>
              Categorías (CSV)
            </button>
          </div>
          <h3 className="pt-2 text-sm font-semibold">Plantillas CSV</h3>
          <p className={clsx('text-sm', UI.muted)}>Un encabezado y una fila de ejemplo para llenar y volver a importar.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} onClick={() => downloadText('plantilla-conceptos.csv', itemsTemplateCsv(dataset.task.categories), 'csv')}>
              Plantilla de conceptos
            </button>
            <button type="button" className={buttonClass} onClick={() => downloadText('plantilla-categorias.csv', categoriesTemplateCsv(), 'csv')}>
              Plantilla de categorías
            </button>
          </div>
        </div>
      </div>
    </Section>
  )
}
