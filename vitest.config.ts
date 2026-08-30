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
          name: 'tools',
          root,
          include: ['tests/tools/**/*.test.ts'],
          environment: 'node' as const,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
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
