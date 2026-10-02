/**
 * Express app factory (no listening here, so tests can mount it on an ephemeral port).
 *
 *  GET  /api/health    → HealthResponse (live = API key configured; model/provider = server defaults; no secrets)
 *  GET  /api/models    → ModelsResponse: models selectable in the UI per engine (?refresh=1 re-lists)
 *  POST /api/classify  → ClassifyResult. 400 ApiErrorBody only for malformed requests; model-level failures
 *                        (missing key, provider error, invalid answer, timeout) are HTTP 200 with status
 *                        'invalid' | 'error' | 'timeout' inside (see contracts.ts).
 *
 * Adapters (and warnings) may be passed as getters: they are read on EVERY request, so a hot-reloaded
 * `.env` (server/index.ts) takes effect without restarting.
 * Client disconnects (runner timeout / race abort) abort the provider call through an AbortController.
 * Logs one concise line per API request (engine, status, latency); never bodies or keys.
 *
 * Security: the API spends the user's paid keys. server/index.ts listens on 127.0.0.1 by default and
 * then enables `loopbackOnly`, which rejects /api requests whose Host header is not a loopback name
 * (a DNS-rebinding page on evil.example → 127.0.0.1 would send `Host: evil.example`). Cross-origin
 * pages cannot use the API either: there are no CORS headers, so the JSON POST never passes preflight.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import express, { type NextFunction, type Request, type Response } from 'express'
import {
  API_ROUTES,
  type ApiErrorBody,
  type ClassifyResult,
  type EngineId,
  type EngineModels,
  type HealthResponse,
  type ModelsResponse,
} from '../src/shared/contracts.ts'
import { errorMessageOf, errorResult, redactSecrets, type Adapters } from './adapters/common.ts'
import { isLoopbackHost } from './env.ts'
import { parseClassifyRequest } from './validate.ts'

export interface AppOptions {
  /** Adapters, or a getter evaluated on every request (hot-reloaded `.env`). */
  adapters: Adapters | (() => Adapters)
  /** Config warnings for /api/health (Spanish, no secrets), or a getter. Default: none. */
  warnings?: string[] | (() => string[])
  /** Built SPA to serve (production). null/undefined = API only. */
  staticDir?: string | null
  /** Request log sink (default console.log). Pass () => {} to silence. */
  log?: (line: string) => void
  /** JSON body limit (default 1mb: a task with up to 80 categories is a few tens of KB). */
  bodyLimit?: string
  /** Reject /api requests whose Host header is not localhost / 127.x / [::1] (DNS-rebinding guard). Default false. */
  loopbackOnly?: boolean
}

interface ClassifyLocals {
  engine?: EngineId
  result?: ClassifyResult
}

/** Reads a value that may be given directly or as a getter. */
function read<T>(value: T | (() => T)): T {
  return typeof value === 'function' ? (value as () => T)() : value
}

function requestLogger(log: (line: string) => void) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/api')) return next()
    const started = performance.now()
    // Captured now: routers mounted under /api rewrite req.url/req.path while they run.
    const route = req.originalUrl.split('?')[0]
    res.on('close', () => {
      const ms = Math.round(performance.now() - started)
      const locals = res.locals as ClassifyLocals
      const parts = [`[api] ${req.method} ${route}`, res.writableFinished ? String(res.statusCode) : 'client-closed', `${ms}ms`]
      if (locals.engine) parts.push(`engine=${locals.engine}`)
      const r = locals.result
      if (r) {
        parts.push(`result=${r.status}`, `model=${r.model}`)
        if (r.providerLatencyMs !== undefined) parts.push(`provider=${r.providerLatencyMs}ms`)
        if (r.status !== 'ok' && r.errorMessage) {
          parts.push(`· ${r.errorMessage.length > 160 ? `${r.errorMessage.slice(0, 160)}…` : r.errorMessage}`)
        }
      }
      log(parts.join(' '))
    })
    next()
  }
}

/** Hostname of a Host header ("localhost:5174" → "localhost", "[::1]:8788" → "[::1]"); '' when absent. */
export function hostHeaderName(host: string | undefined): string {
  const value = (host ?? '').trim().toLowerCase()
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1)
  return value.split(':')[0]
}

function sendError(res: Response, status: number, error: string, details?: string[]) {
  const body: ApiErrorBody = details && details.length > 0 ? { error, details } : { error }
  res.status(status).json(body)
}

export function createApp(options: AppOptions): express.Express {
  const { staticDir, log = console.log, bodyLimit = '1mb', loopbackOnly = false } = options
  const app = express()
  app.disable('x-powered-by')
  app.use(requestLogger(log))
  if (loopbackOnly) {
    app.use('/api', (req, res, next) => {
      if (isLoopbackHost(hostHeaderName(req.headers.host))) return next()
      sendError(res, 403, 'Host no permitido: el API solo atiende a este equipo (localhost). Para exponerlo, define HOST en .env.')
    })
  }
  app.use('/api', express.json({ limit: bodyLimit }))

  app.get(API_ROUTES.health, (_req, res) => {
    // Never cached: the engines can change at runtime when .env is edited.
    res.set('Cache-Control', 'no-store')
    const adapters = read(options.adapters)
    const engine = (id: EngineId) => ({
      live: adapters[id].live,
      model: adapters[id].model,
      provider: adapters[id].provider,
    })
    const health: HealthResponse = {
      ok: true,
      engines: { gpt: engine('gpt'), jev: engine('jev') },
      warnings: [...(read(options.warnings) ?? [])],
    }
    res.json(health)
  })

  app.get(API_ROUTES.models, async (req, res) => {
    res.set('Cache-Control', 'no-store')
    const adapters = read(options.adapters)
    const force = req.query.refresh === '1'
    // Adapters never throw; the catch is a last-resort guard so one engine cannot break the whole listing.
    const list = async (id: EngineId): Promise<EngineModels> => {
      try {
        return await adapters[id].listModels(force)
      } catch (error) {
        return {
          default: adapters[id].model,
          provider: adapters[id].provider,
          models: [{ id: adapters[id].model }],
          source: 'fallback',
          error: redactSecrets(errorMessageOf(error)),
        }
      }
    }
    const [gpt, jev] = await Promise.all([list('gpt'), list('jev')])
    const body: ModelsResponse = { gpt, jev }
    res.json(body)
  })

  app.post(API_ROUTES.classify, async (req, res) => {
    const parsed = parseClassifyRequest(req.body)
    if (!parsed.ok) {
      sendError(res, 400, 'Solicitud inválida.', parsed.errors)
      return
    }
    const { engine, model, task, item } = parsed.value
    const locals = res.locals as ClassifyLocals
    locals.engine = engine
    const adapter = read(options.adapters)[engine]

    // Browser went away (runner timeout / abort) → cancel the provider request. Express 5 / Node 22:
    // listen on `res` ('close' also fires after a normal response, hence the writableEnded check).
    const controller = new AbortController()
    const onClose = () => {
      if (!res.writableEnded) controller.abort(new Error('Client disconnected'))
    }
    res.on('close', onClose)
    if (res.destroyed) onClose()

    let result: ClassifyResult
    try {
      result = await adapter.classify(task, item, { signal: controller.signal, model })
    } catch {
      // Adapters are designed not to throw; this is a last-resort guard (no details: may contain secrets).
      result = errorResult(engine, model ?? adapter.model, 'Error inesperado del servidor en el adaptador.')
    } finally {
      res.off('close', onClose)
    }
    locals.result = result
    if (controller.signal.aborted || res.destroyed) return
    res.json(result)
  })

  app.use('/api', (_req, res) => {
    sendError(res, 404, 'Ruta de API no encontrada.')
  })

  if (staticDir && existsSync(staticDir)) {
    const indexHtml = path.resolve(staticDir, 'index.html')
    app.use(express.static(staticDir))
    // SPA fallback for client-side routes (/api never gets here: its 404 above is final).
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next()
      res.sendFile(indexHtml)
    })
  }

  // JSON errors (malformed JSON → 400, too large → 413) instead of Express' HTML page. Never a stack or a secret.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err)
    const e = err as { status?: number; statusCode?: number; type?: string }
    const status = e.status ?? e.statusCode ?? 500
    if (status >= 500) log(`[api] error interno: ${redactSecrets(errorMessageOf(err))}`)
    const message =
      e.type === 'entity.parse.failed'
        ? 'JSON inválido en el cuerpo de la solicitud.'
        : e.type === 'entity.too.large'
          ? 'El cuerpo de la solicitud supera el límite permitido.'
          : status < 500
            ? 'Solicitud inválida.'
            : 'Error interno del servidor.'
    sendError(res, status >= 400 && status < 600 ? status : 500, message)
  })

  return app
}
