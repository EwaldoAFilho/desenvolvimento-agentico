// Teste de integracao num VS Code DE VERDADE (@vscode/test-electron).
//
// Nao entra em `npm run verify`: baixa o editor, precisa de display e leva minutos — mesma
// politica de `test:browser`. Roda sob demanda: `npm run test:integration -w desenvolvimento-agentico-vscode`
// (ou `npm run vscode:test:integration` na raiz).
//
//   AGENTIC_IT_WORKSPACE=<pasta>  usa essa pasta como workspace (default: projeto descartavel
//                                 criado com `agentic init` e provider mock).
//   AGENTIC_IT_DOGFOOD=1          roda test/dogfood.cjs: jornada REAL com planner e executor
//                                 de verdade (consome assinatura); use com AGENTIC_IT_WORKSPACE.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { runTests } from '@vscode/test-electron'

const here = dirname(fileURLToPath(import.meta.url))
const extensionDevelopmentPath = resolve(here, '..')
const repoRoot = resolve(here, '../../..')
const cli = join(repoRoot, 'apps/cli/bin/agentic.mjs')

function scratchWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-vscode-it-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'],
    { cwd: dir },
  )
  execFileSync(process.execPath, [cli, 'init', '--json', dir], { cwd: repoRoot })
  return dir
}

// Rodando de dentro de um terminal do VS Code, o ambiente carrega `ELECTRON_RUN_AS_NODE=1` e
// `VSCODE_*`: o editor de teste herdaria isso e trataria o workspace como script Node.
delete process.env.ELECTRON_RUN_AS_NODE
for (const key of Object.keys(process.env)) if (key.startsWith('VSCODE_')) delete process.env[key]

const workspace = process.env.AGENTIC_IT_WORKSPACE ?? scratchWorkspace()
const disposable = process.env.AGENTIC_IT_WORKSPACE === undefined
// A CLI vem do monorepo: o projeto descartavel nao a tem em apps/cli nem em node_modules.
mkdirSync(join(workspace, '.vscode'), { recursive: true })
if (disposable) {
  writeFileSync(
    join(workspace, '.vscode/settings.json'),
    `${JSON.stringify({ 'agentic.cliPath': cli, 'agentic.nodePath': process.execPath }, null, 2)}\n`,
  )
}

try {
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath: resolve(here, process.env.AGENTIC_IT_DOGFOOD === '1' ? 'dogfood.cjs' : 'suite.cjs'),
    launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust'],
    extensionTestsEnv: { AGENTIC_IT_REPO_ROOT: repoRoot, AGENTIC_IT_WORKSPACE: workspace },
  })
  console.log('integracao: PASS')
} catch (error) {
  console.error('integracao: FAIL', error)
  process.exitCode = 1
} finally {
  if (disposable) rmSync(workspace, { recursive: true, force: true })
}
