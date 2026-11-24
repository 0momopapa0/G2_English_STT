import { defineConfig, loadEnv } from 'vite'
import { tokenMiddleware } from './server/token-middleware.mjs'

export default defineConfig(({ mode }) => ({
  plugins: [{
    name: 'development-stt-token',
    configureServer(server) {
      const env = loadEnv(mode, server.config.root, '')
      server.middlewares.use(tokenMiddleware(env.DEEPGRAM_API_KEY))
    },
  }],
  server: { host: true, port: 5173 },
  build: { target: 'esnext' },
}))
