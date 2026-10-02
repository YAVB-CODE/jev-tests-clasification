/** Shared class names for the dataset manager controls (built on the common UI tokens). */
import clsx from 'clsx'
import { UI } from '../ui/theme.ts'

export const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500'

export const inputClass = clsx(UI.input, 'w-full', FOCUS)
export const buttonClass = clsx(UI.button, FOCUS)
export const primaryButtonClass = clsx(UI.buttonPrimary, FOCUS)
export const dangerButtonClass = clsx(
  'inline-flex items-center gap-1.5 rounded-md border border-rose-300 bg-white px-3 py-1.5 text-sm font-medium text-rose-700',
  'hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-900 dark:bg-zinc-900 dark:text-rose-400 dark:hover:bg-rose-950/40',
  FOCUS,
)
/** Compact text-like button for table rows. */
export const linkButtonClass = clsx(
  'rounded px-1 py-0.5 text-xs font-medium text-sky-700 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-40 dark:text-sky-400',
  FOCUS,
)
export const linkDangerClass = clsx(
  'rounded px-1 py-0.5 text-xs font-medium text-rose-700 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-40 dark:text-rose-400',
  FOCUS,
)
