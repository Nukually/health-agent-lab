import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url))
const sharedSrcEntry = fileURLToPath(new URL('../shared/src/index.ts', import.meta.url))

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, workspaceRoot, '')
  const backendPort = process.env.BACKEND_PORT || env.BACKEND_PORT || process.env.PORT || env.PORT || '13010'
  const backendUrl = `http://127.0.0.1:${backendPort}`

  return {
    plugins: [react()],
    resolve: command === 'serve'
      ? {
          alias: {
            '@health-agent/shared': sharedSrcEntry,
          },
        }
      : undefined,
    build: {
      target: ['es2017', 'ios11'],
    },
    server: {
      host: '127.0.0.1',
      strictPort: true,
      port: Number(process.env.FRONTEND_PORT || env.FRONTEND_PORT) || 5174,
      fs: {
        allow: [workspaceRoot],
      },
      proxy: {
        '/api/chat/asr': {
          target: backendUrl,
          ws: true,
        },
        '/api/chat/tts': {
          target: backendUrl,
          ws: true,
        },
        '/api': {
          target: backendUrl,
          changeOrigin: true,
        },
      },
    },
  }
})
