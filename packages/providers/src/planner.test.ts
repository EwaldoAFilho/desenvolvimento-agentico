import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import type { LocalAgentRuntimeDeps } from '@agentic/agent-runtime'
import { createLocalAgentRuntime } from '@agentic/agent-runtime'
import type {
  MissionPlanner,
  MissionProposal,
  PlanningContext,
  PlanningFailure,
  PlanningProposed,
  PlanningRequest,
  PlanningResult,
} from '@agentic/domain'
import { gateId, MAX_PLAN_REVISIONS, missionId, providerId as toProviderId } from '@agentic/domain'
import { afterAll, describe, expect, it } from 'vitest'
import type { FakePlannerBundle } from './__fixtures__/fake-planner-cli.js'
import {
  envelopeAround,
  GOOD_OUTPUT,
  INVALID_PLAN,
  makeFakePlannerCli,
  makeTempDir,
  PLANNER_ARGV_FILE,
  PLANNER_ENV_FILE,
  PLANNER_PROMPT_FILE,
  PLANNER_RATIONALE,
  planBlock,
  VALID_PLAN,
  VALID_PLAN_JSON,
} from './__fixtures__/fake-planner-cli.js'
import { InvalidProviderDescriptorError, UnknownProviderError } from './errors.js'
import type { LocalCliMissionPlannerOptions, LocalCliPlannerDescriptor } from './planner.js'
import {
  assertReadOnlyPlanArgs,
  BUILT_IN_PLANNER_DESCRIPTORS,
  CLAUDE_CODE_PLAN_ARGS,
  CODEX_PLAN_ARGS,
  contextProblems,
  createMissionPlannerRegistry,
  deniedByPattern,
  LocalCliMissionPlanner,
  MAX_REVISION_PREVIOUS_CHARS,
  OutputBudget,
  PLANNER_ENV_ALLOW,
  plannerEnv,
  planningPromptText,
  planningResultFrom,
  RUNTIME_LINE_FRAGMENT_CHARS,
  readMissionProposal,
  ScriptedMissionPlanner,
  WRITE_GRANTING_ARGS,
  withoutCredentials,
} from './planner.js'

const cli: FakePlannerBundle = makeFakePlannerCli()
const probeDir = makeTempDir('agentic-planner-probe-')
const dirs: string[] = [probeDir]

function tempDir(prefix: string): string {
  const path = makeTempDir(prefix)
  dirs.push(path)
  return path
}

const deps: LocalAgentRuntimeDeps = {
  platform: 'linux',
  probeCwd: probeDir,
  probeEnv: cli.env,
  probeTimeoutMs: 5_000,
  processDeps: { killGraceMs: 200, closeGraceMs: 300 },
}

/**
 * Descritor de duble: os argumentos de leitura sao inventados de proposito. O que o teste
 * verifica e o CONTRATO do adapter, nao a linha de comando de nenhum fornecedor.
 */
const DESCRIPTOR: LocalCliPlannerDescriptor = {
  id: 'planejador-falso',
  command: cli.plano,
  versionArgs: ['--version'],
  readinessProbe: 'supported',
  readinessArgs: ['auth', 'status'],
  planArgs: ['planejar', '--somente-leitura'],
}

function planner(
  command: string,
  options: LocalCliMissionPlannerOptions = {},
  extra: Partial<LocalAgentRuntimeDeps> = {},
): LocalCliMissionPlanner {
  return new LocalCliMissionPlanner(
    { ...DESCRIPTOR, command },
    { runtime: createLocalAgentRuntime({ ...deps, ...extra }), ...options },
  )
}

function request(readRoot: string, overrides: Partial<PlanningRequest> = {}): PlanningRequest {
  return {
    prompt: 'quero uma missao que tire o atrito da primeira execucao',
    timeoutMs: 15_000,
    context: {
      readRoot,
      takenMissionIds: [missionId('DA-CORE-001'), missionId('DA-UX-001')],
      availableGates: [gateId('unit'), gateId('mission')],
      constraints: ['Nenhuma API key; somente CLI local ja autenticada'],
      denyPaths: ['.agentic/', '.env'],
    },
    ...overrides,
  }
}

function proposed(result: PlanningResult): PlanningProposed {
  if (result.outcome !== 'proposed') {
    throw new Error(`esperava proposta; veio ${result.failure.code}: ${result.failure.message}`)
  }
  return result
}

function refusal(result: PlanningResult): PlanningFailure {
  if (result.outcome !== 'refused') throw new Error('esperava recusa; veio proposta')
  return result.failure
}

function capture(): { readRoot: string; capturaDir: string; env: Record<string, string> } {
  const readRoot = tempDir('agentic-planner-raiz-')
  const capturaDir = tempDir('agentic-planner-captura-')
  return { readRoot, capturaDir, env: { ...cli.env, CAPTURA: capturaDir } }
}

afterAll(async () => {
  for (const path of dirs) await rm(path, { recursive: true, force: true })
  cli.cleanup()
})

describe('LocalCliMissionPlanner — a porta e de planejamento, nao de execucao', () => {
  it('declara capacidades honestas: nao simulado, aceita reparo, nao relata uso', () => {
    const capabilities = planner(cli.plano).capabilities()
    expect(capabilities.simulated).toBe(false)
    expect(capabilities.acceptsRevision).toBe(true)
    expect(capabilities.reportsUsage).toBe(false)
  })

  it('planeja com a raiz de leitura apenas: nao ha task, tentativa nem workspace', async () => {
    const readRoot = tempDir('agentic-planner-raiz-')
    const result = proposed(await planner(cli.plano).plan(request(readRoot)))
    expect(result.proposal.mission.id).toBe(VALID_PLAN.id)
    expect(result.usage).toBeUndefined()
    expect(result.logsRef).toContain('plan-log:planejador-falso/')
  })

  it('a sonda de saude responde sem planejar nada', async () => {
    const health = await planner(cli.plano).health()
    expect(health.installed).toBe(true)
    expect(health.ready).toBe(true)
    expect(health.running).toBe(0)
    expect(health.capacity).toBeNull()
  })

  it('declarar sonda de prontidao sem como perguntar e recusado na construcao', () => {
    expect(
      () =>
        new LocalCliMissionPlanner({
          ...DESCRIPTOR,
          readinessProbe: 'supported',
          readinessArgs: [],
        }),
    ).toThrow(InvalidProviderDescriptorError)
  })
})

describe('LocalCliMissionPlanner — proposta validada', () => {
  it('bloco marcado com envelope vira missao do dominio com o relato do planejador', async () => {
    const readRoot = tempDir('agentic-planner-raiz-')
    const { proposal } = proposed(await planner(cli.plano).plan(request(readRoot)))
    expect(proposal.mission.id).toBe('DA-EXEMPLO-001')
    expect(proposal.mission.tasks.map((task) => String(task.id))).toEqual(['T01', 'T02'])
    expect(proposal.mission.phases.map((phase) => String(phase.id))).toEqual(['contrato'])
    expect(proposal.rationale).toBe(PLANNER_RATIONALE)
  })

  it('a proposta nao carrega apiVersion nem kind: a versao do formato e nossa', async () => {
    const readRoot = tempDir('agentic-planner-raiz-')
    const { proposal } = proposed(await planner(cli.plano).plan(request(readRoot)))
    const serializado = JSON.stringify(proposal.mission)
    expect(serializado).not.toContain('apiVersion')
    expect(serializado).not.toContain('"kind"')
  })

  it('defaults do plano chegam resolvidos na task: o dominio recebe missao pronta', async () => {
    const readRoot = tempDir('agentic-planner-raiz-')
    const { proposal } = proposed(await planner(cli.plano).plan(request(readRoot)))
    const [primeira] = proposal.mission.tasks
    expect(primeira?.gate).toBe('unit')
    expect(primeira?.requireReview).toBe(true)
    expect(primeira?.maxAttempts).toBe(3)
  })

  it('plano cru, sem envelope, e aceito e simplesmente nao tem relato', async () => {
    const readRoot = tempDir('agentic-planner-raiz-')
    const { proposal } = proposed(await planner(cli.planoCru).plan(request(readRoot)))
    expect(proposal.mission.id).toBe('DA-EXEMPLO-001')
    expect(proposal.rationale).toBeUndefined()
  })

  it('bloco cercado por crases e aceito quando os marcadores nao vieram', async () => {
    const readRoot = tempDir('agentic-planner-raiz-')
    const { proposal } = proposed(await planner(cli.cercado).plan(request(readRoot)))
    expect(proposal.mission.id).toBe('DA-EXEMPLO-001')
  })

  it('CLI que ecoa a instrucao antes de responder nao entrega o modelo como plano', async () => {
    const readRoot = tempDir('agentic-planner-raiz-')
    const { proposal } = proposed(await planner(cli.eco).plan(request(readRoot)))
    expect(proposal.mission.id).toBe('DA-EXEMPLO-001')
    expect(proposal.rationale).toBe(PLANNER_RATIONALE)
  })

  it('rationale grudado no proprio plano e lido como relato, nao como campo do plano', () => {
    const reading = readMissionProposal(
      planBlock(JSON.stringify({ ...VALID_PLAN, rationale: 'escrevi no lugar errado' })),
    )
    expect(reading.ok).toBe(true)
    if (!reading.ok) return
    expect(reading.proposal.rationale).toBe('escrevi no lugar errado')
    expect(reading.proposal.mission.id).toBe('DA-EXEMPLO-001')
  })
})

describe('LocalCliMissionPlanner — falha explicada, nunca plano parcial', () => {
  it('proposta fora do contrato vira CONTRACT_REJECTED dizendo onde errou', async () => {
    const readRoot = tempDir('agentic-planner-raiz-')
    const failure = refusal(await planner(cli.invalido).plan(request(readRoot)))
    expect(failure.code).toBe('CONTRACT_REJECTED')
    expect(failure.message.length).toBeGreaterThan(0)
    const caminhos = failure.problems.map((problem) => problem.path)
    expect(caminhos).toContain('tasks[0].id')
    expect(caminhos).toContain('acceptanceCriteria')
    for (const problem of failure.problems) expect(problem.message.length).toBeGreaterThan(0)
    // O que foi recusado volta inteiro para o ciclo de reparo.
    expect(failure.raw ?? '').toContain('primeira-task')
  })

  it('plano que declara apiVersion e kind e recusado pelo contrato', async () => {
    const readRoot = tempDir('agentic-planner-raiz-')
    const failure = refusal(await planner(cli.versionado).plan(request(readRoot)))
    expect(failure.code).toBe('CONTRACT_REJECTED')
    expect(failure.problems.length).toBeGreaterThan(0)
  })

  it('saida sem nada parecido com plano vira NO_PROPOSAL com o que o planejador disse', async () => {
    const readRoot = tempDir('agentic-planner-raiz-')
    const failure = refusal(await planner(cli.semPlano).plan(request(readRoot)))
    expect(failure.code).toBe('NO_PROPOSAL')
    expect(failure.problems).toEqual([])
    expect(failure.raw ?? '').toContain('nao consegui propor nada')
  })

  it('saida diferente de zero vira PLANNER_FAILED, com o erro do processo preservado', async () => {
    const readRoot = tempDir('agentic-planner-raiz-')
    const failure = refusal(await planner(cli.falha).plan(request(readRoot)))
    expect(failure.code).toBe('PLANNER_FAILED')
    expect(failure.message).toContain('codigo 3')
    expect(failure.raw ?? '').toContain('o planejador quebrou')
  })

  it('estouro de tempo vira PLANNER_TIMEOUT, distinto de erro do planejador', async () => {
    const readRoot = tempDir('agentic-planner-raiz-')
    const failure = refusal(await planner(cli.lento).plan(request(readRoot, { timeoutMs: 400 })))
    expect(failure.code).toBe('PLANNER_TIMEOUT')
    expect(failure.message).toContain('400 ms')
  })

  it('desistencia do operador vira PLANNER_CANCELLED', async () => {
    const readRoot = tempDir('agentic-planner-raiz-')
    const lento = planner(cli.lento)
    const pendente = lento.plan(request(readRoot))
    await new Promise((resolve) => setTimeout(resolve, 250))
    await lento.cancel('operador desistiu do planejamento')
    const failure = refusal(await pendente)
    expect(failure.code).toBe('PLANNER_CANCELLED')
    expect(failure.message).toContain('operador desistiu')
  })

  it('CLI ausente vira PLANNER_UNAVAILABLE, e nao excecao vazando pela porta', async () => {
    const readRoot = tempDir('agentic-planner-raiz-')
    const failure = refusal(await planner(cli.ausente).plan(request(readRoot)))
    expect(failure.code).toBe('PLANNER_UNAVAILABLE')
  })

  it('sessao nao autenticada recusa antes de gastar assinatura', async () => {
    const readRoot = tempDir('agentic-planner-raiz-')
    const failure = refusal(await planner(cli.semLogin).plan(request(readRoot)))
    expect(failure.code).toBe('PLANNER_UNAVAILABLE')
    expect(failure.message).toContain('sem sessao utilizavel')
  })

  it('prontidao nao apurada nao recusa: a verdade aparece no processo', async () => {
    const readRoot = tempDir('agentic-planner-raiz-')
    const semSonda = planner(cli.semLogin, { probeBeforePlan: false })
    expect(proposed(await semSonda.plan(request(readRoot))).proposal.mission.id).toBe(
      'DA-EXEMPLO-001',
    )
  })

  it('raiz de leitura inexistente vira falha explicada, nao excecao', async () => {
    const readRoot = tempDir('agentic-planner-raiz-')
    const inexistente = join(readRoot, 'pasta-que-nao-existe')
    const failure = refusal(await planner(cli.plano).plan(request(inexistente)))
    expect(failure.code).toBe('PLANNER_FAILED')
    expect(failure.message.length).toBeGreaterThan(0)
  })

  it('correcao alem do limite vira REVISIONS_EXHAUSTED sem acionar a CLI', async () => {
    const { readRoot, env, capturaDir } = capture()
    const failure = refusal(
      await planner(cli.plano, { env }).plan(
        request(readRoot, {
          revision: {
            attempt: MAX_PLAN_REVISIONS + 1,
            previous: GOOD_OUTPUT,
            problems: [{ path: '', message: 'ainda nao serve' }],
          },
        }),
      ),
    )
    expect(failure.code).toBe('REVISIONS_EXHAUSTED')
    // Nenhum processo foi iniciado: nao ha captura nenhuma.
    expect(await readdir(capturaDir)).toEqual([])
  })

  it('correcao que repete o plano anterior vira PLAN_UNCHANGED', async () => {
    const readRoot = tempDir('agentic-planner-raiz-')
    const failure = refusal(
      await planner(cli.plano).plan(
        request(readRoot, {
          revision: {
            attempt: 1,
            previous: GOOD_OUTPUT,
            problems: [{ path: 'tasks', message: 'quero mais granularidade' }],
          },
        }),
      ),
    )
    expect(failure.code).toBe('PLAN_UNCHANGED')
  })

  it('mesma proposta em outra ordem de chave continua sendo a mesma proposta', () => {
    const embaralhado = Object.fromEntries(
      Object.entries(VALID_PLAN).sort(([a], [b]) => (a < b ? 1 : -1)),
    )
    const primeira = readMissionProposal(planBlock(VALID_PLAN_JSON))
    const segunda = readMissionProposal(planBlock(JSON.stringify(embaralhado)))
    expect(primeira.ok && segunda.ok).toBe(true)
    if (!primeira.ok || !segunda.ok) return
    expect(segunda.canonical).toBe(primeira.canonical)
  })
})

describe('LocalCliMissionPlanner — saida volumosa', () => {
  it('megabytes de conversa nao travam e o plano continua inteiro', {
    timeout: 30_000,
  }, async () => {
    const readRoot = tempDir('agentic-planner-raiz-')
    const { proposal } = proposed(await planner(cli.volumoso).plan(request(readRoot)))
    expect(proposal.mission.tasks).toHaveLength(2)
    expect(proposal.rationale).toBe(PLANNER_RATIONALE)
  })

  /**
   * O teto de 1 MB tambem prova que o duble e volumoso DE VERDADE: se a conversa coubesse
   * no teto, o caso passaria com proposta e o teste acima nao provaria nada.
   */
  it('passar do teto declarado recusa a saida inteira, sem corte em silencio', {
    timeout: 30_000,
  }, async () => {
    const readRoot = tempDir('agentic-planner-raiz-')
    const failure = refusal(
      await planner(cli.volumoso, { maxOutputChars: 1_000_000 }).plan(request(readRoot)),
    )
    expect(failure.code).toBe('PLANNER_FAILED')
    expect(failure.message).toContain('1000000')
    expect(failure.message).toContain('sem corte em silencio')
  })
})

describe('LocalCliMissionPlanner — planejar e leitura', () => {
  it('nenhum argumento de planejamento das CLIs conhecidas concede escrita', () => {
    const at = CLAUDE_CODE_PLAN_ARGS.indexOf('--permission-mode')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(CLAUDE_CODE_PLAN_ARGS[at + 1]).toBe('plan')
    expect(CLAUDE_CODE_PLAN_ARGS).not.toContain('acceptEdits')
    expect(CODEX_PLAN_ARGS[0]).toBe('exec')
    const sandbox = CODEX_PLAN_ARGS.indexOf('--sandbox')
    expect(sandbox).toBeGreaterThanOrEqual(0)
    expect(CODEX_PLAN_ARGS[sandbox + 1]).toBe('read-only')
    for (const descriptor of Object.values(BUILT_IN_PLANNER_DESCRIPTORS)) {
      for (const proibido of WRITE_GRANTING_ARGS) {
        expect(descriptor.planArgs.map((arg) => arg.toLowerCase())).not.toContain(proibido)
      }
    }
  })

  it('descritor que concede escrita e recusado na construcao', () => {
    for (const args of [
      ['exec', '--sandbox', 'workspace-write'],
      ['--print', '--permission-mode', 'acceptEdits'],
      ['--dangerously-skip-permissions'],
      ['exec', '--full-auto'],
    ]) {
      expect(() => planner(cli.plano, { planArgs: args })).toThrow(InvalidProviderDescriptorError)
    }
  })

  it('planejar nao deixa nada na raiz de leitura: quem grava a missao e o control plane', async () => {
    const { readRoot, env } = capture()
    const antes = await readdir(readRoot)
    proposed(await planner(cli.plano, { env }).plan(request(readRoot)))
    expect(antes).toEqual([])
    expect(await readdir(readRoot)).toEqual([])
  })

  it('o pedido vai como ultimo argumento, depois dos argumentos de leitura', async () => {
    const { readRoot, env, capturaDir } = capture()
    proposed(await planner(cli.plano, { env }).plan(request(readRoot)))
    const argv = (await readFile(join(capturaDir, PLANNER_ARGV_FILE), 'utf8')).split('\n')
    expect(argv.slice(0, DESCRIPTOR.planArgs.length)).toEqual([...DESCRIPTOR.planArgs])
    const prompt = await readFile(join(capturaDir, PLANNER_PROMPT_FILE), 'utf8')
    expect(prompt).toContain('## Como responder')
    expect(prompt).toContain('tire o atrito da primeira execucao')
  })
})

describe('LocalCliMissionPlanner — subscription-first (P17)', () => {
  it('nenhuma variavel de credencial chega ao processo do planejador', async () => {
    const readRoot = tempDir('agentic-planner-raiz-')
    nodeProcess.env.ANTHROPIC_API_KEY = 'nao-pode-vazar'
    nodeProcess.env.OPENAI_API_KEY = 'nao-pode-vazar'
    nodeProcess.env.AGENTIC_TOKEN_SECRETO = 'nao-pode-vazar'
    try {
      proposed(await planner(cli.plano).plan(request(readRoot)))
      const chaves = (await readFile(join(readRoot, PLANNER_ENV_FILE), 'utf8'))
        .split('\n')
        .filter((linha) => linha.includes('='))
        .map((linha) => linha.slice(0, linha.indexOf('=')))
      expect(chaves).toContain('PATH')
      expect(chaves).not.toContain('ANTHROPIC_API_KEY')
      expect(chaves).not.toContain('OPENAI_API_KEY')
      expect(chaves).not.toContain('AGENTIC_TOKEN_SECRETO')
      expect(chaves.filter((nome) => /KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD/i.test(nome))).toEqual(
        [],
      )
    } finally {
      delete nodeProcess.env.ANTHROPIC_API_KEY
      delete nodeProcess.env.OPENAI_API_KEY
      delete nodeProcess.env.AGENTIC_TOKEN_SECRETO
    }
  })

  it('a allowlist e por nome e nome que parece credencial nao passa nem se listado', () => {
    const env = plannerEnv([...PLANNER_ENV_ALLOW, 'ANTHROPIC_API_KEY'], {
      PATH: '/usr/bin',
      HOME: '/home/pessoa',
      ANTHROPIC_API_KEY: 'nao-pode-vazar',
      OUTRA: 'ignorada por nao estar na lista',
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/pessoa')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.OUTRA).toBeUndefined()
  })

  it('ambiente montado por outro codigo passa pelo mesmo filtro', () => {
    const limpo = withoutCredentials({ PATH: '/usr/bin', GITHUB_TOKEN: 'nao-pode-vazar' })
    expect(limpo).toEqual({ PATH: '/usr/bin' })
  })
})

describe('planningPromptText — o contexto que o planejador precisa, e nada alem', () => {
  it('leva pedido, raiz de leitura, ids ocupados, gates, restricoes e denyPaths', () => {
    const prompt = planningPromptText(request('/tmp/projeto-x'))
    expect(prompt).toContain('tire o atrito da primeira execucao')
    expect(prompt).toContain('/tmp/projeto-x')
    expect(prompt).toContain('DA-CORE-001')
    expect(prompt).toContain('- unit')
    expect(prompt).toContain('Nenhuma API key')
    expect(prompt).toContain('.agentic/')
  })

  it('diz o que o planejador nao faz: nao grava, nao executa, nao aprova', () => {
    const prompt = planningPromptText(request('/tmp/projeto-x'))
    expect(prompt).toContain('nao grave arquivo nenhum')
    expect(prompt).toContain('quem escreve o arquivo da missao e o control plane')
    expect(prompt).toContain('nao aprove nada: propor e todo o seu papel')
    expect(prompt).toContain('NAO declare apiVersion nem kind')
  })

  it('o pedido de correcao leva os problemas e a proposta anterior', () => {
    const prompt = planningPromptText(
      request('/tmp/projeto-x', {
        revision: {
          attempt: 1,
          previous: 'plano anterior recusado',
          problems: [{ path: 'tasks[0].id', message: 'id fora do padrao' }],
        },
      }),
    )
    expect(prompt).toContain(`Correcao pedida (1 de ${MAX_PLAN_REVISIONS})`)
    expect(prompt).toContain('tasks[0].id: id fora do padrao')
    expect(prompt).toContain('plano anterior recusado')
  })

  it('proposta anterior gigante entra cortada, e o corte aparece no texto', () => {
    const gigante = 'x'.repeat(MAX_REVISION_PREVIOUS_CHARS + 500)
    const prompt = planningPromptText(
      request('/tmp/projeto-x', {
        revision: { attempt: 2, previous: `${gigante}FIM-DA-PROPOSTA`, problems: [] },
      }),
    )
    expect(prompt).toContain(`cortada em ${MAX_REVISION_PREVIOUS_CHARS} caracteres`)
    expect(prompt).not.toContain('FIM-DA-PROPOSTA')
  })
})

describe('ScriptedMissionPlanner — planejador simulado, sem quota', () => {
  const readRoot = '/tmp/nao-precisa-existir'

  it('declara-se simulado: simulacao nao se apresenta como planejamento de verdade', () => {
    const roteiro = new ScriptedMissionPlanner({ script: [] })
    expect(roteiro.capabilities().simulated).toBe(true)
  })

  it('roteiro devolve proposta validada sem iniciar processo nenhum', async () => {
    const roteiro = new ScriptedMissionPlanner({
      script: [{ output: planBlock(envelopeAround(VALID_PLAN)) }],
    })
    const { proposal } = proposed(await roteiro.plan(request(readRoot)))
    expect(proposal.mission.id).toBe('DA-EXEMPLO-001')
    expect(proposal.rationale).toBe(PLANNER_RATIONALE)
  })

  it('roteiro recusa pelo mesmo contrato do adapter real', async () => {
    const roteiro = new ScriptedMissionPlanner({
      script: [{ output: planBlock(JSON.stringify(INVALID_PLAN)) }],
    })
    const failure = refusal(await roteiro.plan(request(readRoot)))
    expect(failure.code).toBe('CONTRACT_REJECTED')
    expect(failure.problems.length).toBeGreaterThan(0)
  })

  it('a correcao consome o passo seguinte do roteiro', async () => {
    const roteiro = new ScriptedMissionPlanner({
      script: [
        { output: planBlock(JSON.stringify(INVALID_PLAN)) },
        { output: planBlock(VALID_PLAN_JSON) },
      ],
    })
    const primeira = refusal(await roteiro.plan(request(readRoot)))
    expect(primeira.code).toBe('CONTRACT_REJECTED')
    const segunda = proposed(
      await roteiro.plan(
        request(readRoot, {
          revision: { attempt: 1, previous: primeira.raw ?? '', problems: primeira.problems },
        }),
      ),
    )
    expect(segunda.proposal.mission.id).toBe('DA-EXEMPLO-001')
  })

  it('roteiro encena falha de processo sem inventar plano', async () => {
    const roteiro = new ScriptedMissionPlanner({ script: [{ failWith: 'PLANNER_TIMEOUT' }] })
    expect(refusal(await roteiro.plan(request(readRoot))).code).toBe('PLANNER_TIMEOUT')
  })
})

describe('DefaultMissionPlannerRegistry', () => {
  const real = (): MissionPlanner => planner(cli.plano, { id: toProviderId('planejador-real') })
  const simulado = (): MissionPlanner =>
    new ScriptedMissionPlanner({ id: toProviderId('planejador-roteiro'), script: [] })

  it('lista em ordem estavel e devolve o planejador pedido', () => {
    const registry = createMissionPlannerRegistry({ planners: [simulado(), real()] })
    expect(registry.list().map(String)).toEqual(['planejador-real', 'planejador-roteiro'])
    expect(String(registry.get(toProviderId('planejador-real')).id)).toBe('planejador-real')
  })

  it('o padrao nao cai no simulado quando existe planejador de verdade', () => {
    const registry = createMissionPlannerRegistry({ planners: [simulado(), real()] })
    expect(String(registry.default())).toBe('planejador-real')
  })

  it('so com simulado, o padrao e ele — e `simulated` continua dizendo a verdade', () => {
    const registry = createMissionPlannerRegistry({ planners: [simulado()] })
    const escolhido = registry.default()
    expect(String(escolhido)).toBe('planejador-roteiro')
    if (escolhido === undefined) return
    expect(registry.get(escolhido).capabilities().simulated).toBe(true)
  })

  it('sem planejador nenhum, nao ha padrao para oferecer', () => {
    const registry = createMissionPlannerRegistry({ planners: [] })
    expect(registry.default()).toBeUndefined()
    expect(registry.list()).toEqual([])
  })

  it('planejador desconhecido e erro de configuracao, nao falha de planejamento', () => {
    const registry = createMissionPlannerRegistry({ planners: [real()] })
    expect(() => registry.get(toProviderId('nao-existe'))).toThrow(UnknownProviderError)
  })

  it('padrao explicito fora da lista e recusado na construcao', () => {
    expect(() =>
      createMissionPlannerRegistry({
        planners: [real()],
        default: toProviderId('planejador-que-nao-registrei'),
      }),
    ).toThrow(UnknownProviderError)
  })
})

/**
 * Os tres achados que bloquearam U05 na revisao independente. Cada um falha sem a correcao —
 * verificado desligando a correcao e vendo o teste reprovar.
 */
describe('planejador: os tres achados da revisao', () => {
  it('recusa argumento de escrita tambem na forma colada com =', () => {
    // A comparacao por igualdade so pegava a forma separada; esta escapava.
    expect(() => assertReadOnlyPlanArgs('p', ['--sandbox=workspace-write'])).toThrow()
    expect(() => assertReadOnlyPlanArgs('p', ['--permission-mode=acceptEdits'])).toThrow()
    expect(() => assertReadOnlyPlanArgs('p', ['--sandbox', 'workspace-write'])).toThrow()
    // Argumento legitimo de leitura continua passando.
    expect(() => assertReadOnlyPlanArgs('p', ['--sandbox=read-only', '--print'])).not.toThrow()
  })

  it('recusa proposta que colide com id ocupado, gate inexistente ou caminho proibido', () => {
    const context = {
      readRoot: '/tmp/x',
      takenMissionIds: ['DA-JA-001'],
      availableGates: ['unit'],
      constraints: [],
      denyPaths: ['.agentic/'],
    } as unknown as PlanningContext

    const colide = {
      mission: { id: 'DA-JA-001', missionGate: 'unit', tasks: [] },
    } as unknown as MissionProposal
    expect(contextProblems(colide, context).map((p) => p.path)).toContain('mission.id')

    const gateFantasma = {
      mission: { id: 'DA-NOVA-001', tasks: [{ id: 'T01', gate: 'inexistente', touches: [] }] },
    } as unknown as MissionProposal
    expect(contextProblems(gateFantasma, context)[0]?.message).toContain('nao existe')

    const proibido = {
      mission: {
        id: 'DA-NOVA-001',
        tasks: [{ id: 'T01', gate: 'unit', touches: ['.agentic/project.yaml'] }],
      },
    } as unknown as MissionProposal
    expect(contextProblems(proibido, context)[0]?.message).toContain('proibido')

    const ok = {
      mission: {
        id: 'DA-NOVA-001',
        missionGate: 'unit',
        tasks: [{ id: 'T01', gate: 'unit', touches: ['apps/web/'] }],
      },
    } as unknown as MissionProposal
    expect(contextProblems(ok, context)).toEqual([])
  })

  it('a checagem de contexto esta LIGADA ao fluxo, nao so disponivel', () => {
    // Sem esta assercao, contextProblems poderia existir e nunca ser chamada — foi
    // exatamente o que aconteceu quando desliguei a ligacao e o teste anterior seguiu verde.
    const pedido = request(tempDir('agentic-planner-ctx-'))
    const ocupado = {
      ...pedido,
      context: { ...pedido.context, takenMissionIds: ['DA-EXEMPLO-001'] },
    } as unknown as PlanningRequest

    const resultado = planningResultFrom(planBlock(VALID_PLAN_JSON), ocupado, 'logs')

    expect(resultado.outcome).toBe('refused')
    if (resultado.outcome !== 'refused') return
    expect(resultado.failure.code).toBe('CONTRACT_REJECTED')
    expect(resultado.failure.problems.map((p) => p.path)).toContain('mission.id')
  })
})

describe('planejador: defeitos que o revisor achou na PRIMEIRA correcao', () => {
  it('caminho proibido casa por segmento, sem falso positivo de prefixo textual', () => {
    const context = {
      readRoot: '/tmp/x',
      takenMissionIds: [],
      availableGates: ['unit'],
      constraints: [],
      denyPaths: ['.agentic/', '.env', '*.pem'],
    } as unknown as PlanningContext
    const plano = (touches: string[]) =>
      ({
        mission: { id: 'DA-NOVA-001', tasks: [{ id: 'T01', gate: 'unit', touches }] },
      }) as unknown as MissionProposal

    expect(contextProblems(plano(['.agentic/missions/']), context)).toHaveLength(1)
    // `.agentic-docs/` nao esta dentro de `.agentic/`: prefixo textual dizia que sim.
    expect(contextProblems(plano(['.agentic-docs/']), context)).toEqual([])
    // `banned.startsWith(alvo)` reprovava `apps/` so porque existe deny `.env`... e pior,
    // reprovava qualquer prefixo de um caminho proibido. Nao pode.
    expect(contextProblems(plano(['apps/']), context)).toEqual([])
  })

  it('saida fragmentada e RECUSADA em vez de remontada por adivinhacao', () => {
    const budget = new OutputBudget(10_000_000)
    budget.push('stdout', 'x'.repeat(RUNTIME_LINE_FRAGMENT_CHARS))
    budget.push('stdout', 'cauda')
    expect(budget.fragmented('stdout')).toBe(true)

    // Saida normal nao dispara recusa nenhuma.
    const normal = new OutputBudget(10_000_000)
    normal.push('stdout', 'tr')
    normal.push('stdout', 'ue')
    expect(normal.fragmented('stdout')).toBe(false)
    expect(normal.text('stdout')).toBe('tr\nue')
  })

  it('caminho proibido por glob e pego: *.pem nega certs/server.pem', () => {
    // Comparacao por prefixo deixava passar; o compilador ja aplicava glob e o adapter nao.
    expect(deniedByPattern('certs/server.pem', ['*.pem'])).toBe('*.pem')
    expect(deniedByPattern('.agentic/project.yaml', ['.agentic/'])).toBe('.agentic/')
    expect(deniedByPattern('apps/web/', ['.agentic/', '*.pem'])).toBeUndefined()
    // `*` nao atravessa `/`.
    expect(deniedByPattern('a/b/c.pem', ['*.pem'])).toBe('*.pem')
  })
})
