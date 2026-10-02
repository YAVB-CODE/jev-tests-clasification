import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

/**
 * Where the dev proxy finds the API: the same HOST / PORT the API reads from `.env` (server/env.ts;
 * shell variables win, as there). A wildcard listen address (0.0.0.0 / ::) is reached through loopback.
 * Only these two values are read here; nothing from `.env` reaches the browser bundle (only VITE_* would).
 */
function apiTarget(env: Record<string, string>): string {
  const port = /^\d{1,5}$/.test(env.PORT?.trim() ?? '') ? env.PORT.trim() : '8788'
  const raw = env.HOST?.trim() || '127.0.0.1'
  const host = raw === '0.0.0.0' || raw === '::' ? '127.0.0.1' : raw
  return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    proxy: {
      // Backend (server/index.ts) holds the API keys and talks to OpenAI / OpenCode Zen.
      '/api': apiTarget(loadEnv(mode, process.cwd(), '')),
    },
  },
}))
