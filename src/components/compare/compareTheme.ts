/**
 * Visual tokens of the comparison panel.
 *
 * Series colors come from `ENGINE_THEME[e].chart` (ui/theme.ts → `ENGINE_COLORS`, the steps that pass
 * the dataviz validator on each surface), so every view uses the same engine colors. The surface / ink /
 * axis tokens are CSS variables set on the panel root, so SVG attributes follow `prefers-color-scheme`
 * without re-rendering. Identity is never color alone: GPT = circle / left, Jev = diamond / right, plus
 * legends, labels and a table twin per chart.
 */
import type { EngineId } from '../../shared/contracts.ts'
import { ENGINE_THEME, UI } from '../ui/theme.ts'

/** Tailwind arbitrary-property classes that define the variables (light, then dark). */
export const PANEL_VARS = [
  '[--cmp-surface:#ffffff] dark:[--cmp-surface:#18181b]',
  '[--cmp-ink:#18181b] dark:[--cmp-ink:#f4f4f5]',
  '[--cmp-axis:#52525b] dark:[--cmp-axis:#a1a1aa]',
].join(' ')

export const SERIES_COLOR: Record<EngineId, string> = { gpt: ENGINE_THEME.gpt.chart, jev: ENGINE_THEME.jev.chart }
/** Ring around marks, in the card surface color. */
export const SURFACE_COLOR = 'var(--cmp-surface)'
export const INK_COLOR = 'var(--cmp-ink)'

/** Hairline grid and axes (solid, recessive) from the shared UI tokens. */
export const GRID_STROKE = UI.chartGrid
export const AXIS_STROKE = UI.chartAxis
/** Tick text wears a text token (not the series color) with enough contrast on both surfaces. */
export const AXIS_TICK = { fill: 'var(--cmp-axis)', fontSize: 11 } as const
export const AXIS_LABEL = { fill: 'var(--cmp-axis)', fontSize: 11 } as const

export const PCT_TICKS: number[] = [0, 0.25, 0.5, 0.75, 1]
export const pctTick = (v: number): string => `${Math.round(v * 100)} %`

/** "850 ms", "1,2 s" for axis ticks. */
export function msTick(v: number): string {
  if (v >= 1000) return `${(Math.round(v / 100) / 10).toString().replace('.', ',')} s`
  return `${Math.round(v)} ms`
}

/** Section card used by every block of the panel. */
export const SECTION_CARD = `${UI.card} p-4 sm:p-5`
export const SECTION_TITLE = 'text-base font-semibold text-zinc-900 dark:text-zinc-100'
export const SECTION_LEAD = 'mt-0.5 text-sm text-zinc-500 dark:text-zinc-400'
