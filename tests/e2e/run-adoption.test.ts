import { readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Attempt, Run, RunId, TaskRun } from '@agentic/domain'
import { attachServer, startServer } from '@agentic/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StepFn } from './support/agents.js'
import { missionStep, pass, review } from './support/agents.js'
import { ENTREGAS } from './support/entregas.js'
import { PROJECT_PATH } from './support/fixture.js'
import { createMissionHarness, type MissionHarness } from './support/harness.js'

/**
 * D3 / I13 — RUN ADOPTION DEPOIS DE UM REINICIO DO CONTROL PLANE.
 *
 * A reconciliacao ja funcionava (`recovery.test.ts`), mas so depois de alguem abrir o
 * orquestrador na mao. Aqui o control plane CAI e um novo sobe pelo caminho de boot do
 * produto (`startServer`). Ninguem chama START MISSION. O run tem de voltar a andar.
 *
 * Todos os agentes sao in-process: a escolha do factory e por ID (`providers/registry.ts`),
 * entao os fornecedores do fixture sao renomeados — e nenhum adapter de CLI real chega a
 * ser construido nem quando o boot monta o plane SEM `providerFactories`.
 */

interface ProjectOptions {
  /** Segura a aquisicao da worktree do gate da missao — e SO dela (ver abaixo). */
  readonly missionSetupSleepMs?: number
}

function comAgentesInProcess(projectText: string, options: ProjectOptions = {}): string {
  const inicio = projectText.indexOf('  default: claude-code')
  const fim = projectText.indexOf('\ngates:')
  if (inicio === -1 || fim === -1) throw new Error('fixture: bloco de providers nao encontrado')
  const bloco = [
    '  default: alfa',
    '  registry:',
    '    alfa:',
    '      kind: inprocess',
    '      maxConcurrent: 3',
    '      roles: [executor, reviewer]',
    '    beta:',
    '      kind: inprocess',
    '      maxConcurrent: 2',
    '      roles: [executor, reviewer]',
    '',
  ].join('\n')
  const trocado = projectText.slice(0, inicio) + bloco + projectText.slice(fim)
  if (options.missionSetupSleepMs === undefined) return trocado
  // O setup roda com `cwd` NA worktree recem-criada. Olhando o proprio cwd, o comando
  // segura so a worktree do gate da missao (`.../<runId>/mission`) e deixa as tentativas
  // passarem — sem isso, cada tentativa pagaria a mesma espera e o teste custaria minutos.
  const espera = `if (process.cwd().endsWith('mission')) setTimeout(() => undefined, ${options.missionSetupSleepMs})`
  return trocado.replace(
    '    commands: []',
    ['    commands:', `      - run: node -e "${espera}"`, '        timeoutMs: 600000'].join('\n'),
  )
}

/** Agente lento: fica em voo enquanto o control plane cai. */
const lento: StepFn = (context) => {
  if (context.kind === 'review') return review('PASS')
  return pass(`${context.taskId}: entrega lenta`, ENTREGAS[context.taskId] ?? {}, 60_000)
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

async function esperar(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  const limite = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > limite) throw new Error(`esperei ${label} por ${timeoutMs}ms`)
    await sleep(20)
  }
}

const existe = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  )

/** Sobe o control plane pelo caminho de boot do produto, sem publicar registro nem porta fixa. */
function boot(root: string): ReturnType<typeof startServer> {
  return startServer({ repoRoot: root, port: 0, publishRuntimeFile: false, webDist: root })
}

// =====================================================================================
// A — RUNNING
// =====================================================================================

interface Retrato {
  readonly run: Run
  readonly tasks: readonly TaskRun[]
  readonly attempts: readonly Attempt[]
  readonly eventos: number
}

let running: MissionHarness
let runningId: RunId
/** O DISCO no instante em que o processo 2 subiu — a base de comparacao honesta. */
let antesDoBoot: Retrato
let depoisDoBoot: Retrato
let adotadosNoBoot: readonly { readonly runId: RunId; readonly status: string }[]
let recusadosNoBoot: number
/** `attachServer` recebe um plane que ja tem dono: adotar ali criaria um segundo. */
let adotadosPorAttach: unknown

beforeAll(async () => {
  running = await createMissionHarness({ step: lento, project: comAgentesInProcess })
  runningId = running.runId
  await running.start()
  // Exatamente o que `defaultLauncher` faz no START MISSION: abre e liga o loop.
  running.orchestrator.start()
  await esperar('uma task chegar a RUNNING', async () =>
    (await running.tasks()).some((task) => task.status === 'RUNNING'),
  )

  // Queda do control plane. Banco, event log e artefatos ficam onde estao.
  await running.plane.close()

  // Base de comparacao lida do DISCO, em conexao readonly: o encerramento do processo 1
  // ainda grava, e cobrar isso do boot mediria a coisa errada.
  const { openPersistence } = await import('@agentic/persistence')
  const frio = openPersistence({ baseDir: join(running.root, '.agentic'), mode: 'readonly' })
  try {
    antesDoBoot = {
      run: (await frio.runs.loadRun(runningId)) as Run,
      tasks: await frio.runs.loadTaskRuns(runningId),
      attempts: await frio.runs.loadAttempts(runningId),
      eventos: (await frio.events.list(runningId)).length,
    }
  } finally {
    frio.close()
  }

  const servidor = await boot(running.root)
  try {
    adotadosNoBoot = (servidor.adoption?.adopted ?? []).map((entry) => ({
      runId: entry.runId,
      status: entry.status,
    }))
    recusadosNoBoot = servidor.adoption?.refused.length ?? 0
    await esperar(
      'o run adotado voltar a produzir eventos',
      async () =>
        (await servidor.plane.persistence.events.list(runningId)).length > antesDoBoot.eventos,
      15_000,
    )
    await esperar(
      'nenhuma tentativa continuar em voo',
      async () =>
        (await servidor.plane.persistence.runs.loadAttempts(runningId)).every(
          (attempt) =>
            attempt.finishedAt !== undefined || attempt.startedAt > antesDoBoot.run.createdAt,
        ),
      15_000,
    )
    depoisDoBoot = {
      run: (await servidor.plane.persistence.runs.loadRun(runningId)) as Run,
      tasks: await servidor.plane.persistence.runs.loadTaskRuns(runningId),
      attempts: await servidor.plane.persistence.runs.loadAttempts(runningId),
      eventos: (await servidor.plane.persistence.events.list(runningId)).length,
    }
  } finally {
    await servidor.close()
  }

  // `attachServer` publica sobre um plane de fora (`mission start --serve`): nao adota.
  const { createControlPlane } = await import('@agentic/orchestrator')
  const plane = createControlPlane({
    project: running.project,
    gatesFile: running.gatesFile,
    repoRoot: running.root,
  })
  const anexado = await attachServer({
    plane,
    project: running.project,
    projectText: running.sources.projectText,
    gatesText: running.sources.gatesText,
    repoRoot: running.root,
    webDist: running.root,
    port: 0,
    publishRuntimeFile: false,
  })
  adotadosPorAttach = anexado.adoption
  await anexado.close()
  await plane.close()
}, 240_000)

afterAll(async () => {
  await running?.cleanup().catch(() => undefined)
})

describe('A — RUNNING: crash com tentativa em voo, boot, adocao', () => {
  it('o disco, depois da queda, ainda pede trabalho', () => {
    expect(antesDoBoot.run.status).toBe('RUNNING')
    expect(antesDoBoot.tasks.filter((task) => task.status === 'RUNNING').length).toBeGreaterThan(0)
    expect(
      antesDoBoot.attempts.filter((attempt) => attempt.finishedAt === undefined).length,
    ).toBeGreaterThan(0)
  })

  it('o boot adota exatamente o run recuperavel, sem novo START MISSION', () => {
    expect(adotadosNoBoot).toEqual([{ runId: runningId, status: 'RUNNING' }])
    expect(recusadosNoBoot).toBe(0)
  })

  it('a tentativa orfa e encerrada como INTERRUPTED pela reconciliacao', () => {
    const orfas = depoisDoBoot.attempts.filter((attempt) =>
      antesDoBoot.attempts.some(
        (antiga) => antiga.id === attempt.id && antiga.finishedAt === undefined,
      ),
    )
    expect(orfas.length).toBeGreaterThan(0)
    for (const orfa of orfas) {
      expect(orfa.failureReason?.code).toBe('INTERRUPTED')
      expect(orfa.result).toBe('CANCELLED')
      expect(orfa.finishedAt).toBeInstanceOf(Date)
    }
  })

  it('o run volta a progredir: o event log anda depois do boot', () => {
    expect(depoisDoBoot.eventos).toBeGreaterThan(antesDoBoot.eventos)
  })

  it('`attachServer` NAO adota: o plane veio de fora e ja tem dono', () => {
    expect(adotadosPorAttach).toBeUndefined()
  })
})

// =====================================================================================
// B — PAUSED
// =====================================================================================

describe('B — PAUSED: ganha dono e reconcilia, mas nao volta a despachar', () => {
  it('reconcilia a tentativa orfa e nao despacha nada novo enquanto PAUSED', async () => {
    const h = await createMissionHarness({ step: lento, project: comAgentesInProcess })
    try {
      await h.start()
      h.orchestrator.start()
      await esperar('uma task chegar a RUNNING', async () =>
        (await h.tasks()).some((task) => task.status === 'RUNNING'),
      )
      await h.plane.pauseRun(h.runId, { actor: 'humano@teste' })
      const pendentesAntes = (await h.tasks()).filter((task) => task.status === 'PENDING').length
      const tentativasAntes = (await h.attempts()).length
      expect(pendentesAntes).toBeGreaterThan(0)
      await h.plane.close()

      const servidor = await boot(h.root)
      try {
        expect(servidor.adoption?.adopted).toEqual([
          { runId: h.runId, status: 'PAUSED', alreadyOwned: false },
        ])
        // Reconciliacao acontece mesmo pausado: tentativa sem processo nao fica em voo.
        await esperar(
          'a tentativa orfa ser encerrada',
          async () =>
            (await servidor.plane.persistence.runs.loadAttempts(h.runId)).every(
              (attempt) => attempt.finishedAt !== undefined,
            ),
          15_000,
        )
        // Uma janela generosa depois: o loop esta vivo e mesmo assim nao encheu a fila.
        await sleep(2_000)
        const run = await servidor.plane.persistence.runs.loadRun(h.runId)
        expect(run?.status).toBe('PAUSED')
        const tarefas = await servidor.plane.persistence.runs.loadTaskRuns(h.runId)
        expect(tarefas.filter((task) => task.status === 'PENDING').length).toBe(pendentesAntes)
        expect((await servidor.plane.persistence.runs.loadAttempts(h.runId)).length).toBe(
          tentativasAntes,
        )
        // Recovery de processo NAO e ato humano: nada de `run.resumed` fabricado.
        const eventos = await servidor.plane.persistence.events.list(h.runId)
        expect(eventos.filter((event) => event.type === 'run.resumed')).toHaveLength(0)
      } finally {
        await servidor.close()
      }
    } finally {
      await h.cleanup().catch(() => undefined)
    }
  }, 240_000)
})

// =====================================================================================
// C — BLOCKED
// =====================================================================================

/** Agente que entrega NADA: a tentativa reprova por `NO_CHANGES` e esgota o orcamento. */
const vazio: StepFn = (context) => {
  if (context.kind === 'review') return review('PASS')
  return pass(`${context.taskId}: nada entregue`, {}, 0)
}

describe('C — BLOCKED: ganha dono, e o unblock posterior encontra um loop vivo', () => {
  it('a tentativa concedida pelo unblock e aberta E encerrada sem intervencao', async () => {
    const h = await createMissionHarness({ step: vazio, project: comAgentesInProcess })
    try {
      await h.start()
      h.orchestrator.start()
      await esperar(
        'o run chegar a BLOCKED',
        async () => (await h.run()).status === 'BLOCKED',
        60_000,
      )
      const bloqueadas = (await h.tasks()).filter((task) => task.status === 'BLOCKED')
      expect(bloqueadas.length).toBeGreaterThan(0)
      const alvo = bloqueadas[0]?.taskId as string
      const tentativasAntes = (await h.attempts()).length
      await h.plane.close()

      const servidor = await boot(h.root)
      try {
        expect(servidor.adoption?.adopted).toEqual([
          { runId: h.runId, status: 'BLOCKED', alreadyOwned: false },
        ])
        const resposta = await fetch(`${servidor.url}/api/runs/${h.runId}/tasks/${alvo}/unblock`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ actor: 'humano@teste', note: 'segue' }),
        })
        expect(resposta.status).toBe(200)
        // A prova do loop: a tentativa concedida nao so nasce, ela TERMINA sozinha. Sem
        // loop, ela ficaria em voo para sempre — que e o defeito que D3 descreve.
        await esperar(
          'a tentativa concedida nascer e encerrar',
          async () => {
            const tentativas = await servidor.plane.persistence.runs.loadAttempts(h.runId)
            return (
              tentativas.length > tentativasAntes &&
              tentativas.every((attempt) => attempt.finishedAt !== undefined)
            )
          },
          30_000,
        )
      } finally {
        await servidor.close()
      }
    } finally {
      await h.cleanup().catch(() => undefined)
    }
  }, 240_000)
})

// =====================================================================================
// D — VERIFYING com worktree de missao stale
// =====================================================================================

describe('D — VERIFYING: worktree stale do gate da missao nao trava o run', () => {
  it('o boot devolve a worktree, o gate roda e o run sai de VERIFYING', async () => {
    // O `workspaceSetup` lento segura a aquisicao da worktree do gate: e a janela real em
    // que um crash deixa `<worktreeRoot>/<runId>/mission` para tras.
    const h = await createMissionHarness({
      step: missionStep,
      project: (text) => comAgentesInProcess(text, { missionSetupSleepMs: 30_000 }),
    })
    try {
      await h.start()
      h.orchestrator.start()
      // `VERIFYING` exige todas encerradas E ao menos uma DONE: uma task entrega de
      // verdade, o resto e dispensado. Pausar primeiro para nada novo ser despachado, e
      // `HUMAN_SKIP` so sai de PENDING/READY/BLOCKED — task em voo nao se dispensa.
      await esperar(
        'uma task concluir',
        async () => (await h.tasks()).some((task) => task.status === 'DONE'),
        120_000,
      )
      await h.plane.pauseRun(h.runId, { actor: 'humano@teste' })
      const emVoo = ['RUNNING', 'VERIFYING', 'REVIEW', 'INTEGRATING']
      await esperar(
        'as tentativas em voo terminarem',
        async () => (await h.tasks()).every((task) => !emVoo.includes(task.status)),
        120_000,
      )
      for (const task of await h.tasks()) {
        if (!['PENDING', 'READY', 'BLOCKED'].includes(task.status)) continue
        await h.plane.skipTask(h.runId, {
          taskId: task.taskId,
          actor: 'humano@teste',
          reason: 'cenario de recuperacao do gate da missao',
        })
      }
      await h.plane.resumeRun(h.runId, { actor: 'humano@teste' })
      const missionWorktree = resolve(h.root, '.agentic/worktrees', h.runId, 'mission')
      await esperar(
        'o run chegar a VERIFYING',
        async () => (await h.run()).status === 'VERIFYING',
        60_000,
      )
      await esperar('a worktree do gate da missao aparecer', () => existe(missionWorktree))
      // CRASH, nao encerramento gracioso: `plane.close()` esperaria o job do gate terminar
      // e o `finally` dele devolveria a worktree — apagando exatamente o rastro que este
      // cenario existe para reproduzir. Um processo que morre nao roda `finally` nenhum.
      h.orchestrator.stop()
      h.plane.persistence.close()

      // O crash deixou a worktree; ela precisa MESMO estar la para o cenario valer.
      expect(await existe(missionWorktree)).toBe(true)
      const { openPersistence } = await import('@agentic/persistence')
      const frio = openPersistence({ baseDir: join(h.root, '.agentic'), mode: 'readonly' })
      try {
        const parado = await frio.runs.loadRun(h.runId)
        expect(parado?.status).toBe('VERIFYING')
        expect(parado?.missionGateExecutionId).toBeUndefined()
      } finally {
        frio.close()
      }

      // O processo 2 le o project.yaml do DISCO: tirando a espera de la, o gate do boot
      // roda de verdade em vez de repetir os 30s que existiam so para abrir a janela.
      const projectPath = join(h.root, PROJECT_PATH)
      const comEspera = await readFile(projectPath, 'utf8')
      const semEspera = comEspera.replace(
        / {4}commands:\n {6}- run: node -e "if \(process\.cwd\(\)[^\n]*\n {8}timeoutMs: 600000\n/,
        '    commands: []\n',
      )
      expect(semEspera).not.toBe(comEspera)
      await writeFile(projectPath, semEspera, 'utf8')

      const servidor = await boot(h.root)
      try {
        expect(servidor.adoption?.adopted).toEqual([
          { runId: h.runId, status: 'VERIFYING', alreadyOwned: false },
        ])
        await esperar(
          'o run sair de VERIFYING',
          async () => {
            const run = await servidor.plane.persistence.runs.loadRun(h.runId)
            return run !== undefined && run.status !== 'VERIFYING'
          },
          60_000,
        )
        const run = await servidor.plane.persistence.runs.loadRun(h.runId)
        // Com todas as tasks SKIPPED o run nao e completavel; o que importa e que ele
        // DECIDIU, com o gate executado, em vez de ficar preso afirmando que verifica.
        expect(run?.status).toBe('FAILED')
        expect(run?.missionGateExecutionId).toBeTypeOf('string')
        const eventos = await servidor.plane.persistence.events.list(h.runId)
        expect(eventos.filter((event) => event.type === 'gate.finished').length).toBeGreaterThan(0)
      } finally {
        await servidor.close()
      }
    } finally {
      await h.cleanup().catch(() => undefined)
    }
  }, 300_000)
})

// =====================================================================================
// E, F, G — idempotencia e quem NAO e adotado
// =====================================================================================

describe('E/F/G — idempotencia intra-processo e limites da adocao', () => {
  it('adotar duas vezes nao cria um segundo dono para o mesmo run', async () => {
    const h = await createMissionHarness({ step: lento, project: comAgentesInProcess })
    try {
      await h.start()
      h.orchestrator.start()
      await esperar('uma task chegar a RUNNING', async () =>
        (await h.tasks()).some((task) => task.status === 'RUNNING'),
      )
      await h.plane.close()

      const { createControlPlane } = await import('@agentic/orchestrator')
      const plane = createControlPlane({
        project: h.project,
        gatesFile: h.gatesFile,
        repoRoot: h.root,
      })
      try {
        const primeira = await plane.adoptRecoverableRuns()
        const segunda = await plane.adoptRecoverableRuns()
        expect(primeira.adopted).toEqual([
          { runId: h.runId, status: 'RUNNING', alreadyOwned: false },
        ])
        // A segunda chamada reconhece o dono que ja existe em vez de criar outro.
        expect(segunda.adopted.map((entry) => entry.alreadyOwned)).toEqual([true])
        expect(await plane.open(h.runId)).toBe(await plane.open(h.runId))
      } finally {
        await plane.close()
      }
    } finally {
      await h.cleanup().catch(() => undefined)
    }
  }, 240_000)

  it('DRAFT, APPROVED e run terminal NAO recebem dono', async () => {
    const h = await createMissionHarness({ step: lento, project: comAgentesInProcess })
    try {
      // O run do harness ja esta APPROVED; leva-lo a CANCELLED cobre o caso terminal.
      await h.start()
      await h.plane.stopRun(h.runId, { actor: 'humano@teste', reason: 'cenario de adocao' })
      expect((await h.run()).status).toBe('CANCELLED')

      const rascunho = await h.plane.createRun({
        mission: h.mission,
        compiled: h.compiled,
        missionText: h.sources.missionText,
      })
      const aprovado = await h.plane.createRun({
        mission: h.mission,
        compiled: h.compiled,
        missionText: h.sources.missionText,
      })
      await h.plane.approveMission({ runId: aprovado.id, actor: 'humano@teste' })
      expect((await h.plane.persistence.runs.loadRun(rascunho.id))?.status).toBe('DRAFT')
      expect((await h.plane.persistence.runs.loadRun(aprovado.id))?.status).toBe('APPROVED')
      await h.plane.close()

      const servidor = await boot(h.root)
      try {
        expect(servidor.adoption?.adopted).toEqual([])
        expect(servidor.adoption?.refused).toEqual([])
        // Nenhum deles ganhou dono, entao nenhum deles produziu evento novo.
        for (const id of [h.runId, rascunho.id, aprovado.id]) {
          const antes = (await servidor.plane.persistence.events.list(id)).length
          await sleep(500)
          expect((await servidor.plane.persistence.events.list(id)).length).toBe(antes)
        }
      } finally {
        await servidor.close()
      }
    } finally {
      await h.cleanup().catch(() => undefined)
    }
  }, 240_000)
})
