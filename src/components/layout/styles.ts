/** Class tokens shared by the layout controls (kept out of the component file for fast refresh). */
import clsx from 'clsx'
import { UI } from '../ui/theme.ts'

export const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500'

export const INPUT_CLASS = clsx(UI.input, 'h-8 tabular-nums', FOCUS_RING)

export type Tone = 'neutral' | 'info' | 'ok' | 'warn' | 'bad'

export const TONE_CLASS: Readonly<Record<Tone, string>> = {
  neutral: 'border-zinc-200 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  info: 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300',
  ok: 'border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300',
  warn: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  bad: 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300',
}
