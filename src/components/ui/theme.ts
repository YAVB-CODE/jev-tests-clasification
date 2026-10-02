/**
 * Shared visual tokens for every UI module (lanes, comparison, detail, dataset, quick test).
 * Tailwind 4 with the default `dark:` variant (prefers-color-scheme). Keep engine colors
 * consistent everywhere: GPT = teal (left lane), Jev = violet (right lane).
 * Correctness is never color-only: always pair it with an icon/text (✓ / ✗ / !).
 */
import type { EngineId } from '../../shared/contracts.ts'

export interface EngineTheme {
  /** Short display name. */
  label: string
  /** Who serves it, for subtitles. */
  vendor: string
  /** Accent text, e.g. lane titles and values. */
  text: string
  /** Soft background for lane headers / chips. */
  soft: string
  /** Border for lane cards. */
  border: string
  /** Solid fill: progress bars, dots, primary marks (same color as `chart`). */
  solid: string
  /** Series color for charts / SVG (`fill`, `stroke`): the CSS variable of `ENGINE_COLORS`. */
  chart: string
}

/**
 * The single source of the engine series colors, validated with the dataviz palette validator on each
 * surface (≥ 3:1 for graphics): light on #ffffff, dark on #18181b. The lane accent teal-500 (#14b8a6)
 * is only 2.5:1 on white, hence the darker light step. index.css defines `--engine-gpt` / `--engine-jev`
 * with exactly these values (dark ones under prefers-color-scheme: dark), so SVG attributes and
 * Tailwind classes follow the color scheme without re-rendering.
 */
export const ENGINE_COLORS: Record<EngineId, { light: string; dark: string; cssVar: string }> = {
  gpt: { light: '#0d9488', dark: '#10a393', cssVar: '--engine-gpt' },
  jev: { light: '#7c3aed', dark: '#8b5cf6', cssVar: '--engine-jev' },
}

export const ENGINE_THEME: Record<EngineId, EngineTheme> = {
  gpt: {
    label: 'GPT',
    vendor: 'OpenAI · LLM tradicional',
    text: 'text-teal-700 dark:text-teal-300',
    soft: 'bg-teal-50 dark:bg-teal-950/40',
    border: 'border-teal-200 dark:border-teal-900',
    solid: 'bg-(--engine-gpt)',
    chart: 'var(--engine-gpt)',
  },
  jev: {
    label: 'Jev',
    vendor: 'OpenCode Zen · System One',
    text: 'text-violet-700 dark:text-violet-300',
    soft: 'bg-violet-50 dark:bg-violet-950/40',
    border: 'border-violet-200 dark:border-violet-900',
    solid: 'bg-(--engine-jev)',
    chart: 'var(--engine-jev)',
  },
}

/** Outcome styles (always with an icon/label next to the color). */
export const OUTCOME_STYLE = {
  correct: { icon: '✓', label: 'Acierto', text: 'text-green-700 dark:text-green-400', soft: 'bg-green-50 dark:bg-green-950/40' },
  wrong: { icon: '✗', label: 'Error', text: 'text-rose-700 dark:text-rose-400', soft: 'bg-rose-50 dark:bg-rose-950/40' },
  failed: { icon: '!', label: 'Sin respuesta', text: 'text-amber-700 dark:text-amber-400', soft: 'bg-amber-50 dark:bg-amber-950/40' },
} as const

/** Base surfaces and text. */
export const UI = {
  page: 'min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100',
  card: 'rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900',
  cardPadding: 'p-4',
  muted: 'text-zinc-500 dark:text-zinc-400',
  label: 'text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400',
  input:
    'rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900 disabled:opacity-50',
  button:
    'inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800',
  buttonPrimary:
    'inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300',
  badge: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
  /** Chart grid/axis color that works on both themes. */
  chartGrid: '#a1a1aa55',
  chartAxis: '#71717a',
} as const
