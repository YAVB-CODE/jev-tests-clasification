/** Category table (code, name, group, criterion) with simple add / edit / remove forms for custom datasets. */
import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { LIMITS } from '../../shared/task.ts'
import { UI } from '../ui/theme.ts'
import {
  applyCategory,
  buildCategory,
  categoryRemovalBlocker,
  categoryToForm,
  emptyCategoryForm,
  removeCategory,
  type CategoryFormValues,
} from './datasetEdit.ts'
import { countByCategory } from './datasetView.ts'
import { ExpandableText, Field, MessageList, Notice, Section } from './fields.tsx'
import type { PanelProps } from './panelTypes.ts'
import { buttonClass, inputClass, linkButtonClass, linkDangerClass, primaryButtonClass } from './styles.ts'

interface FormState {
  /** Category being edited; null = new. */
  editingId: string | null
  values: CategoryFormValues
}

export default function CategoriesPanel({ dataset, editable, onChange }: PanelProps) {
  const categories = dataset.task.categories
  const counts = useMemo(() => countByCategory(dataset.items), [dataset.items])
  const [form, setForm] = useState<FormState | null>(null)
  const [formErrors, setFormErrors] = useState<string[]>([])
  const [blocker, setBlocker] = useState<string | null>(null)

  const closeForm = (): void => {
    setForm(null)
    setFormErrors([])
  }

  // The form disappears if editing gets locked (a benchmark started) while it is open.
  const shown = editable ? form : null

  const submit = (): void => {
    if (form === null || !editable) return
    const built = buildCategory(form.values, categories, form.editingId)
    if (!built.ok) {
      setFormErrors(built.errors)
      return
    }
    onChange((d) => applyCategory(d, built.value, form.editingId))
    closeForm()
  }

  const remove = (id: string): void => {
    const reason = categoryRemovalBlocker(dataset, id)
    setBlocker(reason)
    if (reason === null) onChange((d) => removeCategory(d, id))
  }

  const setField = (key: keyof CategoryFormValues, value: string): void => {
    setForm((prev) => (prev === null ? prev : { ...prev, values: { ...prev.values, [key]: value } }))
  }

  return (
    <Section
      id="dataset-categories-title"
      title={`Categorías (${categories.length})`}
      description="Opciones de respuesta, en el orden en que se ofrecen a los modelos. El criterio es lo que cada modelo lee para decidir."
      actions={
        editable ? (
          <button
            type="button"
            className={buttonClass}
            disabled={shown !== null}
            onClick={() => {
              setBlocker(null)
              setForm({ editingId: null, values: emptyCategoryForm() })
            }}
          >
            + Agregar categoría
          </button>
        ) : null
      }
    >
      {blocker ? <Notice tone="warn">{blocker}</Notice> : null}

      {shown !== null ? (
        <form
          className="space-y-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/50"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          aria-label={shown.editingId === null ? 'Nueva categoría' : `Editar categoría ${shown.editingId}`}
        >
          <h3 className="text-sm font-semibold">{shown.editingId === null ? 'Nueva categoría' : `Editar categoría ${shown.editingId}`}</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Código (id)" required hint="Letras, números, «_», «.» y «-». Es la opción que responden los modelos.">
              <input className={clsx(inputClass, 'font-mono')} value={shown.values.id} maxLength={LIMITS.idLength} onChange={(e) => setField('id', e.target.value)} />
            </Field>
            <Field label="Nombre" required>
              <input className={inputClass} value={shown.values.name} maxLength={LIMITS.nameLength} onChange={(e) => setField('name', e.target.value)} />
            </Field>
            <Field label="Grupo" hint="Ej.: «5135 Servicios». Se usa para el acierto por grupo.">
              <input className={inputClass} value={shown.values.group} maxLength={LIMITS.nameLength} onChange={(e) => setField('group', e.target.value)} />
            </Field>
            <Field label="Criterio" className="sm:col-span-2 lg:col-span-3" hint="Cuándo un concepto va en esta categoría (se envía a ambos modelos).">
              <textarea className={inputClass} rows={3} value={shown.values.description} maxLength={LIMITS.textLength} onChange={(e) => setField('description', e.target.value)} />
            </Field>
          </div>
          {formErrors.length > 0 ? (
            <Notice tone="error">
              <MessageList messages={formErrors} />
            </Notice>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={primaryButtonClass}>
              {shown.editingId === null ? 'Agregar' : 'Aplicar cambios'}
            </button>
            <button type="button" className={buttonClass} onClick={closeForm}>
              Cancelar
            </button>
          </div>
        </form>
      ) : null}

      <div className="relative overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
          <caption className="sr-only">Categorías del dataset</caption>
          <thead className="bg-zinc-50 dark:bg-zinc-950/50">
            <tr className={clsx('border-b border-zinc-200 dark:border-zinc-800', UI.label)}>
              <th scope="col" className="px-3 py-2">Código</th>
              <th scope="col" className="px-3 py-2">Nombre</th>
              <th scope="col" className="px-3 py-2">Grupo</th>
              <th scope="col" className="px-3 py-2">Criterio</th>
              <th scope="col" className="px-3 py-2 text-right">Conceptos</th>
              {editable ? <th scope="col" className="px-3 py-2"><span className="sr-only">Acciones</span></th> : null}
            </tr>
          </thead>
          <tbody>
            {categories.map((category) => (
              <tr key={category.id} className="border-b border-zinc-100 align-top last:border-0 dark:border-zinc-800/60">
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{category.id}</td>
                <td className="px-3 py-2 font-medium">{category.name}</td>
                <td className={clsx('px-3 py-2 text-xs', UI.muted)}>{category.group ?? '—'}</td>
                <td className="max-w-md px-3 py-2 text-xs">
                  {category.description ? <ExpandableText text={category.description} /> : <span className={UI.muted}>Sin criterio</span>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{counts.get(category.id) ?? 0}</td>
                {editable ? (
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <button
                      type="button"
                      className={linkButtonClass}
                      aria-label={`Editar categoría ${category.id}`}
                      onClick={() => {
                        setBlocker(null)
                        setFormErrors([])
                        setForm({ editingId: category.id, values: categoryToForm(category) })
                      }}
                    >
                      Editar
                    </button>
                    <button type="button" className={linkDangerClass} aria-label={`Eliminar categoría ${category.id}`} onClick={() => remove(category.id)}>
                      Eliminar
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  )
}
