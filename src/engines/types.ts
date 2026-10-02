import type {
  ClassificationTask,
  ClassifyResult,
  ConceptInput,
  EngineId,
  EngineMode,
  LabeledConcept,
} from '../shared/contracts.ts'

export interface ClassifyOptions {
  /** Aborted by the runner on timeout (reason name 'TimeoutError') or when the run is stopped. */
  signal: AbortSignal
  /** Model picked in the UI (live engines). Omitted → server default. Ignored by mocks. */
  model?: string
  /** 0-based repetition of this item in the run (mock determinism). Defaults to 0. */
  repetition?: number
}

/**
 * A classifier behind one lane. `classify` NEVER throws: aborts, timeouts, HTTP and network
 * failures come back as a `ClassifyResult` with status 'timeout' | 'error' | 'invalid' and a
 * Spanish `errorMessage`.
 */
export interface Engine {
  readonly id: EngineId
  readonly mode: EngineMode
  /** Model this engine always reports (mocks: "mock-gpt" / "mock-jev"); undefined = decided per call. */
  readonly model?: string
  classify(task: ClassificationTask, item: ConceptInput, opts: ClassifyOptions): Promise<ClassifyResult>
}

/** Label lookup for the MockEngine (the only engine allowed to see the expected answer). */
export type Oracle = (itemId: string) => LabeledConcept | undefined
