import { describe, expect, it } from 'vitest'
import { DASH, fixed, formatRowValue, int, ms, num, pValue, pct, pp, seconds, times, usd } from './format.ts'

describe('es-CO number formatting', () => {
  it('fixed / num / int use decimal comma and thousands dot', () => {
    expect(fixed(1234567.891, 2)).toBe('1.234.567,89')
    expect(fixed(-0.5, 1)).toBe('−0,5')
    expect(fixed(-0.0001, 2)).toBe('0,00') // no "−0,00"
    expect(num(0.12345)).toBe('0,123')
    expect(num(2.5, 1)).toBe('2,5')
    expect(int(12345.6)).toBe('12.346')
    expect(num(null)).toBe(DASH)
    expect(num(Number.NaN)).toBe(DASH)
  })

  it('pct and pp', () => {
    expect(pct(0.3333)).toBe('33,3 %')
    expect(pct(1)).toBe('100,0 %')
    expect(pct(0.8, 0)).toBe('80 %')
    expect(pct(undefined)).toBe(DASH)
    expect(pp(0.0333)).toBe('+3,3 pp')
    expect(pp(-0.02)).toBe('−2,0 pp')
    expect(pp(0)).toBe('0,0 pp')
    expect(pp(0.00001)).toBe('0,0 pp') // rounds to zero → no sign
  })

  it('ms for latencies', () => {
    expect(ms(842.4)).toBe('842 ms')
    expect(ms(999.4)).toBe('999 ms')
    expect(ms(999.6)).toBe('1,00 s')
    expect(ms(1240)).toBe('1,24 s')
    expect(ms(12_345)).toBe('12,3 s')
    expect(ms(125_000)).toBe('2 min 05 s')
    expect(ms(null)).toBe(DASH)
  })

  it('seconds for wall time', () => {
    expect(seconds(45_200)).toBe('45,2 s')
    expect(seconds(59_960)).toBe('1 min 00 s')
    expect(seconds(125_000)).toBe('2 min 05 s')
    expect(seconds(3_720_000)).toBe('1 h 02 min')
  })

  it('usd keeps sub-cent amounts readable', () => {
    expect(usd(0)).toBe('US$ 0,00')
    expect(usd(12.345)).toBe('US$ 12,35')
    expect(usd(0.0123)).toBe('US$ 0,0123')
    expect(usd(0.00004)).toBe('US$ 0,000040')
    expect(usd(0.0059)).toBe('US$ 0,0059')
    expect(usd(-0.5)).toBe('−US$ 0,5000')
    expect(usd(undefined)).toBe(DASH)
  })

  it('pValue and times', () => {
    expect(pValue(0.0386)).toBe('p = 0,039')
    expect(pValue(0.52)).toBe('p = 0,52')
    expect(pValue(1)).toBe('p = 1,00')
    expect(pValue(0.0004)).toBe('p < 0,001')
    expect(pValue(null)).toBe(DASH)
    expect(times(2.437)).toBe('2,4×')
  })

  it('formatRowValue follows the row format', () => {
    const base = { gpt: 0.75, jev: null, digits: undefined }
    expect(formatRowValue({ ...base, format: 'pct' }, 'gpt')).toBe('75,0 %')
    expect(formatRowValue({ ...base, format: 'pct' }, 'jev')).toBe(DASH)
    expect(formatRowValue({ ...base, format: 'num', digits: 1 }, 'gpt')).toBe('0,8')
    expect(formatRowValue({ gpt: 1500, jev: 320, format: 'ms' }, 'jev')).toBe('320 ms')
    expect(formatRowValue({ gpt: 0.002, jev: 0, format: 'usd' }, 'gpt')).toBe('US$ 0,0020')
    expect(formatRowValue({ gpt: 0.04, jev: 0.04, format: 'p' }, 'gpt')).toBe('p = 0,040')
  })
})
