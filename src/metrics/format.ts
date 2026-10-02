/**
 * es-CO number formatting for the metrics UI and the verdict texts: decimal comma, thousands dot,
 * typographic minus (U+2212). Implemented by hand (no Intl) so output is identical in every
 * browser / Node build and easy to assert in tests.
 */
import type { ComparisonRow, RowFormat } from './compare.ts'

export const DASH = '—'
const MINUS = '−'

type Maybe = number | null | undefined

function finite(v: Maybe): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Fixed decimals in es-CO: 1234.5 → "1.234,5"; negatives with "−"; −0 → "0". */
export function fixed(v: number, digits: number): string {
  const s = Math.abs(v).toFixed(digits)
  const [int, dec] = s.split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const body = dec !== undefined ? `${grouped},${dec}` : grouped
  const isZero = /^[0.,]+$/.test(body)
  return v < 0 && !isZero ? `${MINUS}${body}` : body
}

/** Plain number, default 3 decimals: 0.1234 → "0,123". */
export function num(v: Maybe, digits = 3): string {
  return finite(v) ? fixed(v, digits) : DASH
}

/** Integer with thousands separator: 12345 → "12.345". */
export function int(v: Maybe): string {
  return finite(v) ? fixed(Math.round(v), 0) : DASH
}

/** Fraction → percentage: 0.333 → "33,3 %". */
export function pct(v: Maybe, digits = 1): string {
  return finite(v) ? `${fixed(v * 100, digits)} %` : DASH
}

/** Signed percentage points from a difference of fractions: 0.033 → "+3,3 pp"; −0.02 → "−2,0 pp". */
export function pp(delta: Maybe, digits = 1): string {
  if (!finite(delta)) return DASH
  const body = fixed(delta * 100, digits)
  const zero = !/[1-9]/.test(body)
  return `${delta > 0 && !zero ? '+' : ''}${body} pp`
}

/** Wall-clock duration from ms: "12,3 s", "2 min 05 s", "1 h 02 min". */
export function seconds(msValue: Maybe): string {
  if (!finite(msValue)) return DASH
  const sign = msValue < 0 ? MINUS : ''
  const abs = Math.abs(msValue)
  // Compare on the rounded value so 59 960 ms reads "1 min 00 s", not "60,0 s".
  if (abs < 59_950) return `${sign}${fixed(abs / 1000, 1)} s`
  const totalS = Math.round(abs / 1000)
  if (totalS < 3600) {
    const m = Math.floor(totalS / 60)
    return `${sign}${m} min ${String(totalS - m * 60).padStart(2, '0')} s`
  }
  const totalM = Math.round(abs / 60_000)
  const h = Math.floor(totalM / 60)
  return `${sign}${h} h ${String(totalM - h * 60).padStart(2, '0')} min`
}

/** Latency from ms: "842 ms", "1,24 s", "12,3 s"; a minute or more → `seconds`. */
export function ms(v: Maybe): string {
  if (!finite(v)) return DASH
  const abs = Math.abs(v)
  if (abs < 999.5) return `${fixed(Math.round(v), 0)} ms`
  if (abs < 9_995) return `${fixed(v / 1000, 2)} s`
  if (abs < 59_950) return `${fixed(v / 1000, 1)} s`
  return seconds(v)
}

/** US dollars; sub-cent amounts keep 2 significant digits: 0.00004 → "US$ 0,000040". */
export function usd(v: Maybe): string {
  if (!finite(v)) return DASH
  const sign = v < 0 ? MINUS : ''
  const abs = Math.abs(v)
  if (abs === 0) return 'US$ 0,00'
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : Math.min(12, Math.ceil(-Math.log10(abs)) + 1)
  return `${sign}US$ ${fixed(abs, digits)}`
}

/** p-value: "p < 0,001", "p = 0,039", "p = 0,52". */
export function pValue(p: Maybe): string {
  if (!finite(p)) return DASH
  if (p < 0.001) return 'p < 0,001'
  return `p = ${fixed(Math.min(1, p), p < 0.1 ? 3 : 2)}`
}

/** Speed-up / cost ratio: 2.437 → "2,4×". */
export function times(v: Maybe, digits = 1): string {
  return finite(v) ? `${fixed(v, digits)}×` : DASH
}

/** Format a raw metric value according to a row format. */
export function formatValue(v: Maybe, format: RowFormat, digits?: number): string {
  switch (format) {
    case 'pct':
      return pct(v, digits ?? 1)
    case 'ms':
      return ms(v)
    case 'num':
      return num(v, digits ?? 3)
    case 'usd':
      return usd(v)
    case 'p':
      return pValue(v)
  }
}

/** Display value of one side of a comparison row ("—" when missing). */
export function formatRowValue(row: Pick<ComparisonRow, 'format' | 'digits' | 'gpt' | 'jev'>, side: 'gpt' | 'jev'): string {
  return formatValue(row[side], row.format, row.digits)
}
