/** Small form / feedback primitives shared by the layout and lane components. */
import clsx from 'clsx'
import { useState } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { UI } from '../ui/theme.ts'
import { FOCUS_RING, INPUT_CLASS, TONE_CLASS, type Tone } from './styles.ts'

export function Chip({ tone = 'neutral', children, title, className }: { tone?: Tone; children: ReactNode; title?: string; className?: string }) {
  return (
    <span
      title={title}
      className={clsx('inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs leading-none font-medium', TONE_CLASS[tone], className)}
    >
      {children}
    </span>
  )
}

export function Field({
  label,
  hint,
  as: Tag = 'label',
  children,
  className,
}: {
  label: ReactNode
  hint?: string
  as?: 'label' | 'div'
  children: ReactNode
  className?: string
}) {
  return (
    <Tag className={clsx('flex min-w-0 flex-col gap-1', className)} title={hint} {...(Tag === 'div' ? { role: 'group' } : {})}>
      <span className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 dark:text-zinc-400">{label}</span>
      {children}
    </Tag>
  )
}

/**
 * Number input that keeps what the user is typing while the committed value is clamped by the
 * store. The draft is dropped on blur, so the field shows the real (clamped) value again.
 * With `allowEmpty`, clearing the field commits `undefined`.
 */
export function NumberField({
  value,
  onCommit,
  min,
  max,
  step = 1,
  disabled,
  className,
  ariaLabel,
  placeholder,
  allowEmpty = false,
}: {
  value: number | undefined
  onCommit: (value: number | undefined) => void
  min: number
  max: number
  step?: number
  disabled?: boolean
  className?: string
  ariaLabel?: string
  placeholder?: string
  allowEmpty?: boolean
}) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      type="number"
      inputMode="decimal"
      aria-label={ariaLabel}
      placeholder={placeholder}
      className={clsx(INPUT_CLASS, className)}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      value={draft ?? (value === undefined ? '' : String(value))}
      onChange={(e) => {
        setDraft(e.target.value)
        if (e.target.value.trim() === '') {
          if (allowEmpty) onCommit(undefined)
          return
        }
        const n = e.target.valueAsNumber
        if (Number.isFinite(n)) onCommit(n)
      }}
      onBlur={() => setDraft(null)}
    />
  )
}

export interface SegmentOption<T extends string | number> {
  value: T
  label: ReactNode
  /** Tooltip (kept on a wrapper: disabled buttons do not always show their own `title`). */
  title?: string
  disabled?: boolean
  /** Classes of the selected state (overrides the default dark fill). */
  activeClass?: string
}

const SEGMENT_ACTIVE = 'bg-zinc-900 font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900'

/** Segmented toggle (`aria-pressed` buttons) with per-option tooltip / disabled state. */
export function SegmentedControl<T extends string | number>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T
  options: ReadonlyArray<SegmentOption<T>>
  onChange: (value: T) => void
  label: string
  disabled?: boolean
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex h-8 shrink-0 overflow-hidden rounded-md border border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900"
    >
      {options.map((o) => {
        const active = o.value === value
        const off = disabled || o.disabled
        return (
          <span key={String(o.value)} title={o.title} className="inline-flex">
            <button
              type="button"
              aria-pressed={active}
              disabled={off}
              onClick={() => onChange(o.value)}
              className={clsx(
                'px-3 text-xs tabular-nums transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-500',
                active ? (o.activeClass ?? SEGMENT_ACTIVE) : 'text-zinc-600 dark:text-zinc-300',
                off ? 'cursor-not-allowed' : !active && 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
                off && !active && 'opacity-40',
                off && active && 'opacity-70',
              )}
            >
              {o.label}
            </button>
          </span>
        )
      })}
    </div>
  )
}

type ButtonVariant = 'primary' | 'default' | 'danger'

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: UI.buttonPrimary,
  default: UI.button,
  danger:
    'inline-flex items-center gap-1.5 rounded-md border border-rose-300 bg-white px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-900 dark:bg-zinc-900 dark:text-rose-300 dark:hover:bg-rose-950/40',
}

export function ActionButton({ variant = 'default', className, ...props }: { variant?: ButtonVariant } & ComponentProps<'button'>) {
  return <button type="button" {...props} className={clsx(BUTTON_VARIANT[variant], 'h-8 justify-center', FOCUS_RING, className)} />
}
