import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

function developmentShutdownPlugin(): Plugin {
  return {
    name: 'development-shutdown',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__shutdown', (request, response) => {
        if (request.method !== 'POST') {
          response.statusCode = 405
          response.end()
          return
        }

        const origin = request.headers.origin
        const host = request.headers.host
        let sameOrigin = false
        try {
          sameOrigin = Boolean(origin && host && new URL(origin).host === host)
        } catch {}
        if (!sameOrigin) {
          response.statusCode = 403
          response.end()
          return
        }

        response.statusCode = 202
        response.setHeader('Content-Type', 'application/json')
        response.end('{"stopping":true}')
        setTimeout(() => { void server.close() }, 100)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), developmentShutdownPlugin()],
  base: './',
  server: {
    watch: {
      ignored: ['**/dist/**', '**/release/**', '**/release-ledger/**', '**/android/**', '**/ios/**'],
    },
  },
})
