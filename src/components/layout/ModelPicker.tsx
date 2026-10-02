import clsx from 'clsx'
import { selectCanConfigure, selectLiveAvailable, useBench } from '../../bench/useBench.ts'
import type { EngineId } from '../../shared/contracts.ts'
import { ENGINE_THEME } from '../ui/theme.ts'
import { ActionButton } from './controls.tsx'
import { INPUT_CLASS } from './styles.ts'
import { modelOptionLabel } from './labels.ts'

/** Per-lane model dropdown fed by GET /api/models (price per MTok, reasoning mark) plus a reload button. */
export function ModelPicker({ engine }: { engine: EngineId }) {
  const catalogue = useBench((s) => s.models?.[engine])
  const model = useBench((s) => s.lanes[engine].model)
  const mode = useBench((s) => s.lanes[engine].mode)
  const live = useBench((s) => selectLiveAvailable(s, engine))
  const canConfigure = useBench(selectCanConfigure)
  const loading = useBench((s) => s.modelsLoading)
  const modelsError = useBench((s) => s.modelsError)
  const setLaneModel = useBench((s) => s.setLaneModel)
  const refreshModels = useBench((s) => s.refreshModels)

  const name = ENGINE_THEME[engine].label
  const defaultId = catalogue?.default
  const value = model ?? defaultId ?? ''
  const disabled = !canConfigure || !live || !catalogue

  let title = `Modelo que usa ${name} en modo Live. Precios en USD por millón de tokens (MTok).`
  if (!canConfigure) title = 'El modelo no se puede cambiar mientras corre el benchmark.'
  else if (!live) title = `Sin API key de ${name}: solo hay modo simulado, así que no hay modelo que elegir.`
  else if (!catalogue) title = loading ? 'Cargando modelos…' : `No se pudo cargar la lista de modelos${modelsError ? `: ${modelsError}` : ''}.`
  else if (catalogue.source === 'fallback') {
    title += ` Lista interna${catalogue.error ? ` (el proveedor no respondió: ${catalogue.error})` : ''}; los precios pueden estar desactualizados.`
  }
  if (mode === 'mock' && live && canConfigure) title += ' El carril está en Simulado: el modelo se usará al pasar a Live.'

  return (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      <select
        aria-label={`Modelo de ${name}`}
        title={title}
        className={clsx(INPUT_CLASS, 'min-w-0 flex-1 truncate font-mono text-xs', mode === 'mock' && 'opacity-60')}
        value={value}
        disabled={disabled}
        onChange={(e) => setLaneModel(engine, e.target.value || undefined)}
      >
        {!catalogue && <option value={value}>{value || (loading ? 'cargando…' : 'sin lista de modelos')}</option>}
        {catalogue && !catalogue.models.some((m) => m.id === value) && value && <option value={value}>{value}</option>}
        {catalogue?.models.map((m) => (
          <option key={m.id} value={m.id}>
            {modelOptionLabel(engine, m, m.id === defaultId)}
          </option>
        ))}
      </select>
      <ActionButton
        aria-label={`Recargar los modelos de ${name}`}
        title="Volver a pedir la lista de modelos al proveedor"
        className="w-8 px-0 text-sm"
        disabled={!canConfigure || loading}
        onClick={() => void refreshModels(true)}
      >
        <span aria-hidden className={clsx(loading && 'animate-spin')}>
          ⟳
        </span>
      </ActionButton>
      {(catalogue?.source === 'fallback' || (!catalogue && modelsError)) && live && (
        <span className="text-xs text-amber-600 dark:text-amber-400" title={title} role="img" aria-label="Lista de modelos interna o no disponible">
          !
        </span>
      )}
    </span>
  )
}
