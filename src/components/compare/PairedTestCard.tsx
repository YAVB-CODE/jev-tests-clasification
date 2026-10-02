/** Paired test: 2×2 table of hits per concept (both / only GPT / only Jev / neither) with p-value and a plain reading. */
import clsx from 'clsx'
import { SIGNIFICANCE_ALPHA, int, num, pValue, pct } from '../../metrics/index.ts'
import type { PairedTest } from '../../metrics/index.ts'
import { ENGINE_THEME, UI } from '../ui/theme.ts'
import { SECTION_CARD, SECTION_LEAD, SECTION_TITLE } from './compareTheme.ts'
import { pairShare, pairedInterpretation } from './panelData.ts'
import { EngineName } from './panelParts.tsx'

interface CellProps {
  label: string
  hint: string
  count: number
  pairs: number
  tone: 'neutral' | 'gpt' | 'jev'
}

function Cell({ label, hint, count, pairs, tone }: CellProps) {
  const toneClass =
    tone === 'gpt'
      ? clsx(ENGINE_THEME.gpt.soft, ENGINE_THEME.gpt.border)
      : tone === 'jev'
        ? clsx(ENGINE_THEME.jev.soft, ENGINE_THEME.jev.border)
        : 'border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/50'
  return (
    <td className={clsx('border p-3 align-top', toneClass)}>
      <span className="block text-2xl font-bold tabular-nums text-zinc-900 dark:text-zinc-50">{int(count)}</span>
      <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">{label}</span>
      <span className={clsx('block text-xs tabular-nums', UI.muted)}>
        {pairs > 0 ? `${pct(pairShare(count, pairs), 0)} de los pares · ` : ''}
        {hint}
      </span>
    </td>
  )
}

export function PairedTestCard({ paired }: { paired: PairedTest }) {
  const significant = paired.significant
  const unmatched = paired.unmatchedGpt + paired.unmatchedJev
  return (
    <section aria-labelledby="cmp-paired-title" className={SECTION_CARD}>
      <h3 id="cmp-paired-title" className={SECTION_TITLE}>
        Prueba pareada
      </h3>
      <p className={SECTION_LEAD}>
        Compara a los dos motores concepto por concepto: solo importan los casos donde uno acierta y el otro falla.{' '}
        {paired.pairs > 0 && `${int(paired.pairs)} ${paired.pairs === 1 ? 'par comparado' : 'pares comparados'}${paired.repetitions > 1 ? ` (${paired.repetitions} repeticiones)` : ''}.`}
      </p>

      <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="relative overflow-x-auto">
          <table className="w-full border-separate border-spacing-1 text-sm">
            <caption className="sr-only">Tabla 2×2 de aciertos de GPT y Jev sobre los mismos conceptos</caption>
            <thead>
              <tr>
                <td />
                <th scope="col" className="px-2 py-1 text-center text-xs font-medium text-zinc-600 dark:text-zinc-300">
                  <EngineName engine="jev" /> acierta
                </th>
                <th scope="col" className="px-2 py-1 text-center text-xs font-medium text-zinc-600 dark:text-zinc-300">
                  <EngineName engine="jev" /> falla
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row" className="px-2 py-1 text-right text-xs font-medium text-zinc-600 dark:text-zinc-300">
                  <EngineName engine="gpt" /> acierta
                </th>
                <Cell label="Ambos aciertan" hint="coinciden" count={paired.bothCorrect} pairs={paired.pairs} tone="neutral" />
                <Cell label="Solo GPT acierta" hint="Jev falla" count={paired.gptOnly} pairs={paired.pairs} tone="gpt" />
              </tr>
              <tr>
                <th scope="row" className="px-2 py-1 text-right text-xs font-medium text-zinc-600 dark:text-zinc-300">
                  <EngineName engine="gpt" /> falla
                </th>
                <Cell label="Solo Jev acierta" hint="GPT falla" count={paired.jevOnly} pairs={paired.pairs} tone="jev" />
                <Cell label="Ambos fallan" hint="coinciden" count={paired.bothWrong} pairs={paired.pairs} tone="neutral" />
              </tr>
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-3">
          <div
            className={clsx(
              'rounded-lg border px-3 py-2',
              paired.pairs === 0
                ? 'border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/50'
                : significant
                  ? 'border-green-200 bg-green-50 text-green-900 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200'
                  : 'border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/50',
            )}
          >
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{paired.testName}</p>
            <p className="mt-0.5 text-lg font-bold tabular-nums text-zinc-900 dark:text-zinc-50">
              {paired.pairs > 0 ? pValue(paired.pValue) : 'Sin pares'}
            </p>
            {paired.pairs > 0 && (
              <p className="text-sm text-zinc-700 dark:text-zinc-300">
                {significant ? '✓ Significativa' : '≈ No significativa'} con α = {num(SIGNIFICANCE_ALPHA, 2)}
              </p>
            )}
          </div>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{pairedInterpretation(paired)}</p>
          {unmatched > 0 && (
            <p className="text-xs text-amber-800 dark:text-amber-300">
              ⚠ {int(unmatched)} {unmatched === 1 ? 'registro no tiene' : 'registros no tienen'} par en el otro carril ({paired.unmatchedGpt} solo en GPT, {paired.unmatchedJev} solo en Jev) y se
              excluye de esta tabla.
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
