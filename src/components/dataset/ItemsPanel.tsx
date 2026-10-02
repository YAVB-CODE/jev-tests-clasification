/** Item table with search + filters, expandable rationale and simple add / edit / remove forms for custom datasets. */
import { Fragment, useMemo, useState } from 'react'
import clsx from 'clsx'
import { DIFFICULTIES, type Difficulty } from '../../shared/contracts.ts'
import { LIMITS, serializeConcept } from '../../shared/task.ts'
import { UI } from '../ui/theme.ts'
import {
  applyItem,
  buildItem,
  emptyItemForm,
  itemToForm,
  removeItem,
  type ItemFormValues,
} from './datasetEdit.ts'
import {
  DIFFICULTY_LABELS,
  EMPTY_FILTER,
  categoryLabel,
  filterItems,
  formatAmount,
  type DifficultyFilter,
  type ItemFilter,
} from './datasetView.ts'
import { Field, MessageList, Notice, Section } from './fields.tsx'
import type { PanelProps } from './panelTypes.ts'
import { buttonClass, inputClass, linkButtonClass, linkDangerClass, primaryButtonClass } from './styles.ts'

const PAGE_SIZE = 50

const DIFFICULTY_STYLE: Record<Difficulty, string> = {
  easy: 'bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300',
  medium: 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
  hard: 'bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300',
}

function DifficultyBadge({ difficulty }: { difficulty: Difficulty | undefined }) {
  if (difficulty === undefined) return <span className={clsx('text-xs', UI.muted)}>—</span>
  return <span className={clsx(UI.badge, DIFFICULTY_STYLE[difficulty])}>{DIFFICULTY_LABELS[difficulty]}</span>
}

interface FormState {
  /** Item being edited; null = new. */
  editingId: string | null
  values: ItemFormValues
}

export default function ItemsPanel({ dataset, editable, onChange }: PanelProps) {
  const { items } = dataset
  const { categories } = dataset.task
  const [filter, setFilter] = useState<ItemFilter>({ ...EMPTY_FILTER })
  const [visible, setVisible] = useState(PAGE_SIZE)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [form, setForm] = useState<FormState | null>(null)
  const [formErrors, setFormErrors] = useState<string[]>([])
  const [flash, setFlash] = useState<string | null>(null)

  const nameById = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories])
  const filtered = useMemo(() => filterItems(items, categories, filter), [items, categories, filter])
  const shownItems = filtered.slice(0, visible)
  const shownForm = editable ? form : null
  const filtering = filter.query.trim() !== '' || filter.difficulty !== 'all' || filter.category !== ''
  const columns = editable ? 7 : 6

  const updateFilter = (patch: Partial<ItemFilter>): void => {
    setFilter((prev) => ({ ...prev, ...patch }))
    setVisible(PAGE_SIZE)
  }

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const closeForm = (): void => {
    setForm(null)
    setFormErrors([])
  }

  const submit = (): void => {
    if (form === null || !editable) return
    const built = buildItem(form.values, items, categories, form.editingId)
    if (!built.ok) {
      setFormErrors(built.errors)
      return
    }
    onChange((d) => applyItem(d, built.value, form.editingId))
    if (form.editingId === null) {
      // Show the new item (it goes last): clear the filters and widen the page.
      setFilter({ ...EMPTY_FILTER })
      setVisible(items.length + 1)
      setFlash(`Concepto ${built.value.id} agregado al final de la lista.`)
    } else {
      setFlash(`Concepto ${built.value.id} actualizado.`)
    }
    closeForm()
  }

  const setField = <K extends keyof ItemFormValues>(key: K, value: ItemFormValues[K]): void => {
    setForm((prev) => (prev === null ? prev : { ...prev, values: { ...prev.values, [key]: value } }))
  }

  return (
    <Section
      id="dataset-items-title"
      title={`Conceptos (${items.length})`}
      description="Líneas de factura con su respuesta correcta. La categoría esperada, la dificultad y la justificación solo viven en tu navegador: nunca se envían a los modelos ni al servidor."
      actions={
        editable ? (
          <button
            type="button"
            className={buttonClass}
            disabled={shownForm !== null || categories.length === 0}
            onClick={() => {
              setFlash(null)
              setFormErrors([])
              setForm({ editingId: null, values: emptyItemForm(items, filter.category) })
            }}
          >
            + Agregar concepto
          </button>
        ) : null
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.5fr)]">
        <Field label="Buscar">
          <input
            type="search"
            className={inputClass}
            placeholder="Concepto, proveedor, notas, código…"
            value={filter.query}
            onChange={(e) => updateFilter({ query: e.target.value })}
          />
        </Field>
        <Field label="Dificultad">
          <select className={inputClass} value={filter.difficulty} onChange={(e) => updateFilter({ difficulty: e.target.value as DifficultyFilter })}>
            <option value="all">Todas</option>
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d}>
                {DIFFICULTY_LABELS[d]}
              </option>
            ))}
            <option value="unset">Sin definir</option>
          </select>
        </Field>
        <Field label="Categoría esperada">
          <select className={inputClass} value={filter.category} onChange={(e) => updateFilter({ category: e.target.value })}>
            <option value="">Todas</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id} · {c.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={clsx('text-sm', UI.muted)} aria-live="polite">
          {filtering ? `${filtered.length} de ${items.length} conceptos` : `${items.length} conceptos`}
        </p>
        {filtering ? (
          <button type="button" className={linkButtonClass} onClick={() => updateFilter({ ...EMPTY_FILTER })}>
            Quitar filtros
          </button>
        ) : null}
      </div>

      {flash ? <Notice tone="success">{flash}</Notice> : null}

      {shownForm !== null ? (
        <form
          className="space-y-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/50"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          aria-label={shownForm.editingId === null ? 'Nuevo concepto' : `Editar concepto ${shownForm.editingId}`}
        >
          <h3 className="text-sm font-semibold">{shownForm.editingId === null ? 'Nuevo concepto' : `Editar concepto ${shownForm.editingId}`}</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Concepto" required className="sm:col-span-2 lg:col-span-3" hint="Texto de la línea de factura (lo ven los modelos).">
              <textarea className={inputClass} rows={2} value={shownForm.values.concept} maxLength={LIMITS.conceptLength} onChange={(e) => setField('concept', e.target.value)} />
            </Field>
            <Field label="Proveedor" hint="Opcional (lo ven los modelos).">
              <input className={inputClass} value={shownForm.values.supplier} maxLength={LIMITS.supplierLength} onChange={(e) => setField('supplier', e.target.value)} />
            </Field>
            <Field label="Valor" hint="Ej.: 1.234.567 o 1234567,50. Opcional (lo ven los modelos).">
              <input className={inputClass} inputMode="decimal" value={shownForm.values.amount} onChange={(e) => setField('amount', e.target.value)} />
            </Field>
            <Field label="Moneda">
              <input className={inputClass} value={shownForm.values.currency} maxLength={LIMITS.currencyLength} onChange={(e) => setField('currency', e.target.value)} />
            </Field>
            <Field label="Notas" className="sm:col-span-2 lg:col-span-3" hint="Contexto adicional de la factura. Opcional (lo ven los modelos).">
              <input className={inputClass} value={shownForm.values.notes} maxLength={LIMITS.textLength} onChange={(e) => setField('notes', e.target.value)} />
            </Field>
            <Field label="Categoría esperada" required hint="Solo local: nunca se envía.">
              <select className={inputClass} value={shownForm.values.expected} onChange={(e) => setField('expected', e.target.value)}>
                <option value="">Elige una categoría…</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id} · {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Dificultad" hint="Solo local.">
              <select className={inputClass} value={shownForm.values.difficulty} onChange={(e) => setField('difficulty', e.target.value as ItemFormValues['difficulty'])}>
                <option value="">Sin definir</option>
                {DIFFICULTIES.map((d) => (
                  <option key={d} value={d}>
                    {DIFFICULTY_LABELS[d]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Id" required hint="Identificador interno (no se envía).">
              <input
                className={clsx(inputClass, 'font-mono')}
                value={shownForm.values.id}
                maxLength={LIMITS.itemIdLength}
                readOnly={shownForm.editingId !== null}
                onChange={(e) => setField('id', e.target.value)}
              />
            </Field>
            <Field label="Justificación" className="sm:col-span-2 lg:col-span-3" hint="Por qué es esa la categoría correcta. Solo local: nunca se envía.">
              <textarea className={inputClass} rows={2} value={shownForm.values.rationale} maxLength={LIMITS.textLength} onChange={(e) => setField('rationale', e.target.value)} />
            </Field>
          </div>
          {formErrors.length > 0 ? (
            <Notice tone="error">
              <MessageList messages={formErrors} />
            </Notice>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={primaryButtonClass}>
              {shownForm.editingId === null ? 'Agregar' : 'Aplicar cambios'}
            </button>
            <button type="button" className={buttonClass} onClick={closeForm}>
              Cancelar
            </button>
          </div>
        </form>
      ) : null}

      <div className="relative overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full min-w-[56rem] border-collapse text-left text-sm">
          <caption className="sr-only">Conceptos del dataset</caption>
          <thead className="bg-zinc-50 dark:bg-zinc-950/50">
            <tr className={clsx('border-b border-zinc-200 dark:border-zinc-800', UI.label)}>
              <th scope="col" className="px-3 py-2">Concepto</th>
              <th scope="col" className="px-3 py-2">Proveedor</th>
              <th scope="col" className="px-3 py-2 text-right">Valor</th>
              <th scope="col" className="px-3 py-2">Esperado</th>
              <th scope="col" className="px-3 py-2">Dificultad</th>
              <th scope="col" className="px-3 py-2">Justificación</th>
              {editable ? <th scope="col" className="px-3 py-2"><span className="sr-only">Acciones</span></th> : null}
            </tr>
          </thead>
          <tbody>
            {shownItems.length === 0 ? (
              <tr>
                <td colSpan={columns} className={clsx('px-3 py-6 text-center text-sm', UI.muted)}>
                  {filtering ? 'Ningún concepto coincide con la búsqueda o los filtros.' : 'Este dataset aún no tiene conceptos.'}
                </td>
              </tr>
            ) : null}
            {shownItems.map((item) => {
              const open = expanded.has(item.id)
              const detailId = `item-detail-${item.id}`
              return (
                <Fragment key={item.id}>
                  <tr className={clsx('align-top', !open && 'border-b border-zinc-100 dark:border-zinc-800/60')}>
                    <td className="max-w-sm px-3 py-2">
                      <p className="break-words">{item.concept}</p>
                      <p className={clsx('mt-0.5 font-mono text-[11px]', UI.muted)}>{item.id}</p>
                    </td>
                    <td className={clsx('px-3 py-2 text-xs', UI.muted)}>{item.supplier ?? '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{formatAmount(item.amount, item.currency)}</td>
                    <td className="px-3 py-2 text-xs">
                      <span className="font-mono font-medium">{item.expected}</span>
                      <span className={clsx('block', UI.muted)}>{nameById.get(item.expected) ?? 'Categoría inexistente'}</span>
                    </td>
                    <td className="px-3 py-2">
                      <DifficultyBadge difficulty={item.difficulty} />
                    </td>
                    <td className="px-3 py-2">
                      <button type="button" className={linkButtonClass} aria-expanded={open} aria-controls={detailId} onClick={() => toggle(item.id)}>
                        {open ? '▾ Ocultar' : '▸ Ver'}
                      </button>
                    </td>
                    {editable ? (
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        <button
                          type="button"
                          className={linkButtonClass}
                          aria-label={`Editar concepto ${item.id}`}
                          onClick={() => {
                            setFlash(null)
                            setFormErrors([])
                            setForm({ editingId: item.id, values: itemToForm(item) })
                          }}
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          className={linkDangerClass}
                          aria-label={`Eliminar concepto ${item.id}`}
                          onClick={() => {
                            onChange((d) => removeItem(d, item.id))
                            setFlash(`Concepto ${item.id} eliminado.`)
                          }}
                        >
                          Eliminar
                        </button>
                      </td>
                    ) : null}
                  </tr>
                  {open ? (
                    <tr id={detailId} className="border-b border-zinc-100 bg-zinc-50/70 dark:border-zinc-800/60 dark:bg-zinc-950/40">
                      <td colSpan={columns} className="px-3 py-3">
                        <div className="grid gap-3 text-xs md:grid-cols-2">
                          <div className="space-y-2">
                            <div>
                              <h4 className={UI.label}>Justificación (solo local)</h4>
                              <p className="mt-1 whitespace-pre-wrap break-words text-sm">{item.rationale ?? 'Sin justificación.'}</p>
                            </div>
                            <p className={UI.muted}>
                              Esperado: <span className="font-medium text-zinc-900 dark:text-zinc-100">{categoryLabel(categories, item.expected)}</span>
                              {item.difficulty ? ` · Dificultad: ${DIFFICULTY_LABELS[item.difficulty]}` : ''}
                            </p>
                          </div>
                          <div>
                            <h4 className={UI.label}>Lo que reciben los modelos</h4>
                            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-zinc-200 bg-white p-2 font-mono text-[11px] dark:border-zinc-800 dark:bg-zinc-900">
                              {JSON.stringify(serializeConcept(item), null, 2)}
                            </pre>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>

      {filtered.length > shownItems.length ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={clsx('text-sm', UI.muted)}>
            Mostrando {shownItems.length} de {filtered.length}
          </p>
          <button type="button" className={buttonClass} onClick={() => setVisible((v) => v + PAGE_SIZE)}>
            Mostrar más ({Math.min(PAGE_SIZE, filtered.length - shownItems.length)})
          </button>
        </div>
      ) : null}
    </Section>
  )
}
