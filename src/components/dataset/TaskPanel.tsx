/** Dataset name / description and the task text both models receive (instructions + question). */
import clsx from 'clsx'
import { LIMITS } from '../../shared/task.ts'
import { UI } from '../ui/theme.ts'
import type { PanelProps } from './panelTypes.ts'
import { Field, Notice, Section } from './fields.tsx'
import { inputClass } from './styles.ts'

export default function TaskPanel({ dataset, editable, onChange }: PanelProps) {
  const { task } = dataset
  return (
    <Section
      id="dataset-task-title"
      title="Tarea que ven ambos modelos"
      description="Estos dos textos, más el criterio de cada categoría, se envían idénticos y verbatim a GPT y a Jev."
    >
      {editable ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Nombre del dataset" required>
            <input
              className={inputClass}
              value={dataset.name}
              maxLength={LIMITS.nameLength}
              onChange={(e) => onChange((d) => ({ ...d, name: e.target.value }))}
            />
          </Field>
          <Field label="Descripción">
            <input
              className={inputClass}
              value={dataset.description}
              maxLength={LIMITS.textLength}
              onChange={(e) => onChange((d) => ({ ...d, description: e.target.value }))}
            />
          </Field>
          <Field
            label="Instrucciones"
            required
            className="md:col-span-2"
            hint={`${task.instructions.length} / ${LIMITS.textLength} caracteres. Contexto contable y reglas para decidir.`}
          >
            <textarea
              className={clsx(inputClass, 'min-h-40 font-mono text-xs leading-relaxed')}
              rows={8}
              value={task.instructions}
              maxLength={LIMITS.textLength}
              onChange={(e) => onChange((d) => ({ ...d, task: { ...d.task, instructions: e.target.value } }))}
            />
          </Field>
          <Field label="Pregunta" required className="md:col-span-2" hint="Se responde para cada concepto.">
            <textarea
              className={inputClass}
              rows={2}
              value={task.question}
              maxLength={LIMITS.textLength}
              onChange={(e) => onChange((d) => ({ ...d, task: { ...d.task, question: e.target.value } }))}
            />
          </Field>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <h3 className={UI.label}>Instrucciones</h3>
            <p className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs leading-relaxed dark:border-zinc-800 dark:bg-zinc-950/50">
              {task.instructions}
            </p>
          </div>
          <div>
            <h3 className={UI.label}>Pregunta</h3>
            <p className="mt-1 whitespace-pre-wrap break-words rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-800 dark:bg-zinc-950/50">
              {task.question}
            </p>
          </div>
        </div>
      )}
      <Notice tone="info">
        De cada concepto, los modelos ven solo el texto, el proveedor, el valor, la moneda y las notas. La categoría esperada, la
        dificultad, la justificación y el id nunca se envían: la calificación ocurre en tu navegador.
      </Notice>
    </Section>
  )
}
