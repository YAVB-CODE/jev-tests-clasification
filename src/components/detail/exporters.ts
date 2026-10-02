/**
 * Run export. `buildExportJson` / `buildExportCsv` / `exportFilename` are pure (unit tested);
 * `downloadTextFile` is the only function that touches the DOM (Blob + object URL).
 */
import type { BenchRun } from '../../bench/store.ts'
import type { Comparison, LaneMetrics } from '../../metrics/index.ts'
import { isCorrect } from '../../metrics/records.ts'
import {
  ENGINE_IDS,
  type BenchConfig,
  type ClassificationRecord,
  type ClassificationTask,
  type Difficulty,
  type EngineId,
  type EngineMode,
} from '../../shared/contracts.ts'

export const EXPORT_APP = 'jev-classify-lab'

/** Everything an export needs: the run snapshot, both lanes' metrics and records, the comparison. */
export interface ExportInput {
  run: Pick<BenchRun, 'datasetId' | 'datasetName' | 'task' | 'plan' | 'config' | 'engines'>
  metrics: Record<EngineId, LaneMetrics>
  /** null until both lanes have records. */
  comparison: Comparison | null
  records: Record<EngineId, readonly ClassificationRecord[]>
}

export interface ExportOptions {
  /** Keep `raw.request` / `raw.response` in the JSON records. Default true. */
  includeRaw?: boolean
  /** Clock override for tests. */
  now?: Date
}

/** Concept columns of an export: what the records alone do not say about the item. */
export interface ExportItem {
  id: string
  concept: string
  supplier?: string
  amount?: number
  currency?: string
  notes?: string
  expected: string
  difficulty?: Difficulty
  rationale?: string
}

export interface RunExport {
  exportedAt: string
  app: typeof EXPORT_APP
  dataset: { id: string; name: string }
  task: ClassificationTask
  config: BenchConfig
  engines: Record<EngineId, { mode: EngineMode; model: string | null }>
  metrics: Record<EngineId, LaneMetrics>
  comparison: Comparison | null
  /** Both lanes live, same coverage, complete: the comparison measures the real models. */
  validForComparison: boolean
  /** Whether `records[].raw` was kept. */
  rawIncluded: boolean
  /** Items of the plan (concept text, label, difficulty, rationale), once each. */
  items: ExportItem[]
  /** Both lanes: GPT first, then Jev; queue order inside each lane. */
  records: ClassificationRecord[]
}

// ─────────────────────────────── Records ───────────────────────────────

/** Lane by lane (GPT, Jev), then queue order and repetition. Does not mutate the input. */
export function orderedRecords(records: Record<EngineId, readonly ClassificationRecord[]>): ClassificationRecord[] {
  const out: ClassificationRecord[] = []
  for (const e of ENGINE_IDS) {
    out.push(...records[e].slice().sort((a, b) => a.index - b.index || a.repetition - b.repetition))
  }
  return out
}

function planItems(plan: ExportInput['run']['plan']): ExportItem[] {
  const seen = new Set<string>()
  const items: ExportItem[] = []
  for (const { item } of plan) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    items.push({ ...item })
  }
  return items
}

// ─────────────────────────────── JSON ───────────────────────────────

/** Export payload as an object (see `RunExport`). */
export function buildExportPayload(input: ExportInput, options: ExportOptions = {}): RunExport {
  const includeRaw = options.includeRaw ?? true
  const { run, metrics, comparison } = input
  const engines = {} as RunExport['engines']
  for (const e of ENGINE_IDS) {
    engines[e] = { mode: run.engines[e].mode, model: metrics[e].model ?? run.engines[e].model ?? null }
  }
  const records = orderedRecords(input.records).map((r) => {
    if (includeRaw || r.raw === undefined) return r
    const { raw: _raw, ...rest } = r
    return rest
  })
  return {
    exportedAt: (options.now ?? new Date()).toISOString(),
    app: EXPORT_APP,
    dataset: { id: run.datasetId, name: run.datasetName },
    task: run.task,
    config: run.config,
    engines,
    metrics,
    comparison,
    validForComparison: comparison?.validity.validForComparison ?? false,
    rawIncluded: includeRaw,
    items: planItems(run.plan),
    records,
  }
}

export function buildExportJson(input: ExportInput, options: ExportOptions = {}): string {
  return JSON.stringify(buildExportPayload(input, options), null, 2)
}

// ─────────────────────────────── CSV ───────────────────────────────

export const CSV_BOM = '﻿'

export const CSV_COLUMNS = [
  'engine',
  'mode',
  'model',
  'itemId',
  'repetition',
  'index',
  'concept',
  'expected',
  'predicted',
  'correct',
  'status',
  'confidence',
  'nativeConfidence',
  'nativeConfidenceKind',
  'latencyMs',
  'providerLatencyMs',
  'inputTokens',
  'outputTokens',
  'costUsd',
  'errorMessage',
  'difficulty',
] as const

type Cell = string | number | boolean | null | undefined

/**
 * RFC 4180 quoting (commas, quotes, line breaks). Text that starts with `= + - @` (or a tab / CR)
 * gets a leading apostrophe so spreadsheets do not evaluate it as a formula; numbers are untouched.
 */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function csvLine(cells: readonly Cell[]): string {
  return cells.map(csvCell).join(',')
}

/**
 * One row per record (GPT first, then Jev), with a UTF-8 BOM so Excel reads accents and CRLF
 * line endings. `concept` is looked up from the run plan by item id.
 */
export function buildExportCsv(input: ExportInput): string {
  const concepts = new Map<string, string>()
  for (const { item } of input.run.plan) concepts.set(item.id, item.concept)

  const lines: string[] = [csvLine(CSV_COLUMNS)]
  for (const r of orderedRecords(input.records)) {
    lines.push(
      csvLine([
        r.engine,
        r.mode,
        r.model,
        r.itemId,
        r.repetition,
        r.index,
        concepts.get(r.itemId),
        r.expected,
        r.predicted,
        isCorrect(r),
        r.status,
        r.confidence,
        r.nativeConfidence,
        r.nativeConfidenceKind,
        Math.round(r.latencyMs),
        r.providerLatencyMs === undefined ? undefined : Math.round(r.providerLatencyMs),
        r.usage?.inputTokens,
        r.usage?.outputTokens,
        r.costUsd,
        r.errorMessage,
        r.difficulty,
      ]),
    )
  }
  return `${CSV_BOM}${lines.join('\r\n')}\r\n`
}

// ─────────────────────────────── Download ───────────────────────────────

/** `jev-classify-lab-YYYYMMDD-HHmm.<ext>` in local time. */
export function exportFilename(extension: 'json' | 'csv', now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`
  return `${EXPORT_APP}-${stamp}.${extension}`
}

/** Triggers a browser download of `content` (Blob + object URL). */
export function downloadTextFile(filename: string, mime: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke after the click was dispatched: some browsers cancel the download if it happens synchronously.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadExportJson(input: ExportInput, options: ExportOptions = {}): void {
  const now = options.now ?? new Date()
  downloadTextFile(exportFilename('json', now), 'application/json', buildExportJson(input, { ...options, now }))
}

export function downloadExportCsv(input: ExportInput, now: Date = new Date()): void {
  downloadTextFile(exportFilename('csv', now), 'text/csv', buildExportCsv(input))
}
