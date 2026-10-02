import { describe, expect, it } from 'vitest'
import type { ClassificationTask, ClassifyResult, ConceptInput } from '../../src/shared/contracts.ts'
import { CLASSIFY_STATUSES, ENGINE_IDS } from '../../src/shared/contracts.ts'
import { DEFAULT_TASK_INSTRUCTIONS, DEFAULT_TASK_QUESTION } from '../../src/shared/task.ts'
import { loadConfig } from '../env.ts'
import { createAdapters } from './index.ts'
import type { FetchLike } from './common.ts'

const task: ClassificationTask = {
  instructions: DEFAULT_TASK_INSTRUCTIONS,
  question: DEFAULT_TASK_QUESTION,
  categories: [
    { id: '513530', name: 'Energía eléctrica', description: 'Servicio de energía' },
    { id: '513525', name: 'Acueducto', description: 'Servicio de agua' },
  ],
}
const item: ConceptInput = { id: 'c1', concept: 'Servicio de energía periodo marzo' }

/** Network that always fails: a real adapter maps it to status 'error'; a stub never calls it. */
const brokenFetch: FetchLike = async () => {
  throw new Error('network down')
}

function expectFailureResult(result: ClassifyResult, engine: 'gpt' | 'jev') {
  expect(result.engine).toBe(engine)
  expect(CLASSIFY_STATUSES).toContain(result.status)
  expect(result.status).not.toBe('ok')
  expect(result.answer.categoryId).toBeNull()
  expect(typeof result.errorMessage).toBe('string')
  expect(result.errorMessage).not.toContain('sk-secret')
  expect(result.errorMessage).not.toContain('zen-secret')
}

describe('createAdapters', () => {
  it('builds both engines with the configured defaults', () => {
    const cfg = loadConfig({ OPENAI_API_KEY: 'sk-secret-1', OPENCODE_API_KEY: 'zen-secret-1' })
    const adapters = createAdapters(cfg, { fetch: brokenFetch })
    expect(Object.keys(adapters)).toEqual([...ENGINE_IDS])
    expect(adapters.gpt).toMatchObject({ engine: 'gpt', live: true, model: 'gpt-4.1-mini', provider: 'OpenAI' })
    expect(adapters.jev).toMatchObject({ engine: 'jev', live: true, model: 'jev-1.13-free', provider: 'OpenCode Zen' })
  })

  it('is not live without keys', () => {
    const adapters = createAdapters(loadConfig({}))
    expect(adapters.gpt.live).toBe(false)
    expect(adapters.jev.live).toBe(false)
  })

  it('never throws on classify without a key: a Spanish error result naming the env var', async () => {
    const adapters = createAdapters(loadConfig({}), { fetch: brokenFetch })
    const gpt = await adapters.gpt.classify(task, item)
    const jev = await adapters.jev.classify(task, item, { model: 'jev-1.13' })
    expectFailureResult(gpt, 'gpt')
    expectFailureResult(jev, 'jev')
    expect(gpt.errorMessage).toContain('OPENAI_API_KEY')
    expect(jev.errorMessage).toContain('OPENCODE_API_KEY')
    expect(jev.model).toBe('jev-1.13')
  })

  it('never throws on classify with a key and a failing network', async () => {
    const cfg = loadConfig({ OPENAI_API_KEY: 'sk-secret-1', OPENCODE_API_KEY: 'zen-secret-1', CLASSIFY_MAX_RETRIES: '0' })
    const adapters = createAdapters(cfg, { fetch: brokenFetch })
    expectFailureResult(await adapters.gpt.classify(task, item), 'gpt')
    expectFailureResult(await adapters.jev.classify(task, item), 'jev')
  })

  it('never throws when the caller already aborted', async () => {
    const cfg = loadConfig({ OPENAI_API_KEY: 'sk-secret-1', OPENCODE_API_KEY: 'zen-secret-1' })
    const adapters = createAdapters(cfg, { fetch: brokenFetch })
    const controller = new AbortController()
    controller.abort()
    for (const engine of ENGINE_IDS) {
      const result = await adapters[engine].classify(task, item, { signal: controller.signal })
      expectFailureResult(result, engine)
    }
  })

  it('listModels never throws and always offers the default model', async () => {
    for (const env of [{}, { OPENAI_API_KEY: 'sk-secret-1', OPENCODE_API_KEY: 'zen-secret-1' }]) {
      const adapters = createAdapters(loadConfig({ ...env, CLASSIFY_MAX_RETRIES: '0' }), { fetch: brokenFetch })
      for (const engine of ENGINE_IDS) {
        for (const force of [false, true]) {
          const list = await adapters[engine].listModels(force)
          expect(list.default).toBe(adapters[engine].model)
          expect(list.models.map((m) => m.id)).toContain(list.default)
          expect(list.source).toBe('fallback')
          expect(JSON.stringify(list)).not.toMatch(/sk-secret|zen-secret/)
        }
      }
    }
  })
})
