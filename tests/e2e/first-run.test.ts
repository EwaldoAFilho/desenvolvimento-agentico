import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { CommandDeps } from '@agentic/cli'
import { type InitData, initCommand } from '@agentic/cli'
import { compileMission } from '@agentic/compiler'
import type { AgentProvider, ProviderHealth, ProviderId, ProviderRegistry } from '@agentic/domain'
import { createControlPlane } from '@agentic/orchestrator'
import { acquireControlPlaneOwnership } from '@agentic/persistence'
import type { ProviderFactory } from '@agentic/providers'
import { parseGatesFile, parseMissionFile, parseProjectFile, toMissionSpec } from '@agentic/schemas'
import { afterEach, describe, expect, it } from 'vitest'
import { pass, review, type StepFn, scriptedFactory } from './support/agents.js'

const exec = promisify(execFile)

/**
 * ACEITACAO DE PRODUTO — "o primeiro run nao mente".
 *
 * O que esta em teste nao e uma funcao: e a promessa. Alguem cria um repositorio, roda
 * `agentic init` e o que o PROPRIO PRODUTO escreveu tem de ser executavel — gates que
 * existem no projeto, fornecedor que foi observado pronto, estado local fora do Git.
 *
 * Nenhuma CLI de agente e invocada: o fornecedor observado como pronto e substituido por um
 * agente roteirizado no `providerFactories`, exatamente como no resto do E2E. O que se prova
 * aqui e o SETUP que o produto entrega, nao a inteligencia do agente.
 */
const ACTOR = 'humano@primeiro-run'
const PROVIDER = 'claude-code'

let root: string | undefined
const encerrar: Array<() => Promise<void>> = []

afterEach(async () => {
  while (encerrar.length > 0) await encerrar.pop()?.()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function fakeRegistry(entries: readonly ProviderHealth[]): ProviderRegistry {
  return {
    get: (id: ProviderId): AgentProvider => {
      throw new Error(`provider ${id} nao e construido nesta aceitacao: ${id}`)
    },
    list: () => entries.map((entry) => entry.providerId),
    health: () => Promise.resolve([...entries]),
    capacity: () => ({
      global: { maxParallelTasks: 1, active: 0 },
      executor: { max: 1, active: 0 },
      reviewer: { max: 1, active: 0 },
      byProvider: {},
    }),
  }
}

/** Sonda controlada: o `init` "observa" a CLI real pronta sem executar CLI nenhuma. */
function depsWith(cwd: string, entries: readonly ProviderHealth[]): CommandDeps {
  const out: string[] = []
  return {
    cwd,
    stdout: (text) => {
      out.push(text)
    },
    stderr: () => undefined,
    exit: () => undefined,
    now: () => new Date('2026-09-03T00:00:00.000Z'),
    env: {},
    nodeVersion: '22.23.1',
    controlPlane: () => {
      throw new Error('nao usado')
    },
    registry: () => fakeRegistry(entries),
    connect: () => Promise.resolve(undefined),
    probeGit: () =>
      Promise.resolve({
        installed: true,
        version: 'git',
        repository: true,
        detail: 'repositorio git valido',
      }),
    waitForShutdown: () => new Promise<void>(() => undefined),
  } as CommandDeps
}

function health(providerId: string, ready: boolean): ProviderHealth {
  return {
    providerId: providerId as ProviderId,
    installed: true,
    ready,
    version: '2.1.0',
    detail: ready ? 'sessao ativa' : 'sessao nao autenticada',
    probedAt: new Date('2026-09-03T00:00:00.000Z'),
    running: 0,
    capacity: 3,
  }
}

/** Projeto Node/TypeScript simples, com scripts REAIS e um teste que roda de verdade. */
async function novoProjeto(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentic-primeiro-run-'))
  const git = (...args: string[]): Promise<unknown> => exec('git', args, { cwd: dir })
  await writeFile(
    join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'catalogo',
        private: true,
        type: 'module',
        scripts: {
          test: 'node tests/run.mjs',
          lint: 'node -e "process.exit(0)"',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  await exec('mkdir', ['-p', join(dir, 'tests'), join(dir, 'src')])
  // Teste de verdade: le `src/` e reprova se a entrega nao existir.
  await writeFile(
    join(dir, 'tests/run.mjs'),
    [
      "import { existsSync } from 'node:fs'",
      "if (!existsSync('src/catalogo.js')) { console.error('faltando src/catalogo.js'); process.exit(3) }",
      "console.log('ok')",
      '',
    ].join('\n'),
    'utf8',
  )
  await writeFile(join(dir, 'src/.keep'), '', 'utf8')
  await git('init', '-q', '-b', 'main')
  await git('config', 'user.email', 'primeiro-run@example.invalid')
  await git('config', 'user.name', 'Primeiro Run')
  await git('config', 'commit.gpgsign', 'false')
  await git('add', '-A')
  await git('commit', '--no-verify', '-q', '-m', 'catalogo: estado inicial')
  return dir
}

/** O humano versiona o que o `init` escreveu — e so o que e para ser versionado. */
async function commitarConfig(dir: string): Promise<void> {
  await exec('git', ['add', '-A'], { cwd: dir })
  await exec('git', ['commit', '--no-verify', '-q', '-m', 'agentic init'], { cwd: dir })
}

const MISSION = `apiVersion: agentic/v1
kind: Mission

id: PRIMEIRA-001
title: Primeira entrega
objective: Provar o caminho completo com uma entrega minima e verificavel.

scope:
  - Catalogo minimo
outOfScope:
  - Qualquer outra coisa

constraints:
  - Sem dependencia nova

acceptanceCriteria:
  - O teste do projeto passa sobre a entrega

defaults:
  requireReview: true
  maxAttempts: 1
  gate: unit

phases:
  - id: entrega
    title: Entrega

tasks:
  - id: T01
    phase: entrega
    title: Catalogo
    objective: Criar o modulo de catalogo que o teste do projeto exige.
    dependencies: []
    touches:
      - src/
    validation:
      - O teste do projeto passa
    gate: mission
    risk: low
    estimate: 1

missionGate: mission
`

const ENTREGA: StepFn = (context) =>
  context.kind === 'review'
    ? review('PASS')
    : pass('T01: src/catalogo.js entregue', {
        'src/catalogo.js': 'export const catalogo = []\n',
      })

interface Aberto {
  readonly runId: string
  readonly drain: () => Promise<void>
  readonly run: () => Promise<{ readonly status: string }>
  readonly tasks: () => Promise<readonly { readonly taskId: string; readonly status: string }[]>
  readonly attempts: () => Promise<
    readonly { readonly failureReason?: { readonly code: string; readonly detail?: string } }[]
  >
}

/** Sobe o control plane REAL sobre o projeto que o `init` acabou de escrever. */
async function abrir(dir: string, factory: ProviderFactory | undefined): Promise<Aberto> {
  const projectText = await readFile(join(dir, '.agentic/project.yaml'), 'utf8')
  const gatesText = await readFile(join(dir, '.agentic/gates.yaml'), 'utf8')
  const project = parseProjectFile(projectText)
  const gates = parseGatesFile(gatesText)
  if (!project.ok)
    throw new Error(`project.yaml gerado invalido: ${JSON.stringify(project.issues)}`)
  if (!gates.ok) throw new Error(`gates.yaml gerado invalido: ${JSON.stringify(gates.issues)}`)

  const compiled = compileMission({
    missionText: MISSION,
    projectFile: projectText,
    gatesFile: gatesText,
  })
  const graph = compiled.graph
  if (graph === undefined) {
    throw new Error(
      `missao nao compilou sobre a config gerada: ${JSON.stringify(compiled.diagnostics)}`,
    )
  }
  const mission = parseMissionFile(MISSION)
  if (!mission.ok) throw new Error('missao de teste invalida')

  const posse = acquireControlPlaneOwnership({ baseDir: join(dir, '.agentic') })
  if (!posse.ok) throw new Error(`aceitacao: projeto ja possuido (${posse.detail})`)
  const plane = createControlPlane({
    project: project.value,
    gatesFile: gates.value,
    repoRoot: dir,
    lease: posse.lease,
    ...(factory === undefined
      ? {}
      : {
          providerFactories: Object.fromEntries(
            Object.keys(project.value.providers.registry).map((id) => [id, factory]),
          ),
        }),
  })
  encerrar.push(async () => {
    await plane.close()
    posse.lease.release()
  })

  const created = await plane.createRun({
    mission: toMissionSpec(mission.value),
    compiled: graph,
    missionText: MISSION,
  })
  await plane.approveMission({ runId: created.id, actor: ACTOR })
  await plane.startRun({ runId: created.id, actor: ACTOR, acceptWarnings: true })
  const orchestrator = await plane.open(created.id)
  return {
    runId: created.id,
    drain: () => orchestrator.drain(),
    run: async () => (await plane.persistence.runs.loadRun(created.id)) as never,
    tasks: () => plane.persistence.runs.loadTaskRuns(created.id) as never,
    attempts: () => plane.persistence.runs.loadAttempts(created.id) as never,
  }
}

describe('primeiro run: o que o `init` entrega e executavel', () => {
  it('com uma CLI observada PRONTA, o setup gerado leva o run ate o fim', async () => {
    root = await novoProjeto()
    const result = await initCommand({}, depsWith(root, [health(PROVIDER, true)]))
    const data = result.data as InitData

    // (1) o estado local ficou fora do Git — sem isto o planejamento se recusa a gravar.
    const { stdout: status } = await exec(
      'git',
      ['status', '--porcelain', '--untracked-files=all'],
      { cwd: root },
    )
    expect(status).toContain('.agentic/project.yaml')
    expect(status).toContain('.agentic/gates.yaml')
    expect(status).not.toContain('state.db')
    expect(status).not.toContain('control-plane')

    // (2) os gates sao os do PROJETO: nada de `npm run verify` que ninguem declarou.
    expect(data.gates).toContain('npm run test')
    expect(data.gates).toContain('npm run lint')
    expect(data.gates.join(' ')).not.toContain('verify')

    // (3) o agente de ensaio nao esta no caminho de execucao real.
    const projectText = await readFile(join(root, '.agentic/project.yaml'), 'utf8')
    expect(data.rehearsalOnly).toBe(false)
    expect(data.defaultProvider).toBe(PROVIDER)
    expect(projectText).not.toContain('mock')

    // (4) e o primeiro run atravessa o pipeline inteiro sobre essa configuracao.
    await commitarConfig(root)
    const aberto = await abrir(root, scriptedFactory(ENTREGA))
    await aberto.drain()

    const run = await aberto.run()
    const tasks = await aberto.tasks()
    expect(tasks.map((task) => task.status)).toEqual(['DONE'])
    expect(run.status).toBe('COMPLETED')
    // A entrega esta na branch da missao, medida por nos — nao relatada pelo agente.
    const { stdout: arquivos } = await exec(
      'git',
      ['ls-tree', '-r', '--name-only', 'mission/PRIMEIRA-001'],
      {
        cwd: root,
      },
    )
    expect(arquivos).toContain('src/catalogo.js')
  })

  it('sem CLI PRONTA, o init avisa e o run recusa em vez de fingir', async () => {
    root = await novoProjeto()
    const result = await initCommand({}, depsWith(root, [health(PROVIDER, false)]))
    const data = result.data as InitData

    // O produto NAO diz que o projeto esta pronto: diz o contrario, e nomeia o conserto.
    expect(data.rehearsalOnly).toBe(true)
    expect(data.defaultProvider).toBe('mock')
    expect(data.providers).toEqual([
      { providerId: PROVIDER, state: 'NOT_READY', detail: 'sessao nao autenticada' },
    ])

    // E quem insistir em rodar assim recebe a causa com o nome do problema — nunca um
    // `NO_CHANGES` generico, e nunca uma revisao de mentira.
    await commitarConfig(root)
    const aberto = await abrir(root, undefined)
    await aberto.drain()

    const tasks = await aberto.tasks()
    expect(tasks[0]?.status).not.toBe('DONE')
    const attempts = await aberto.attempts()
    const falha = attempts[attempts.length - 1]?.failureReason
    expect(falha?.code).toBe('AGENT_ERROR')
    expect(falha?.detail).toContain('agente de ensaio sem roteiro')
    expect(falha?.detail).toContain('providers.default')
  })
})
