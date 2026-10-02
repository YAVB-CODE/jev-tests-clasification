import { describe, expect, it } from 'vitest'
import type { PlannedItem } from '../../bench/plan.ts'
import { compareLanes, computeLaneMetrics } from '../../metrics/index.ts'
import { CATEGORIES, makeRecord, makeRun, type RecordSpec } from '../../metrics/__fixtures__/makeRecord.ts'
import { DEFAULT_BENCH_CONFIG, type ClassificationRecord, type EngineId, type LabeledConcept } from '../../shared/contracts.ts'
import {
  CSV_BOM,
  CSV_COLUMNS,
  buildExportCsv,
  buildExportJson,
  buildExportPayload,
  csvCell,
  csvLine,
  exportFilename,
  orderedRecords,
  type ExportInput,
} from './exporters.ts'

const CONCEPTS = ['Servicio de energía, marzo', 'Taxi "aeropuerto"', 'Papelería\ny útiles', '=HYPERLINK("x")']

function makePlan(): PlannedItem[] {
  return CONCEPTS.map((concept, index): PlannedItem => {
    const item: LabeledConcept = {
      id: `item-${index}`,
      concept,
      supplier: 'Proveedor',
      amount: 1000 * (index + 1),
      currency: 'COP',
      expected: 'A',
      difficulty: index % 2 === 0 ? 'easy' : 'hard',
      rationale: 'Porque sí',
    }
    return { item, index, repetition: 0 }
  })
}

function lane(engine: EngineId, specs: RecordSpec[]): ClassificationRecord[] {
  return specs.map((spec, index) =>
    makeRecord({
      engine,
      index,
      expected: 'A',
      difficulty: index % 2 === 0 ? 'easy' : 'hard',
      confidence: 0.8,
      raw: { request: { engine, index }, response: { ok: true } },
      ...spec,
    }),
  )
}

function makeInput(modes: { gpt: 'live' | 'mock'; jev: 'live' | 'mock' } = { gpt: 'live', jev: 'live' }): ExportInput {
  const gpt = lane('gpt', [
    { predicted: 'A', mode: modes.gpt, model: 'gpt-4.1-mini', usage: { inputTokens: 100, outputTokens: 5 }, costUsd: 0.0001 },
    { predicted: 'B', mode: modes.gpt, model: 'gpt-4.1-mini', nativeConfidence: 0.42, nativeConfidenceKind: 'logprob' },
    { status: 'timeout', mode: modes.gpt, model: 'gpt-4.1-mini', errorMessage: 'Tiempo agotado, reintenta\n"ya"', latencyMs: 30000 },
    { predicted: 'A', mode: modes.gpt, model: 'gpt-4.1-mini', providerLatencyMs: 812.4 },
  ])
  const jev = lane('jev', [
    { predicted: 'A', mode: modes.jev, model: 'jev-1.13' },
    { predicted: 'A', mode: modes.jev, model: 'jev-1.13', nativeConfidence: 0.9, nativeConfidenceKind: 'jev_confidence' },
    { predicted: 'B', mode: modes.jev, model: 'jev-1.13' },
    { predicted: 'A', mode: modes.jev, model: 'jev-1.13' },
  ])
  const task = { instructions: 'Clasifica', question: '¿Cuál?', categories: CATEGORIES }
  const metrics = {
    gpt: computeLaneMetrics(gpt, { categories: CATEGORIES, run: makeRun('gpt', 4, { mode: modes.gpt, model: 'gpt-4.1-mini' }) }),
    jev: computeLaneMetrics(jev, { categories: CATEGORIES, run: makeRun('jev', 4, { mode: modes.jev, model: 'jev-1.13' }) }),
  }
  return {
    run: {
      datasetId: 'ds',
      datasetName: 'Dataset de prueba',
      task,
      plan: makePlan(),
      config: { ...DEFAULT_BENCH_CONFIG },
      engines: { gpt: { mode: modes.gpt }, jev: { mode: modes.jev, model: 'jev-1.13' } },
    },
    metrics,
    comparison: compareLanes({ gpt: { metrics: metrics.gpt, records: gpt }, jev: { metrics: metrics.jev, records: jev } }),
    records: { gpt, jev },
  }
}

describe('csvCell', () => {
  it('quotes commas, quotes and line breaks (RFC 4180)', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
    expect(csvCell('line1\r\nline2')).toBe('"line1\r\nline2"')
  })

  it('renders numbers, booleans and empties', () => {
    expect(csvCell(12.5)).toBe('12.5')
    expect(csvCell(0)).toBe('0')
    expect(csvCell(Number.NaN)).toBe('')
    expect(csvCell(Number.POSITIVE_INFINITY)).toBe('')
    expect(csvCell(true)).toBe('true')
    expect(csvCell(false)).toBe('false')
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })

  it('neutralizes spreadsheet formulas in text but not in numbers', () => {
    expect(csvCell('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)")
    expect(csvCell('@cmd')).toBe("'@cmd")
    expect(csvCell('-cmd, x')).toBe('"\'-cmd, x"')
    expect(csvCell(-3)).toBe('-3')
  })

  it('csvLine joins cells with commas', () => {
    expect(csvLine(['a', 1, null, 'b,c'])).toBe('a,1,,"b,c"')
  })
})

/** Minimal RFC 4180 parser, to check the file round-trips. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      i++
    } else cell += ch
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

describe('buildExportCsv', () => {
  const input = makeInput()
  const csv = buildExportCsv(input)

  it('starts with a UTF-8 BOM and ends with a CRLF', () => {
    expect(csv.startsWith(CSV_BOM)).toBe(true)
    expect(csv.endsWith('\r\n')).toBe(true)
  })

  const rows = parseCsv(csv.slice(CSV_BOM.length))
  const header = rows[0]
  const col = (row: string[], name: (typeof CSV_COLUMNS)[number]) => row[header.indexOf(name)]

  it('has the documented columns and one row per record of both lanes', () => {
    expect(header).toEqual([...CSV_COLUMNS])
    expect(rows).toHaveLength(1 + 4 + 4)
    for (const row of rows) expect(row).toHaveLength(CSV_COLUMNS.length)
  })

  it('writes GPT first, then Jev, in queue order', () => {
    expect(rows.slice(1).map((r) => `${col(r, 'engine')}:${col(r, 'index')}`)).toEqual([
      'gpt:0', 'gpt:1', 'gpt:2', 'gpt:3', 'jev:0', 'jev:1', 'jev:2', 'jev:3',
    ])
  })

  it('looks the concept up and survives commas, quotes and new lines', () => {
    const concepts = rows.slice(1, 5).map((r) => col(r, 'concept'))
    expect(concepts).toEqual(['Servicio de energía, marzo', 'Taxi "aeropuerto"', 'Papelería\ny útiles', "'=HYPERLINK(\"x\")"])
  })

  it('recomputes correct from the record and leaves empty cells for missing values', () => {
    const [ok, wrong, timeout] = rows.slice(1, 4)
    expect(col(ok, 'correct')).toBe('true')
    expect(col(wrong, 'correct')).toBe('false')
    expect(col(wrong, 'predicted')).toBe('B')
    expect(col(timeout, 'correct')).toBe('false')
    expect(col(timeout, 'predicted')).toBe('')
    expect(col(timeout, 'status')).toBe('timeout')
    expect(col(timeout, 'errorMessage')).toBe('Tiempo agotado, reintenta\n"ya"')
    expect(col(timeout, 'confidence')).toBe('0.8')
    expect(col(ok, 'inputTokens')).toBe('100')
    expect(col(ok, 'outputTokens')).toBe('5')
    expect(col(ok, 'costUsd')).toBe('0.0001')
    expect(col(wrong, 'inputTokens')).toBe('')
    expect(col(wrong, 'nativeConfidence')).toBe('0.42')
    expect(col(wrong, 'nativeConfidenceKind')).toBe('logprob')
    expect(col(ok, 'difficulty')).toBe('easy')
    expect(col(rows[4], 'providerLatencyMs')).toBe('812')
    expect(col(rows[6], 'nativeConfidenceKind')).toBe('jev_confidence')
    expect(col(ok, 'mode')).toBe('live')
    expect(col(ok, 'model')).toBe('gpt-4.1-mini')
  })
})

describe('buildExportJson', () => {
  const now = new Date('2026-05-04T10:20:30Z')
  const input = makeInput()
  const parsed = JSON.parse(buildExportJson(input, { now }))

  it('has the documented top-level shape', () => {
    expect(Object.keys(parsed)).toEqual(
      expect.arrayContaining([
        'exportedAt',
        'app',
        'dataset',
        'task',
        'config',
        'engines',
        'metrics',
        'comparison',
        'validForComparison',
        'records',
      ]),
    )
    expect(parsed.exportedAt).toBe('2026-05-04T10:20:30.000Z')
    expect(parsed.app).toBe('jev-classify-lab')
    expect(parsed.dataset).toEqual({ id: 'ds', name: 'Dataset de prueba' })
    expect(parsed.task.categories).toHaveLength(CATEGORIES.length)
    expect(parsed.config.repetitions).toBe(DEFAULT_BENCH_CONFIG.repetitions)
  })

  it('reports mode and model per engine (lane model first, then the run pick)', () => {
    expect(parsed.engines).toEqual({
      gpt: { mode: 'live', model: 'gpt-4.1-mini' },
      jev: { mode: 'live', model: 'jev-1.13' },
    })
  })

  it('includes both lanes metrics and the whole comparison', () => {
    expect(parsed.metrics.gpt.counts.completed).toBe(4)
    expect(parsed.metrics.jev.score.accuracy).toBeCloseTo(0.75)
    expect(Object.keys(parsed.comparison).sort()).toEqual(['overall', 'paired', 'pillars', 'rows', 'validity'])
    expect(parsed.comparison.rows.length).toBeGreaterThan(5)
    expect(parsed.validForComparison).toBe(true)
  })

  it('exports every record of both lanes, with items and raw payloads', () => {
    expect(parsed.records).toHaveLength(8)
    expect(parsed.records[0].engine).toBe('gpt')
    expect(parsed.records[4].engine).toBe('jev')
    expect(parsed.records[0].raw).toEqual({ request: { engine: 'gpt', index: 0 }, response: { ok: true } })
    expect(parsed.rawIncluded).toBe(true)
    expect(parsed.items).toHaveLength(4)
    expect(parsed.items[3].concept).toBe('=HYPERLINK("x")')
    expect(parsed.items[0].rationale).toBe('Porque sí')
  })

  it('omits raw payloads on request, and nothing else', () => {
    const light = buildExportPayload(input, { includeRaw: false, now })
    expect(light.rawIncluded).toBe(false)
    expect(light.records).toHaveLength(8)
    for (const r of light.records) expect('raw' in r).toBe(false)
    expect(light.records[1]).toMatchObject({ predicted: 'B', nativeConfidenceKind: 'logprob' })
    // The input is not mutated.
    expect(input.records.gpt[0].raw).toBeDefined()
    expect(JSON.parse(buildExportJson(input, { includeRaw: false, now })).records[0].raw).toBeUndefined()
  })

  it('flags simulated runs as not valid for comparison', () => {
    const mock = JSON.parse(buildExportJson(makeInput({ gpt: 'mock', jev: 'live' }), { now }))
    expect(mock.validForComparison).toBe(false)
    expect(mock.comparison.validity.warnings.length).toBeGreaterThan(0)
  })

  it('has no comparison and is not valid before both lanes have records', () => {
    const base = makeInput()
    const alone = JSON.parse(
      buildExportJson({ ...base, comparison: null, records: { gpt: base.records.gpt, jev: [] } }, { now }),
    )
    expect(alone.comparison).toBeNull()
    expect(alone.validForComparison).toBe(false)
    expect(alone.records).toHaveLength(4)
  })
})

describe('orderedRecords', () => {
  it('sorts each lane by queue index and repetition without touching the input', () => {
    const gpt = [makeRecord({ engine: 'gpt', index: 2 }), makeRecord({ engine: 'gpt', index: 0 }), makeRecord({ engine: 'gpt', index: 0, repetition: 1 })]
    const jev = [makeRecord({ engine: 'jev', index: 1 })]
    const out = orderedRecords({ gpt, jev })
    expect(out.map((r) => `${r.engine}:${r.index}:${r.repetition}`)).toEqual(['gpt:0:0', 'gpt:0:1', 'gpt:2:0', 'jev:1:0'])
    expect(gpt[0].index).toBe(2)
  })
})

describe('exportFilename', () => {
  it('uses the local date and time as YYYYMMDD-HHmm', () => {
    expect(exportFilename('json', new Date(2026, 0, 2, 3, 4, 59))).toBe('jev-classify-lab-20260102-0304.json')
    expect(exportFilename('csv', new Date(2026, 10, 25, 17, 45))).toBe('jev-classify-lab-20261125-1745.csv')
  })
})
