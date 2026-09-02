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

/** @type {import('esbuild').BuildOptions} */
const webview = {
  entryPoints: ['media/home.ts'],
  outfile: 'dist/webview/home.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  sourcemap: true,
  minify,
  charset: 'utf8',
  logLevel: 'info',
}

if (watch) {
  const contexts = await Promise.all([context(extension), context(webview)])
  await Promise.all(contexts.map((c) => c.watch()))
  console.log('[agentic-vscode] watching...')
} else {
  await Promise.all([build(extension), build(webview)])
}
