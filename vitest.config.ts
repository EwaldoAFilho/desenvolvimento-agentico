import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))
const packages = readdirSync(`${root}packages`)
const apps = ['cli', 'server']

/** Resolve @agentic/* direto para o fonte: teste nao exige build previo. */
const alias = Object.fromEntries([
  ...packages.map((p) => [`@agentic/${p}`, `${root}packages/${p}/src/index.ts`]),
  ...apps.map((a) => [`@agentic/${a}`, `${root}apps/${a}/src/index.ts`]),
])

/**
 * Divisao do pipeline (cada suite roda exatamente uma vez no gate mission):
 *
 *   npm run test     -> vitest run --project=!e2e   (tudo menos o projeto abaixo)
 *   npm run test:e2e -> vitest run --project e2e
 *
 * O filtro do verify e por EXCLUSAO, nao por lista: qualquer projeto novo declarado aqui
 * entra automaticamente no `npm run test` (e portanto no `npm run verify`). Manter assim.
 * Tirar um projeto do verify exige mudar o filtro em package.json de proposito — nunca
 * acontece em silencio ao adicionar um projeto.
 */
const E2E_PROJECT = 'e2e'

const nodeProject = (name: string, dir: string) => ({
  extends: true,
  test: {
    name,
    root: `${root}${dir}/${name}`,
    include: ['src/**/*.test.ts'],
    environment: 'node' as const,
  },
})

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      ...packages.map((p) => nodeProject(p, 'packages')),
      ...apps.map((a) => nodeProject(a, 'apps')),
      {
        extends: true,
        test: {
          name: 'web',
          root: `${root}apps/web`,
          include: ['src/**/*.test.{ts,tsx}'],
          environment: 'jsdom' as const,
          globals: true,
        },
      },
      {
        extends: true,
        test: {
          name: 'tools',
          root,
          include: ['tests/tools/**/*.test.ts'],
          environment: 'node' as const,
        },
      },
      {
        extends: true,
        test: {
          name: E2E_PROJECT,
          root,
          include: ['tests/e2e/**/*.test.ts'],
          environment: 'node' as const,
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
})
