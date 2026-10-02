import clsx from 'clsx'
import { selectCanConfigure, useBench } from '../../bench/useBench.ts'
import { ENGINE_IDS, type EngineId } from '../../shared/contracts.ts'
import { ENGINE_THEME } from '../ui/theme.ts'
import { ActionButton, Chip } from './controls.tsx'
import { LIVE_UNAVAILABLE_HINT } from './labels.ts'

/** Health of one engine: live (key configured) or simulated only, with the model picked for its lane. */
function HealthChip({ engine }: { engine: EngineId }) {
  const health = useBench((s) => s.health)
  const loading = useBench((s) => s.healthLoading)
  // The lane's model (picker choice, else the server default): what Live will use, not just the .env default.
  const laneModel = useBench((s) => s.lanes[engine].model)
  const theme = ENGINE_THEME[engine]
  const info = health?.engines[engine]
  const model = laneModel || info?.model || ''
  const isServerDefault = Boolean(info?.model) && model === info?.model

  let tone: 'neutral' | 'ok' | 'warn' = 'neutral'
  let text = 'comprobando…'
  let title = `Consultando /api/health para ${theme.label}`
  if (health) {
    if (!health.ok) {
      tone = 'warn'
      text = 'sin servidor · solo simulado'
      title = 'No se pudo contactar al backend (/api/health). Los carriles solo pueden correr en modo simulado.'
    } else if (info?.live) {
      tone = 'ok'
      text = 'live'
      title = `${theme.label} puede correr en modo Live${model ? ` con ${model}` : ''}${info.provider ? ` vía ${info.provider}` : ''}${
        model && !isServerDefault && info.model ? ` (elegido en el selector; por defecto del servidor: ${info.model})` : model ? ' (modelo por defecto del servidor)' : ''
      }.`
    } else {
      tone = 'warn'
      text = 'sin key · solo simulado'
      title = `${theme.label} solo puede correr simulado. ${LIVE_UNAVAILABLE_HINT[engine]}`
    }
  }

  return (
    <Chip tone={tone} title={title} className={clsx('gap-2 py-1.5', loading && 'opacity-70')}>
      <span aria-hidden className={clsx('size-2 shrink-0 rounded-full', theme.solid)} />
      <span className={clsx('font-semibold', theme.text)}>{theme.label}</span>
      <span>{text}</span>
      {health?.ok && info?.live && model && (
        <span className="hidden font-mono text-[11px] opacity-80 sm:inline">
          {model}
          {isServerDefault ? ' (por defecto)' : ''}
          {info.provider ? ` · ${info.provider}` : ''}
        </span>
      )}
    </Chip>
  )
}

export function Header() {
  const warnings = useBench((s) => s.health?.warnings)
  const loading = useBench((s) => s.healthLoading || s.modelsLoading)
  const refreshHealth = useBench((s) => s.refreshHealth)
  const refreshModels = useBench((s) => s.refreshModels)
  // Mid-run, /api/health + /api/models would take browser connections from the benchmark requests.
  const canConfigure = useBench(selectCanConfigure)

  const retry = (): void => {
    void refreshHealth()
    void refreshModels(false)
  }

  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2.5 text-2xl leading-tight font-semibold tracking-tight">
            <span aria-hidden className="inline-flex h-7 w-7 items-center justify-center overflow-hidden rounded-md">
              <img src="/favicon.svg" alt="" className="size-7" />
            </span>
            Jev Classify Lab
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Conceptos de factura → PUC · GPT vs Jev</p>
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Estado de los motores">
          {ENGINE_IDS.map((id) => (
            <HealthChip key={id} engine={id} />
          ))}
          <ActionButton
            className="px-2.5 text-xs"
            onClick={retry}
            disabled={loading || !canConfigure}
            title={
              canConfigure
                ? 'Volver a consultar /api/health y la lista de modelos (p. ej. después de guardar .env)'
                : 'Espera a que termine la corrida: consultar el servidor usaría conexiones extra y alteraría las latencias.'
            }
            aria-label="Reintentar la conexión con el servidor"
          >
            <span aria-hidden className={clsx(loading && 'animate-spin')}>
              ⟳
            </span>
            {loading ? 'Consultando…' : 'Reintentar'}
          </ActionButton>
        </div>
      </div>

      {warnings && warnings.length > 0 && (
        <ul
          role="status"
          aria-label="Avisos del servidor"
          className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        >
          {warnings.map((warning, i) => (
            <li key={`${i}-${warning}`} className="flex gap-2">
              <span aria-hidden>⚠</span>
              <span className="min-w-0 break-words">{warning}</span>
            </li>
          ))}
        </ul>
      )}
    </header>
  )
}
