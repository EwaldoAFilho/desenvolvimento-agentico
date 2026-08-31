import { defineConfig, devices } from '@playwright/test'
import { ARTIFACTS_DIR, readHandoff } from './tests/browser/support/handoff.js'

/**
 * Suite de NAVEGADOR DE VERDADE: Chromium headless contra servidor, banco, SSE e
 * orquestrador reais, servindo o build de `apps/web`.
 *
 * Ela NAO entra em `npm run verify` nem em `npm run test:e2e`, de proposito: e mais lenta
 * e exige o runtime do navegador instalado (`npx playwright install chromium`, que grava
 * em ~/.cache/ms-playwright, sem sudo). Roda sob demanda por `npm run test:browser`.
 * Nenhum vitest a captura: os arquivos daqui sao `.spec.ts`, e os projetos do
 * `vitest.config.ts` so incluem `*.test.ts`.
 *
 * O ambiente sobe no global setup (equivalente ao `webServer`, com a vantagem de subir o
 * control plane NO PROCESSO e numa porta efemera). Como a porta so existe depois do
 * listen, a baseURL vem do handoff — presente quando cada worker reavalia este arquivo.
 * O teste tambem usa URL absoluta do handoff, entao nao depende dessa reavaliacao.
 */
export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.ts',
  outputDir: ARTIFACTS_DIR,
  globalSetup: './tests/browser/global-setup.ts',
  globalTeardown: './tests/browser/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  // Retry esconde instabilidade: uma falha e uma falha.
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: readHandoff()?.baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
