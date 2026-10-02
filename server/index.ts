/**
 * Jev Classify Lab API — entry point. Loads `.env`, builds the adapters and listens on HOST:PORT
 * (default 127.0.0.1:8788: only this machine can reach the API that spends the keys).
 * Serves the built SPA from `dist/` when it exists (production: `npm run build` first).
 *
 * `.env` is hot-reloaded: editing it (keys, JEV_MODEL, OPENAI_MODEL, prices…) rebuilds the config and
 * the adapters in place, without restarting the process. Only PORT and HOST need a restart.
 * Secrets are never logged: only which engines are live and with which model.
 */
import { existsSync, readFileSync, watchFile } from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import { ENGINE_IDS, type EngineId } from '../src/shared/contracts.ts'
import { createAdapters } from './adapters/index.ts'
import type { Adapters } from './adapters/common.ts'
import { createApp } from './app.ts'
import { configWarnings, isLoopbackHost, loadConfig, type ServerConfig } from './env.ts'

const root = path.resolve(import.meta.dirname, '..')
const envFile = path.join(root, '.env')
/** Variables exported in the shell win over `.env`, same precedence as dotenv.config(). */
const shellEnv = { ...process.env }

function readConfig(): ServerConfig {
  const fileEnv = existsSync(envFile) ? dotenv.parse(readFileSync(envFile)) : {}
  return loadConfig({ ...fileEnv, ...shellEnv })
}

interface State {
  config: ServerConfig
  adapters: Adapters
  warnings: string[]
}

function buildState(config: ServerConfig): State {
  return { config, adapters: createAdapters(config), warnings: configWarnings(config) }
}

/** createApp reads this through getters on every request, so reloading just swaps the object. */
let state = buildState(readConfig())

function describeLanes(adapters: Adapters): string {
  const lane = (id: EngineId) => {
    const a = adapters[id]
    return `${id}: ${a.live ? 'LIVE' : 'sin key (solo simulado)'} · ${a.model}${a.provider ? ` vía ${a.provider}` : ''}`
  }
  return ENGINE_IDS.map(lane).join(' | ')
}

function reloadEnv() {
  const next = buildState(readConfig())
  const before = describeLanes(state.adapters)
  if (next.config.port !== state.config.port) {
    console.warn(`[api] ⚠ PORT cambió a ${next.config.port}: reinicia el API para aplicarlo`)
  }
  if (next.config.host !== state.config.host) {
    console.warn(`[api] ⚠ HOST cambió a ${next.config.host}: reinicia el API para aplicarlo`)
  }
  // The listening address stays the one we started with (and so do its warnings).
  const listening = { port: state.config.port, host: state.config.host }
  const config = { ...next.config, ...listening }
  state = { config, adapters: next.adapters, warnings: configWarnings(config) }
  const after = describeLanes(state.adapters)
  console.log(after === before ? '[api] .env recargado (sin cambios en los motores)' : `[api] .env recargado → ${after}`)
  for (const warning of state.warnings) console.warn(`[api] ⚠ ${warning}`)
}

// Polling (not fs.watch) so editors that save by replacing the file are detected too.
watchFile(envFile, { interval: 1000 }, (curr, prev) => {
  if (curr.mtimeMs !== prev.mtimeMs) reloadEnv()
})

const distDir = path.join(root, 'dist')
const staticDir = existsSync(path.join(distDir, 'index.html')) ? distDir : null
const { host, port } = state.config
// Bound to loopback → also refuse non-localhost Host headers (DNS rebinding); see app.ts.
const app = createApp({ adapters: () => state.adapters, warnings: () => state.warnings, staticDir, loopbackOnly: isLoopbackHost(host) })

const server = app.listen(port, host, () => {
  const shown = host.includes(':') ? `[${host}]` : host
  console.log(`[api] Jev Classify Lab API en http://${shown}:${port}${staticDir ? ' (sirviendo dist/)' : ''}`)
  console.log(`[api] ${describeLanes(state.adapters)}`)
  for (const warning of state.warnings) console.warn(`[api] ⚠ ${warning}`)
})

server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(`[api] no se pudo iniciar: ${error.code ?? ''} ${error.message}`)
  process.exit(1)
})

function shutdown(signal: string) {
  console.log(`[api] ${signal} recibida, cerrando`)
  server.close(() => process.exit(0))
  server.closeAllConnections()
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
