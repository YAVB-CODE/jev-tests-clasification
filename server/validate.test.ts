import { describe, expect, it } from 'vitest'
import { DEFAULT_TASK_INSTRUCTIONS, DEFAULT_TASK_QUESTION } from '../src/shared/task.ts'
import { MODEL_ID_PATTERN, parseClassifyRequest } from './validate.ts'

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engine: 'gpt',
    task: {
      instructions: DEFAULT_TASK_INSTRUCTIONS,
      question: DEFAULT_TASK_QUESTION,
      categories: [
        { id: '513530', name: 'Energía eléctrica', description: 'Servicio de energía', group: '5135 Servicios' },
        { id: '513525', name: 'Acueducto', description: 'Servicio de agua' },
      ],
    },
    item: { id: 'c1', concept: 'Servicio de energía periodo marzo', supplier: 'Enel', amount: 120000, currency: 'COP' },
    ...overrides,
  }
}

function errorsOf(body: unknown): string[] {
  const parsed = parseClassifyRequest(body)
  if (parsed.ok) throw new Error('expected validation to fail')
  return parsed.errors
}

describe('parseClassifyRequest', () => {
  it('accepts a valid request and returns a normalized copy', () => {
    const body = validBody({ model: 'gpt-4.1-mini' })
    const parsed = parseClassifyRequest(body)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.engine).toBe('gpt')
    expect(parsed.value.model).toBe('gpt-4.1-mini')
    expect(parsed.value.task.categories.map((c) => c.id)).toEqual(['513530', '513525'])
    expect(parsed.value.item).toEqual({ id: 'c1', concept: 'Servicio de energía periodo marzo', supplier: 'Enel', amount: 120000, currency: 'COP' })
    // New objects, not the input.
    expect(parsed.value.item).not.toBe(body.item)
    expect(parsed.value.task).not.toBe(body.task)
  })

  it('omits model when absent', () => {
    const parsed = parseClassifyRequest(validBody({ engine: 'jev' }))
    expect(parsed.ok && 'model' in parsed.value).toBe(false)
  })

  it('drops the expected label and any other extra field (allow-list)', () => {
    const body = validBody({
      extra: 'x',
      item: { id: 'c1', concept: 'Energía', expected: '513530', difficulty: 'hard', rationale: 'porque sí', secret: 1 },
    })
    ;(body.task as Record<string, unknown>).oracle = 'x'
    ;((body.task as { categories: Array<Record<string, unknown>> }).categories[0]).expected = '513530'
    const parsed = parseClassifyRequest(body)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(Object.keys(parsed.value).sort()).toEqual(['engine', 'item', 'task'])
    expect(parsed.value.item).toEqual({ id: 'c1', concept: 'Energía' })
    expect(Object.keys(parsed.value.task).sort()).toEqual(['categories', 'instructions', 'question'])
    expect(JSON.stringify(parsed.value)).not.toMatch(/expected|rationale|difficulty|oracle|secret/)
  })

  it.each([
    ['null', null],
    ['an array', [validBody()]],
    ['a string', 'hola'],
    ['undefined', undefined],
  ])('rejects a body that is %s', (_name, body) => {
    expect(errorsOf(body)).toEqual(['body: debe ser un objeto JSON { engine, task, item }'])
  })

  it.each([undefined, 'claude', 42, null, 'GPT'])('rejects engine %j', (engine) => {
    const errors = errorsOf(validBody({ engine }))
    expect(errors.some((e) => e.startsWith('engine:'))).toBe(true)
  })

  it.each(['', 'gpt 4', 42, 'x'.repeat(101), '-gpt', 'gpt\n4', null])('rejects model %j', (model) => {
    expect(errorsOf(validBody({ model })).some((e) => e.startsWith('model:'))).toBe(true)
  })

  it.each(['gpt-4.1-mini', 'o4-mini', 'jev-1.13-free', 'openai/gpt-5', 'x'.repeat(100)])('accepts model %s', (model) => {
    expect(MODEL_ID_PATTERN.test(model)).toBe(true)
  })

  it('reports task and item errors with their field paths', () => {
    const errors = errorsOf(
      validBody({
        task: { instructions: 'x', question: '', categories: [{ id: 'a b', name: 'A' }] },
        item: { id: 'c1' },
      }),
    )
    expect(errors).toEqual(expect.arrayContaining([expect.stringMatching(/^task\.question:/), expect.stringMatching(/^task\.categories/), 'item.concept: requerido']))
  })

  it('requires task and item', () => {
    const errors = errorsOf({ engine: 'gpt' })
    expect(errors).toEqual(['task: debe ser un objeto', 'item: debe ser un objeto'])
  })

  it('collects errors from every field at once', () => {
    const errors = errorsOf({ engine: 'nope', model: 'bad model', task: 1, item: 'x' })
    expect(errors).toHaveLength(4)
  })

  it('caps the number of errors', () => {
    const categories = Array.from({ length: 40 }, () => ({ id: 'bad id', name: '' }))
    const errors = errorsOf(validBody({ task: { instructions: 'x', question: 'q', categories }, item: { id: 'c1' } }))
    expect(errors.length).toBeLessThanOrEqual(26)
    expect(errors.at(-1)).toMatch(/errores más/)
  })
})
