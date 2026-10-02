/** Small presentational pieces shared by the dataset manager panels. */
import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { UI } from '../ui/theme.ts'
import { linkButtonClass } from './styles.ts'

interface FieldProps {
  label: string
  required?: boolean
  hint?: ReactNode
  className?: string
  children: ReactNode
}

/** Label + control; the label wraps the control so the association is implicit. */
export function Field({ label, required, hint, className, children }: FieldProps) {
  return (
    <div className={className}>
      <label className="block">
        <span className={UI.label}>
          {label}
          {required ? <span aria-hidden="true"> *</span> : null}
        </span>
        <span className="mt-1 block">{children}</span>
      </label>
      {hint ? <p className={clsx('mt-1 text-xs', UI.muted)}>{hint}</p> : null}
    </div>
  )
}

type Tone = 'info' | 'warn' | 'error' | 'success'

const TONE: Record<Tone, string> = {
  info: 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200',
  warn: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
  error: 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200',
  success: 'border-green-200 bg-green-50 text-green-900 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200',
}

const TONE_ICON: Record<Tone, string> = { info: 'i', warn: '!', error: '✗', success: '✓' }

interface NoticeProps {
  tone: Tone
  children: ReactNode
  className?: string
}

/** Inline message box. Errors are announced (`role="alert"`), the rest politely (`role="status"`). */
export function Notice({ tone, children, className }: NoticeProps) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={clsx('flex items-start gap-2 rounded-lg border px-3 py-2 text-sm', TONE[tone], className)}
    >
      <span aria-hidden="true" className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-current text-[10px] font-bold">
        {TONE_ICON[tone]}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** Bulleted messages, optionally scrollable (long import error lists). */
export function MessageList({ messages, className }: { messages: readonly string[]; className?: string }) {
  return (
    <ul className={clsx('list-disc space-y-0.5 pl-5 text-sm', className)}>
      {messages.map((message, index) => (
        <li key={`${index}-${message}`} className="break-words">
          {message}
        </li>
      ))}
    </ul>
  )
}

/** Long text clamped to two lines with a «Ver más» toggle (only when it is long). */
export function ExpandableText({ text, limit = 110, className }: { text: string; limit?: number; className?: string }) {
  const [open, setOpen] = useState(false)
  if (text.length <= limit) return <span className={className}>{text}</span>
  return (
    <span className={className}>
      <span className={clsx('block whitespace-pre-wrap break-words', !open && 'line-clamp-2')}>{text}</span>
      <button type="button" className={clsx(linkButtonClass, '-ml-1')} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? 'Ver menos' : 'Ver más'}
      </button>
    </span>
  )
}

/** Section card with a heading; `aria-labelledby` points at the heading. */
export function Section({
  id,
  title,
  description,
  actions,
  children,
}: {
  id: string
  title: string
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section aria-labelledby={id} className={clsx(UI.card, UI.cardPadding, 'space-y-3')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={id} className="text-base font-semibold">
            {title}
          </h2>
          {description ? <p className={clsx('mt-0.5 text-sm', UI.muted)}>{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  )
}
