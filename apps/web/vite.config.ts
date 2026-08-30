import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * O dashboard usa os tipos do contrato direto do fonte de `@agentic/schemas` — sem cliente
 * gerado e sem build previo dos pacotes (ARCHITECTURE 11, ADR-0008).
 */
const schemasEntry = new URL('../../packages/schemas/src/index.ts', import.meta.url).pathname

/** Porta do control plane (ARCHITECTURE 4): o SPA fala com ele por `/api`. */
const CONTROL_PLANE = 'http://localhost:4317'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@agentic/schemas': schemasEntry,
    },
  },
  server: {
    port: 4318,
    proxy: {
      '/api': {
        target: CONTROL_PLANE,
        changeOrigin: true,
        // SSE precisa atravessar sem buffer: o stream e o produto.
        ws: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
})
