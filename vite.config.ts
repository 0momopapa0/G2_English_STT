import { defineConfig, loadEnv } from 'vite'
import { tokenMiddleware } from './server/token-middleware.mjs'
import { summaryMiddleware } from './server/summary-middleware.mjs'

export default defineConfig(({ mode }) => ({
  plugins: [{
    name: 'development-stt-token',
    configureServer(server) {
      const env = loadEnv(mode, server.config.root, '')
      server.middlewares.use(tokenMiddleware(env.SONIOX_API_KEY))
      server.middlewares.use(summaryMiddleware(env.OPENAI_API_KEY, env.OPENAI_SUMMARY_MODEL || undefined))
    },
  }],
  server: { host: true, port: 5173 },
  build: { target: 'esnext' },
}))
