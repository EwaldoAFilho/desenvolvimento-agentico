// Build da extensao: um bundle CJS para o extension host e um IIFE para a webview.
// `vscode` fica externo (e o host quem o fornece). Nenhum pacote @agentic entra no bundle
// em tempo de execucao: a extensao e CLIENTE do control plane, nao o contem.
import process from 'node:process'
import { build, context } from 'esbuild'

const watch = process.argv.includes('--watch')
const minify = !watch

/** @type {import('esbuild').BuildOptions} */
const extension = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  external: ['vscode'],
  sourcemap: true,
  minify,
  charset: 'utf8',
  logLevel: 'info',
}

const repoRoot = new URL('../../', import.meta.url).pathname
const packages = [
  'agent-runtime',
  'compiler',
  'domain',
  'gates',
  'graph',
  'orchestrator',
  'persistence',
  'process',
  'providers',
  'schemas',
  'workspace',
]
/** `@agentic/*` resolvido para o FONTE, como o vitest e o tsconfig fazem — sem build previo. */
const alias = Object.fromEntries(
  packages.map((p) => [`@agentic/${p}`, `${repoRoot}packages/${p}/src/index.ts`]),
)

/**
 * O dashboard do produto (React) dentro da webview: o MESMO `App` de apps/web, com o
 * transporte trocado por postMessage (media/app.tsx). CSS vai para dist/webview/app.css.
 */
/** @type {import('esbuild').BuildOptions} */
const webview = {
  entryPoints: ['media/app.tsx'],
  outfile: 'dist/webview/app.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  sourcemap: true,
  minify,
  charset: 'utf8',
  logLevel: 'info',
  jsx: 'automatic',
  alias,
  define: { 'process.env.NODE_ENV': minify ? '"production"' : '"development"' },
  loader: { '.css': 'css', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
}

if (watch) {
  const contexts = await Promise.all([context(extension), context(webview)])
  await Promise.all(contexts.map((c) => c.watch()))
  console.log('[agentic-vscode] watching...')
} else {
  await Promise.all([build(extension), build(webview)])
}
