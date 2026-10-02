import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BENCH_CONFIG, type ClassificationRecord, type ClassifyResult } from '../shared/contracts.ts'
import { isTimeoutAbort } from '../engines/abort.ts'
import type { Engine } from '../engines/types.ts'
import { buildRunPlan, type PlannedItem } from './plan.ts'
import { clampConcurrency, gradeResult, runLane } from './runner.ts'
import { AutoEngine, DeferredEngine, TASK, makeDataset, okResult } from './testFixtures.ts'

const plan = (n: number): PlannedItem[] =>
  buildRunPlan(makeDataset(n), { ...DEFAULT_BENCH_CONFIG, datasetId: 'test-ds', shuffle: false })

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const echo = (engine: 'gpt' | 'jev') => (item: { id: string }) => okResult(engine, plan(30).find((p) => p.item.id === item.id)!.item.expected)

afterEach(() => {
  vi.useRealTimers()
})

describe('runLane — pool', () => {
  it('never exceeds the concurrency and records every item', async () => {
    vi.useFakeTimers()
    const engine = new AutoEngine('gpt', echo('gpt'), 50)
    const records: ClassificationRecord[] = []
    const done = runLane({ engine, task: TASK, plan: plan(10), concurrency: 2, timeoutMs: 5000, signal: new AbortController().signal, onRecord: (r) => records.push(r) })
    expect(engine.calls).toHaveLength(2) // issued synchronously
    await vi.advanceTimersByTimeAsync(1000)
    const summary = await done
    expect(summary).toEqual({ completed: 10, skipped: 0, aborted: false })
    expect(engine.maxInFlight).toBe(2)
    expect(records).toHaveLength(10)
    expect(records.every((r) => r.correct)).toBe(true)
    expect(new Set(records.map((r) => r.index)).size).toBe(10)
  })

  it('clamps the concurrency to 1..3 (browser connection budget)', async () => {
    expect(clampConcurrency(10)).toBe(3)
    expect(clampConcurrency(0)).toBe(1)
    expect(clampConcurrency(Number.NaN)).toBe(1)
    const engine = new DeferredEngine('jev')
    void runLane({ engine, task: TASK, plan: plan(10), concurrency: 6, timeoutMs: 5000, signal: new AbortController().signal, onRecord: () => undefined })
    expect(engine.calls).toHaveLength(3)
  })

  it('starts the next call as soon as one finishes', async () => {
    const engine = new DeferredEngine('gpt')
    const records: ClassificationRecord[] = []
    const done = runLane({ engine, task: TASK, plan: plan(3), concurrency: 1, timeoutMs: 5000, signal: new AbortController().signal, onRecord: (r) => records.push(r) })
    expect(engine.calls).toHaveLength(1)
    engine.calls[0].resolve(okResult('gpt', '513525'))
    await flush()
    expect(engine.calls).toHaveLength(2)
    expect(records).toHaveLength(1)
    engine.calls[1].resolve(okResult('gpt', '513525'))
    await flush()
    engine.calls[2].resolve(okResult('gpt', '513525'))
    await done
    expect(records.map((r) => r.index)).toEqual([0, 1, 2])
  })

  it('only ever sends the label-free item to the engine', () => {
    const engine = new DeferredEngine('gpt')
    void runLane({ engine, task: TASK, plan: plan(2), concurrency: 2, timeoutMs: 5000, signal: new AbortController().signal, onRecord: () => undefined })
    for (const call of engine.calls) {
      expect(call.item).not.toHaveProperty('expected')
      expect(call.item).not.toHaveProperty('difficulty')
      expect(call.item).not.toHaveProperty('rationale')
      expect(call.opts.repetition).toBe(0)
    }
  })
})

describe('runLane — timeout and abort', () => {
  it('turns a slow call into a timeout record (even if the engine ignores the signal)', async () => {
    vi.useFakeTimers()
    const engine = new DeferredEngine('gpt') // never resolves
    const records: ClassificationRecord[] = []
    const done = runLane({
      engine,
      task: TASK,
      plan: plan(1),
      concurrency: 1,
      timeoutMs: 2000,
      signal: new AbortController().signal,
      onRecord: (r) => records.push(r),
      perfNow: () => Date.now(),
    })
    await vi.advanceTimersByTimeAsync(1999)
    expect(records).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('timeout')
    expect(records[0].predicted).toBeNull()
    expect(records[0].correct).toBe(false)
    expect(records[0].errorMessage).toContain('Tiempo agotado')
    expect(records[0].latencyMs).toBe(2000)
    expect(isTimeoutAbort(engine.calls[0].opts.signal)).toBe(true)
  })

  it('records a timeout when the engine itself honors the signal', async () => {
    vi.useFakeTimers()
    const engine: Engine = {
      id: 'jev',
      mode: 'mock',
      classify: (_t, _i, { signal }) =>
        new Promise<ClassifyResult>((resolve) => {
          signal.addEventListener('abort', () =>
            resolve({ engine: 'jev', mode: 'mock', model: 'm', status: 'error', answer: { categoryId: null }, errorMessage: 'abortado' }),
          )
        }),
    }
    const records: ClassificationRecord[] = []
    const done = runLane({ engine, task: TASK, plan: plan(2), concurrency: 2, timeoutMs: 1000, signal: new AbortController().signal, onRecord: (r) => records.push(r) })
    await vi.advanceTimersByTimeAsync(1000)
    await done
    expect(records.map((r) => r.status)).toEqual(['timeout', 'timeout'])
  })

  it('stops on run abort: no new calls and no record for cancelled calls', async () => {
    const engine = new DeferredEngine('gpt')
    const controller = new AbortController()
    const records: ClassificationRecord[] = []
    const done = runLane({ engine, task: TASK, plan: plan(6), concurrency: 2, timeoutMs: 5000, signal: controller.signal, onRecord: (r) => records.push(r) })
    engine.calls[0].resolve(okResult('gpt', '513525'))
    await flush()
    expect(engine.calls).toHaveLength(3)
    controller.abort()
    const summary = await done
    expect(summary).toEqual({ completed: 1, skipped: 5, aborted: true })
    expect(records).toHaveLength(1)
    expect(engine.calls.map((c) => c.opts.signal.aborted)).toEqual([false, true, true])
    // late answers of cancelled calls are ignored
    engine.calls[1].resolve(okResult('gpt', '513530'))
    await flush()
    expect(records).toHaveLength(1)
    expect(engine.calls).toHaveLength(3)
  })

  it('turns a throwing engine into an error record and keeps going', async () => {
    let n = 0
    const engine: Engine = {
      id: 'gpt',
      mode: 'live',
      classify: async () => {
        n++
        if (n === 1) throw new Error('boom')
        return okResult('gpt', '513525')
      },
    }
    const records: ClassificationRecord[] = []
    await runLane({ engine, task: TASK, plan: plan(2), concurrency: 1, timeoutMs: 5000, signal: new AbortController().signal, onRecord: (r) => records.push(r) })
    expect(records.map((r) => r.status)).toEqual(['error', 'ok'])
    expect(records[0].errorMessage).toContain('boom')
  })
})

describe('gradeResult', () => {
  const [planned] = plan(1) // expected 513525 (group 5135 Servicios), difficulty easy
  const timing = { latencyMs: 123.4, startedAt: 1000, finishedAt: 1123 }

  it('grades a correct answer and copies the details', () => {
    const result = okResult('jev', '513525', {
      mode: 'mock',
      answer: {
        categoryId: '513525',
        confidence: 0.8,
        probabilities: { '513525': 0.8, '513530': 0.2 },
        nativeConfidence: 0.7,
        nativeConfidenceKind: 'jev_confidence',
      },
      usage: { inputTokens: 100, outputTokens: 5 },
      costUsd: 0.0001,
      estimated: true,
      attempts: [{ attempt: 1, status: 200, ms: 10 }],
      raw: { request: { a: 1 }, response: { b: 2 } },
    })
    const record = gradeResult(result, planned, TASK.categories, timing)
    expect(record).toMatchObject({
      engine: 'jev',
      mode: 'mock',
      model: 'jev-test',
      itemId: 'item-0',
      index: 0,
      repetition: 0,
      expected: '513525',
      predicted: '513525',
      correct: true,
      groupCorrect: true,
      status: 'ok',
      confidence: 0.8,
      probabilities: { '513525': 0.8, '513530': 0.2 },
      nativeConfidence: 0.7,
      nativeConfidenceKind: 'jev_confidence',
      latencyMs: 123.4,
      providerLatencyMs: 10,
      usage: { inputTokens: 100, outputTokens: 5 },
      costUsd: 0.0001,
      estimated: true,
      difficulty: 'easy',
      attempts: [{ attempt: 1, status: 200, ms: 10 }],
      raw: { request: { a: 1 }, response: { b: 2 } },
      startedAt: 1000,
      finishedAt: 1123,
    })
    expect(record).not.toHaveProperty('errorMessage')
  })

  it('groupCorrect: same group true, other group false, missing group undefined', () => {
    expect(gradeResult(okResult('gpt', '513530'), planned, TASK.categories, timing)).toMatchObject({ correct: false, groupCorrect: true })
    expect(gradeResult(okResult('gpt', '511025'), planned, TASK.categories, timing)).toMatchObject({ correct: false, groupCorrect: false })
    expect(gradeResult(okResult('gpt', 'SIN-GRUPO'), planned, TASK.categories, timing).groupCorrect).toBeUndefined()
  })

  it('an ok answer outside the category set is invalid', () => {
    const record = gradeResult(okResult('gpt', '999999'), planned, TASK.categories, timing)
    expect(record).toMatchObject({ status: 'invalid', predicted: null, correct: false })
    expect(record.groupCorrect).toBeUndefined()
    expect(record.confidence).toBeUndefined()
    expect(record.errorMessage).toBeTruthy()
  })

  it('failures have no prediction nor confidence but keep usage and message', () => {
    const result: ClassifyResult = {
      engine: 'gpt',
      mode: 'live',
      model: 'gpt-x',
      status: 'invalid',
      answer: { categoryId: null, confidence: 0.99 },
      usage: { inputTokens: 10, outputTokens: 3 },
      errorMessage: 'JSON malformado',
    }
    const record = gradeResult(result, planned, TASK.categories, timing)
    expect(record).toMatchObject({ status: 'invalid', predicted: null, correct: false, usage: { inputTokens: 10, outputTokens: 3 }, errorMessage: 'JSON malformado' })
    expect(record.confidence).toBeUndefined()
  })
})
