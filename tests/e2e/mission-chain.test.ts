import { compileMission } from '@agentic/compiler'
import type { Attempt, DomainEvent, GateExecution, Run, TaskRun } from '@agentic/domain'
import type { MissionReport } from '@agentic/orchestrator'
import type { RunSnapshot } from '@agentic/schemas'
import { RunSnapshotSchema } from '@agentic/schemas'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConcurrencyProbe } from './support/agents.js'
import { MISSION_BRANCH, MISSION_PATH } from './support/fixture.js'
import { ACTOR, createMissionHarness, type MissionHarness } from './support/harness.js'
import type { RunOutcome } from './support/outcome.js'
import { outcomeOf, overlaps, taskIdOf, windowOf } from './support/outcome.js'
import { createApp, recordingLauncher } from './support/server.js'

/**
 * A CADEIA INTEIRA, com um elo por asserção:
 *
 *   missao valida -> compile -> DAG -> START MISSION -> escalonamento automatico ->
 *   execucao paralela -> task gates -> revisao independente -> integracao ->
 *   mission gate -> COMPLETED
 *
 * Nenhuma CLI de agente e invocada: os dois fornecedores declarados no project.yaml do
 * fixture sao substituidos por agentes in-process roteirizados. Zero quota.
 */

interface Cenario {
  readonly harness: MissionHarness
  readonly app: FastifyInstance
  readonly launched: readonly string[]
  readonly startStatus: number
  readonly startBody: { readonly runId: string }
  readonly probe: ConcurrencyProbe
  readonly run: Run
  readonly tasks: readonly TaskRun[]
  readonly attempts: readonly Attempt[]
  readonly events: readonly DomainEvent[]
  readonly report: MissionReport
  readonly snapshot: RunSnapshot
  readonly outcome: RunOutcome
}

/** Executa a missao do fixture de ponta a ponta, com UM unico comando de partida. */
async function executarCenario(): Promise<Cenario> {
  const probe = new ConcurrencyProbe()
  // A onda 1 do fixture tem T01 e T02 concorrentes: exigimos que se encontrem.
  probe.expectConcurrent(2)
  const harness = await createMissionHarness({ probe })
  const recording = recordingLauncher(harness)
  const app = createApp(harness, { launcher: recording.launcher })

  // START MISSION: um POST. Daqui em diante ninguem mais e chamado — o orquestrador
  // descobre as READY, despacha, revisa, integra e fecha.
  const started = await app.inject({
    method: 'POST',
    url: '/api/runs',
    payload: { file: MISSION_PATH, actor: ACTOR, acceptWarnings: false },
  })
  const run = await harness.waitForTerminal(90_000)

  return {
    harness,
    app,
    launched: recording.launched.map(String),
    startStatus: started.statusCode,
    startBody: started.json(),
    probe,
    run,
    tasks: await harness.tasks(),
    attempts: await harness.attempts(),
    events: await harness.events(),
    report: await harness.plane.generateMissionReport(harness.runId),
    snapshot: await harness.plane.getRunSnapshot(harness.runId),
    outcome: await outcomeOf(harness),
  }
}

let cenario: Cenario
let repeticao: Cenario

beforeAll(async () => {
  cenario = await executarCenario()
  repeticao = await executarCenario()
}, 300_000)

afterAll(async () => {
  await cenario?.app.close().catch(() => undefined)
  await repeticao?.app.close().catch(() => undefined)
  await cenario?.harness.cleanup()
  await repeticao?.harness.cleanup()
})

describe('elo 1 — missao valida compila e produz o DAG do fixture', () => {
  it('compila sem nenhum diagnostico', () => {
    const result = compileMission({
      missionText: cenario.harness.sources.missionText,
      projectFile: cenario.harness.sources.projectText,
      gatesFile: cenario.harness.sources.gatesText,
    })
    expect(result.diagnostics).toEqual([])
    expect(result.graph).toBeDefined()
  })

  it('produz waves, caminho critico e concorrencia exatos', () => {
    const graph = cenario.harness.compiled
    expect(graph.waves).toEqual([['T01', 'T02'], ['T03', 'T04'], ['T05', 'T06'], ['T07'], ['T08']])
    expect(graph.criticalPath.tasks).toEqual(['T01', 'T03', 'T05', 'T07', 'T08'])
    expect(graph.criticalPath.length).toBe(13)
    expect(graph.concurrencyMatrix).toContainEqual(['T01', 'T02'])
    expect(graph.concurrencyMatrix).toContainEqual(['T03', 'T04'])
    expect(graph.touchConflicts).toEqual([])
  })

  it('congela o mesmo specHash em duas compilacoes independentes', () => {
    expect(repeticao.harness.compiled.specHash).toBe(cenario.harness.compiled.specHash)
    expect(cenario.run.specHash).toBe(cenario.harness.compiled.specHash)
  })
})

describe('elo 2 — START MISSION dispara tudo', () => {
  it('aceita um unico POST e devolve o run que partiu', () => {
    expect(cenario.startStatus).toBe(201)
    expect(cenario.startBody.runId).toBe(String(cenario.harness.runId))
    expect(cenario.launched).toEqual([String(cenario.harness.runId)])
  })

  it('registra exatamente tres eventos de ator humano no run inteiro', () => {
    const humanos = cenario.events.filter((event) => event.actor.kind === 'human')
    expect(humanos.map((event) => event.type)).toEqual([
      'human.mission_approved',
      'run.approved',
      'run.started',
    ])
    expect(humanos.every((event) => event.actor.id === ACTOR)).toBe(true)
  })

  it('descobre e despacha as oito tasks sem nenhum comando por task', () => {
    const despachadas = cenario.events
      .filter((event) => event.type === 'task.dispatched')
      .map((event) => event.taskId)
    expect([...despachadas].sort()).toEqual([
      'T01',
      'T02',
      'T03',
      'T04',
      'T05',
      'T06',
      'T07',
      'T08',
    ])
    const prontas = cenario.events.filter((event) => event.type === 'task.ready')
    expect(prontas).toHaveLength(8)
  })

  it('so libera o dependente depois da dependencia concluida', () => {
    const doneT03 = cenario.events.find(
      (event) => event.type === 'task.done' && event.taskId === 'T03',
    )
    const readyT05 = cenario.events.find(
      (event) => event.type === 'task.ready' && event.taskId === 'T05',
    )
    expect(doneT03?.seq).toBeLessThan(readyT05?.seq ?? 0)
  })

  it('recusa a partida enquanto a missao nao tiver aprovacao humana', async () => {
    const semAprovacao = await createMissionHarness({ approve: false, safetyIntervalMs: 0 })
    const recusa = recordingLauncher(semAprovacao)
    const app = createApp(semAprovacao, { launcher: recusa.launcher })
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: { file: MISSION_PATH, actor: ACTOR, acceptWarnings: false },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().error.code).toBe('MISSION_NOT_APPROVED')
      expect(recusa.launched).toEqual([])
      expect((await semAprovacao.run()).status).toBe('DRAFT')
      expect(await semAprovacao.attempts()).toEqual([])
    } finally {
      await app.close().catch(() => undefined)
      await semAprovacao.cleanup()
    }
  }, 60_000)
})

describe('elo 3 — execucao paralela medida, nao suposta', () => {
  it('sobrepoe as janelas gravadas de duas tasks concorrentes', () => {
    const janelas = cenario.attempts.map(windowOf)
    const t01 = janelas.find((janela) => janela.taskId === 'T01')
    const t02 = janelas.find((janela) => janela.taskId === 'T02')
    expect(t01).toBeDefined()
    expect(t02).toBeDefined()
    if (t01 === undefined || t02 === undefined) return
    expect(overlaps(t01, t02)).toBe(true)
  })

  it('conta pelo menos dois agentes vivos ao mesmo tempo, por fora do control plane', () => {
    expect(cenario.probe.max).toBeGreaterThanOrEqual(2)
  })

  it('nunca ultrapassa o teto global declarado no project.yaml', () => {
    expect(cenario.probe.max).toBeLessThanOrEqual(
      cenario.harness.project.execution.maxParallelTasks,
    )
  })
})

describe('elo 4 — task gates rodaram de verdade', () => {
  const comGate = ['T01', 'T02', 'T03', 'T04', 'T05', 'T07', 'T08']

  it('grava comando, exit code e duracao de cada gate de task', () => {
    for (const attempt of cenario.attempts) {
      const taskId = taskIdOf(attempt)
      if (!comGate.includes(taskId)) continue
      const execution = attempt.gateExecutions[0] as GateExecution | undefined
      expect(execution?.status, taskId).toBe('PASS')
      const primeiro = execution?.results[0]
      expect(primeiro?.command).toBe('node tests/run.js')
      expect(primeiro?.exitCode).toBe(0)
      expect(primeiro?.durationMs).toBeGreaterThanOrEqual(0)
      expect(primeiro?.cwd).toContain(`${taskId}-a1`)
    }
  })

  it('nao inventa gate para a task que nao declarou nenhum', () => {
    const t06 = cenario.attempts.filter((attempt) => taskIdOf(attempt) === 'T06')
    expect(t06).toHaveLength(1)
    expect(t06[0]?.gateExecutions).toHaveLength(0)
    expect(t06[0]?.result).toBe('PASS')
  })

  it('roda o gate da T08 com os dois comandos do perfil da missao', () => {
    const t08 = cenario.attempts.find((attempt) => taskIdOf(attempt) === 'T08')
    const execution = t08?.gateExecutions[0]
    expect(execution?.gateId).toBe('mission')
    expect(execution?.results).toHaveLength(2)
    expect(execution?.results.map((result) => result.exitCode)).toEqual([0, 0])
  })
})

describe('elo 5 — revisao independente', () => {
  it('nunca deixa o executor revisar a propria tentativa', () => {
    expect(cenario.attempts).toHaveLength(8)
    for (const attempt of cenario.attempts) {
      expect(attempt.review?.verdict, taskIdOf(attempt)).toBe('PASS')
      expect(attempt.review?.reviewer.sessionRef).not.toBe(attempt.executor.sessionRef)
    }
  })

  it('usa fornecedor diferente na task de risco alto e registra a politica satisfeita', () => {
    const t05 = cenario.attempts.find((attempt) => taskIdOf(attempt) === 'T05')
    expect(t05?.review?.policy).toBe('cross-provider-required')
    expect(t05?.review?.policyOutcome).toBe('satisfied')
    expect(t05?.review?.reviewer.providerId).not.toBe(t05?.executor.providerId)
  })

  it('nunca rebaixa politica de revisao neste cenario', () => {
    const tipos = cenario.events.map((event) => event.type)
    expect(tipos).not.toContain('review.policy_downgraded')
    expect(tipos).not.toContain('review.escalated')
  })
})

describe('elo 6 — integracao na branch da missao', () => {
  it('cria a branch da missao com um commit por task', async () => {
    const branches = await cenario.harness.git('branch', '--list', MISSION_BRANCH)
    expect(branches).toContain(MISSION_BRANCH)
    const log = await cenario.harness.git('log', '--format=%s', MISSION_BRANCH)
    const assuntos = log.split('\n')
    for (const taskId of ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08']) {
      expect(
        assuntos.some((linha) => linha.startsWith(`${taskId} a1:`)),
        taskId,
      ).toBe(true)
    }
  })

  it('deixa na branch da missao os arquivos que a missao entregou', async () => {
    const arquivos = await cenario.harness.git('ls-tree', '-r', '--name-only', MISSION_BRANCH)
    const lista = arquivos.split('\n')
    for (const caminho of [
      'src/inventario.js',
      'src/precos.js',
      'src/reposicao.js',
      'src/relatorio.js',
      'src/cli.js',
      'tests/casos.js',
      'docs/USAGE.md',
    ]) {
      expect(lista, caminho).toContain(caminho)
    }
  })

  it('grava evidencia de escopo, gate e revisao em cada task concluida', () => {
    const done = cenario.events.filter((event) => event.type === 'task.done')
    expect(done).toHaveLength(8)
    for (const event of done) {
      const kinds = event.type === 'task.done' ? event.payload.evidence.map((ref) => ref.kind) : []
      expect(kinds, String(event.taskId)).toContain('scope')
      expect(kinds, String(event.taskId)).toContain('review')
      expect(kinds, String(event.taskId)).toContain('integration')
      if (event.taskId !== 'T06') expect(kinds, String(event.taskId)).toContain('gate')
    }
  })
})

describe('elo 7 — mission gate e COMPLETED', () => {
  it('termina o run em COMPLETED com todas as tasks DONE', () => {
    expect(cenario.run.status).toBe('COMPLETED')
    expect(cenario.tasks.map((task) => task.status)).toEqual(Array(8).fill('DONE'))
    expect(cenario.harness.orchestrator.errors).toEqual([])
  })

  it('roda o mission gate na branch da missao, com os dois comandos', async () => {
    const raw = await cenario.harness.plane.persistence.artifacts.readText(
      cenario.harness.runId,
      'mission/gate.json',
    )
    const execution = JSON.parse(raw) as GateExecution
    expect(execution.gateId).toBe('mission')
    expect(execution.scope).toBe('mission')
    expect(execution.status).toBe('PASS')
    expect(execution.results.map((result) => result.exitCode)).toEqual([0, 0])
    expect(execution.results[0]?.cwd).toMatch(/\/mission$/)
    expect(cenario.run.missionGateExecutionId).toBe(execution.id)
  })

  it('publica um snapshot valido no contrato publico', () => {
    expect(RunSnapshotSchema.safeParse(cenario.snapshot).success).toBe(true)
    expect(cenario.snapshot.counters.DONE).toBe(8)
    expect(cenario.snapshot.graph.criticalPath).toEqual(['T01', 'T03', 'T05', 'T07', 'T08'])
  })
})

describe('elo 8 — determinismo', () => {
  it('repete o cenario e obtem exatamente o mesmo desfecho', () => {
    expect(repeticao.outcome).toEqual(cenario.outcome)
  })

  it('conclui as duas execucoes em COMPLETED, com uma tentativa por task', () => {
    expect(repeticao.run.status).toBe('COMPLETED')
    expect(cenario.report.attempts).toBe(8)
    expect(repeticao.report.attempts).toBe(8)
    expect(cenario.report.retries).toBe(0)
    expect(repeticao.report.retries).toBe(0)
  })
})
