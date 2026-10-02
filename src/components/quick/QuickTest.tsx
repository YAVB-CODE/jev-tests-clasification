/**
 * «Prueba rápida»: classifies ONE concept with both engines at the same time, using the task of the
 * active dataset (same text for both). The result is a split screen (GPT left, Jev right; stacked on
 * phones). The optional expected answer is local only: it is never sent, it just marks who got it right.
 */
import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import clsx from 'clsx'
import { ENGINE_IDS } from '../../shared/contracts.ts'
import { selectActiveDataset, selectCanConfigure, useBench } from '../../bench/useBench.ts'
import { engineLabel } from '../../engines/labels.ts'
import { MOCK_DISCLAIMER } from '../../engines/profiles.ts'
import { formatAmount } from '../dataset/datasetView.ts'
import { Field, Notice, Section } from '../dataset/fields.tsx'
import { buttonClass, inputClass, primaryButtonClass } from '../dataset/styles.ts'
import { times } from '../../metrics/format.ts'
import { ENGINE_THEME, UI } from '../ui/theme.ts'
import QuickLaneCard from './QuickLaneCard.tsx'
import {
  buildQuickInput,
  compareLanes,
  emptyQuickForm,
  formFromConcept,
  judgeAnswer,
  pickExamples,
  type QuickFormValues,
} from './quickUtils.ts'

const EXAMPLE_COUNT = 5

function truncate(text: string, max = 70): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export default function QuickTest() {
  const datasets = useBench((s) => s.datasets)
  const active = useBench(selectActiveDataset)
  const canRun = useBench(selectCanConfigure)
  const quick = useBench((s) => s.quick)
  const classifyQuick = useBench((s) => s.classifyQuick)
  const clearQuick = useBench((s) => s.clearQuick)

  // The last concept sent survives tab changes (the result lives in the store).
  const [form, setForm] = useState<QuickFormValues>(() => formFromConcept(quick.input))
  const [expected, setExpected] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const submitRef = useRef<HTMLButtonElement>(null)

  const categories = active?.task.categories ?? []
  const examples = useMemo(() => (active ? pickExamples(active.items, EXAMPLE_COUNT) : []), [active])
  const expectedId = categories.some((c) => c.id === expected) ? expected : ''
  const running = quick.status === 'running'
  const locked = !canRun || running
  const resultDataset = quick.datasetId !== null ? datasets.find((d) => d.id === quick.datasetId) : undefined
  // The expected answer belongs to the ACTIVE task: it only applies to a result made with that same task.
  const sameTask = quick.datasetId !== null && quick.datasetId === active?.id
  const hasResult = quick.status !== 'idle' || quick.input !== null
  const bothDone = ENGINE_IDS.every((e) => quick.lanes[e].status === 'done' && quick.lanes[e].result !== undefined)
  const anyMock = ENGINE_IDS.some((e) => quick.lanes[e].mode === 'mock')

  const setField = (key: keyof QuickFormValues, value: string): void => {
    setForm((prev) => ({ ...prev, [key]: value }))
    setFormError(null)
  }

  const submit = (event?: FormEvent): void => {
    event?.preventDefault()
    if (locked) return
    const built = buildQuickInput(form)
    if (!built.ok) {
      setFormError(built.error)
      return
    }
    setFormError(null)
    void classifyQuick(built.input)
  }

  const onConceptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit()
    }
  }

  const loadExample = (index: number): void => {
    const item = examples[index]
    if (item === undefined) return
    setForm(formFromConcept(item))
    setExpected(item.expected)
    setFormError(null)
    submitRef.current?.focus()
  }

  const clearAll = (): void => {
    clearQuick()
    setForm(emptyQuickForm())
    setExpected('')
    setFormError(null)
  }

  const comparison = bothDone
    ? compareLanes(
        { engine: 'gpt', categoryId: quick.lanes.gpt.result?.answer.categoryId ?? null, latencyMs: quick.lanes.gpt.latencyMs },
        { engine: 'jev', categoryId: quick.lanes.jev.result?.answer.categoryId ?? null, latencyMs: quick.lanes.jev.latencyMs },
      )
    : null

  if (active === undefined) {
    return <Notice tone="warn">No hay un dataset seleccionado: elige uno en la pestaña «Dataset» para tener una tarea con la que clasificar.</Notice>
  }

  return (
    <div className="space-y-4">
      {!canRun ? (
        <Notice tone="warn">
          Hay una corrida en curso: la prueba rápida está bloqueada hasta que termine, porque usaría conexiones extra y alteraría las
          latencias que se están midiendo.
        </Notice>
      ) : null}

      <Section
        id="quick-form-title"
        title="Prueba rápida"
        description="Clasifica un solo concepto con GPT y con Jev a la vez y compara respuesta, confianza, latencia y costo."
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <p>
            <span className={UI.muted}>Tarea: </span>
            <span className="font-medium">{active.name}</span>
            <span className={UI.muted}> · {categories.length} categorías (el dataset activo)</span>
          </p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {ENGINE_IDS.map((e) => (
              <li key={e} className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className={clsx('h-2 w-2 rounded-full', ENGINE_THEME[e].solid)} />
                <span className="text-xs">{engineLabel(e, quick.lanes[e].mode, quick.lanes[e].model)}</span>
              </li>
            ))}
          </ul>
        </div>

        {anyMock ? <Notice tone="info">{MOCK_DISCLAIMER}</Notice> : null}

        <div>
          <p className={UI.label}>Ejemplos del dataset</p>
          <div className="mt-1.5 flex flex-wrap gap-2" role="group" aria-label="Ejemplos de conceptos">
            {examples.map((item, index) => (
              <button
                key={item.id}
                type="button"
                disabled={locked}
                title={item.concept}
                onClick={() => loadExample(index)}
                className={clsx(
                  'max-w-full truncate rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500',
                )}
              >
                {truncate(item.concept)}
              </button>
            ))}
          </div>
          <p className={clsx('mt-1 text-xs', UI.muted)}>
            Un clic carga el ejemplo en el formulario (con su respuesta esperada, solo local); luego pulsa «Clasificar con ambos».
          </p>
        </div>

        <form onSubmit={submit} className="space-y-3" aria-label="Concepto a clasificar">
          <fieldset disabled={locked} className="space-y-3">
            <Field label="Concepto" required hint="Texto de la línea de factura. Ctrl/⌘ + Enter para clasificar.">
              <textarea
                className={inputClass}
                rows={2}
                value={form.concept}
                maxLength={500}
                placeholder="Ej.: Servicio de energía eléctrica, periodo marzo"
                onChange={(e) => setField('concept', e.target.value)}
                onKeyDown={onConceptKeyDown}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Proveedor">
                <input className={inputClass} value={form.supplier} maxLength={200} onChange={(e) => setField('supplier', e.target.value)} />
              </Field>
              <Field label="Valor">
                <input
                  className={inputClass}
                  inputMode="decimal"
                  value={form.amount}
                  placeholder="1.234.567"
                  onChange={(e) => setField('amount', e.target.value)}
                />
              </Field>
              <Field label="Moneda">
                <input className={inputClass} value={form.currency} maxLength={10} onChange={(e) => setField('currency', e.target.value)} />
              </Field>
              <Field label="Notas">
                <input className={inputClass} value={form.notes} maxLength={2000} onChange={(e) => setField('notes', e.target.value)} />
              </Field>
            </div>
            <Field
              label="Respuesta esperada (opcional)"
              hint="Solo local: nunca se envía a los modelos. Sirve para marcar con ✓ / ✗ quién acertó."
            >
              <select className={inputClass} value={expectedId} onChange={(e) => setExpected(e.target.value)}>
                <option value="">Sin respuesta esperada</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id} · {c.name}
                  </option>
                ))}
              </select>
            </Field>
          </fieldset>

          {formError ? <Notice tone="error">{formError}</Notice> : null}
          {quick.error ? <Notice tone="error">{quick.error}</Notice> : null}

          <div className="flex flex-wrap items-center gap-2">
            <button ref={submitRef} type="submit" className={primaryButtonClass} disabled={locked}>
              {running ? 'Clasificando…' : 'Clasificar con ambos'}
            </button>
            <button type="button" className={buttonClass} disabled={!canRun} onClick={clearAll}>
              Limpiar
            </button>
            <p className={clsx('text-xs', UI.muted)}>Los dos motores reciben exactamente el mismo concepto y la misma tarea.</p>
          </div>
        </form>
      </Section>

      <section aria-labelledby="quick-result-title" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="quick-result-title" className="text-base font-semibold">
            Resultado
          </h2>
          {hasResult && resultDataset ? <p className={clsx('text-xs', UI.muted)}>Tarea usada: {resultDataset.name}</p> : null}
        </div>

        {quick.input !== null ? (
          <div className={clsx(UI.card, 'px-4 py-3 text-sm')}>
            <p className={UI.label}>Concepto enviado</p>
            <p className="mt-1 break-words font-medium">{quick.input.concept}</p>
            <p className={clsx('mt-0.5 text-xs', UI.muted)}>
              {[
                quick.input.supplier,
                quick.input.amount !== undefined ? formatAmount(quick.input.amount, quick.input.currency) : undefined,
                quick.input.notes,
              ]
                .filter(Boolean)
                .join(' · ') || 'Sin proveedor, valor ni notas'}
            </p>
          </div>
        ) : null}

        {comparison !== null ? (
          <p className="text-sm" aria-live="polite">
            {comparison.agree === true ? 'Ambos eligieron la misma categoría.' : null}
            {comparison.agree === false ? 'Eligieron categorías distintas.' : null}
            {comparison.agree === null ? 'Al menos un motor no dio una respuesta válida.' : null}
            {comparison.faster !== null ? (
              <span className={UI.muted}>
                {' '}
                {ENGINE_THEME[comparison.faster.engine].label} respondió {times(comparison.faster.ratio)} más rápido (extremo a extremo).
              </span>
            ) : null}
          </p>
        ) : null}

        {expectedId !== '' && quick.input !== null && !sameTask ? (
          <Notice tone="info">El dataset activo cambió después de esta prueba, así que la respuesta esperada no se aplica a este resultado.</Notice>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          {ENGINE_IDS.map((e) => (
            <QuickLaneCard
              key={e}
              engine={e}
              lane={quick.lanes[e]}
              dataset={resultDataset}
              expected={expectedId}
              judgement={sameTask ? judgeAnswer(quick.lanes[e].result, expectedId) : null}
            />
          ))}
        </div>
      </section>
    </div>
  )
}
