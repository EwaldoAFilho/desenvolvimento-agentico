import { pathScope, type RunStatus } from '@agentic/domain'
import { describe, expect, it } from 'vitest'
import {
  ALPHA,
  BETA,
  capacity,
  GAMMA,
  graphOf,
  identity,
  input,
  pending,
  policies,
  profile,
  shuffled,
  spec,
  specsOf,
  T,
  taskRun,
} from './__fixtures__/builders.js'
import { select } from './select.js'
import type { SchedulerInput } from './types.js'

const EXECUTOR = identity('exec-1', ALPHA, 'executor')
const REVIEWER_ALPHA = identity('rev-alpha', ALPHA, 'reviewer')
const REVIEWER_BETA = identity('rev-beta', BETA, 'reviewer')

const kinds = (decisions: readonly { kind: string }[]): string[] => decisions.map((d) => d.kind)
const ids = (decisions: readonly { taskId: string }[]): string[] => decisions.map((d) => d.taskId)

describe('select — escopo sobreposto nunca sai junto (I2)', () => {
  const tasks = [
    spec('T01', { touches: [pathScope('packages/domain/')] }),
    spec('T02', { touches: [pathScope('packages/domain/ids.ts')] }),
    spec('T03', { touches: [pathScope('packages/graph/')] }),
  ]
  const base = (overrides: Partial<SchedulerInput> = {}): SchedulerInput =>
    input({ graph: graphOf(tasks), specs: specsOf(tasks), ...overrides })

  it('descarta candidata que colide com lock ativo', () => {
    const decisions = select(
      base({
        tasks: [taskRun('T02'), taskRun('T03')],
        locks: [{ taskId: T('T01'), paths: [pathScope('packages/domain/')] }],
      }),
    )
    expect(ids(decisions)).toEqual(['T03'])
  })

  it('lock de diretorio pai bloqueia filho', () => {
    const decisions = select(
      base({
        tasks: [taskRun('T01')],
        locks: [{ taskId: T('T09'), paths: [pathScope('packages/')] }],
      }),
    )
    expect(decisions).toEqual([])
  })

  it('lock de arquivo bloqueia o diretorio que o contem', () => {
    const decisions = select(
      base({
        tasks: [taskRun('T01')],
        locks: [{ taskId: T('T09'), paths: [pathScope('packages/domain/ids.ts')] }],
      }),
    )
    expect(decisions).toEqual([])
  })

  it('fronteira de segmento: a.ts nao colide com a.tsx', () => {
    const pair = [
      spec('T01', { touches: [pathScope('src/a.ts')] }),
      spec('T02', { touches: [pathScope('src/a.tsx')] }),
    ]
    const decisions = select(
      input({
        graph: graphOf(pair),
        specs: specsOf(pair),
        tasks: [taskRun('T01'), taskRun('T02')],
      }),
    )
    expect(ids(decisions)).toEqual(['T01', 'T02'])
  })

  it('descarta par colidente dentro da mesma leva', () => {
    const decisions = select(base({ tasks: [taskRun('T01'), taskRun('T02'), taskRun('T03')] }))
    expect(ids(decisions)).toEqual(['T01', 'T03'])
  })

  it('escopos disjuntos saem juntos', () => {
    const decisions = select(base({ tasks: [taskRun('T02'), taskRun('T03')] }))
    expect(ids(decisions)).toEqual(['T02', 'T03'])
  })

  it('lock da propria task nao bloqueia o novo despacho dela', () => {
    const decisions = select(
      base({
        tasks: [taskRun('T01')],
        locks: [{ taskId: T('T01'), paths: [pathScope('packages/domain/')] }],
      }),
    )
    expect(ids(decisions)).toEqual(['T01'])
  })

  it('task sem spec conhecida nunca e despachada', () => {
    const decisions = select(base({ tasks: [taskRun('T77')] }))
    expect(decisions).toEqual([])
  })
})

describe('select — cada limite isolado', () => {
  const tasks = [spec('T01'), spec('T02'), spec('T03')]
  const three = (overrides: Partial<SchedulerInput> = {}): SchedulerInput =>
    input({
      graph: graphOf(tasks),
      specs: specsOf(tasks),
      tasks: [taskRun('T01'), taskRun('T02'), taskRun('T03')],
      ...overrides,
    })

  it('maxParallelTasks limita o total', () => {
    const decisions = select(
      three({
        policies: policies({ maxParallelTasks: 2 }),
        capacity: capacity({ global: { maxParallelTasks: 2 } }),
      }),
    )
    expect(ids(decisions)).toEqual(['T01', 'T02'])
  })

  it('maxParallelTasks da politica limita mesmo com retrato folgado', () => {
    const decisions = select(three({ policies: policies({ maxParallelTasks: 1 }) }))
    expect(ids(decisions)).toEqual(['T01'])
  })

  it('maxExecutors da politica limita mesmo com retrato folgado', () => {
    const decisions = select(three({ policies: policies({ maxExecutors: 2 }) }))
    expect(ids(decisions)).toEqual(['T01', 'T02'])
  })

  it('maxExecutors limita a execucao mesmo com folga global', () => {
    const decisions = select(
      three({
        policies: policies({ maxExecutors: 1 }),
        capacity: capacity({ executor: { max: 1 } }),
      }),
    )
    expect(ids(decisions)).toEqual(['T01'])
  })

  it('maxReviewers limita as revisoes', () => {
    const reviewTasks = [spec('T01'), spec('T02')]
    const decisions = select(
      input({
        graph: graphOf(reviewTasks),
        specs: specsOf(reviewTasks),
        tasks: [taskRun('T01', 'VERIFYING'), taskRun('T02', 'VERIFYING')],
        pendingReviews: [pending('T01', EXECUTOR), pending('T02', EXECUTOR)],
        reviewCandidates: [REVIEWER_ALPHA, REVIEWER_BETA],
        policies: policies({ maxReviewers: 1 }),
        capacity: capacity({ reviewer: { max: 1 } }),
      }),
    )
    expect(kinds(decisions)).toEqual(['dispatch-reviewer'])
    expect(ids(decisions)).toEqual(['T01'])
  })

  it('maxConcurrent do provider limita o despacho (I9)', () => {
    const decisions = select(
      three({
        capacity: capacity({ byProvider: { [ALPHA]: { maxConcurrent: 1, running: 0 } } }),
      }),
    )
    expect(ids(decisions)).toEqual(['T01'])
  })

  it('provider ja saturado nao recebe nada', () => {
    const decisions = select(
      three({
        capacity: capacity({ byProvider: { [ALPHA]: { maxConcurrent: 2, running: 2 } } }),
      }),
    )
    expect(decisions).toEqual([])
  })

  it('provider ausente do retrato e tratado como indisponivel', () => {
    const decisions = select(
      three({ capacity: capacity({ byProvider: { [BETA]: { maxConcurrent: 4, running: 0 } } }) }),
    )
    expect(decisions).toEqual([])
  })

  it('vale o menor teto entre politica do run e retrato de capacidade', () => {
    const decisions = select(
      three({
        policies: policies({ maxParallelTasks: 3 }),
        capacity: capacity({ global: { maxParallelTasks: 1 } }),
      }),
    )
    expect(ids(decisions)).toEqual(['T01'])
  })

  it('ocupacao corrente reduz as vagas disponiveis', () => {
    const decisions = select(
      three({
        capacity: capacity({
          global: { maxParallelTasks: 4, active: 2 },
          executor: { max: 4, active: 2 },
        }),
      }),
    )
    expect(ids(decisions)).toEqual(['T01', 'T02'])
  })

  it('sem vaga nenhuma nao ha decisao', () => {
    const decisions = select(
      three({ capacity: capacity({ global: { maxParallelTasks: 4, active: 4 } }) }),
    )
    expect(decisions).toEqual([])
  })
})

describe('select — drenar antes de encher (inanicao)', () => {
  const tasks = [spec('T01'), spec('T02'), spec('T03')]

  it('com 2 vagas, 2 READY e 1 revisao pendente, a revisao entra e sobra 1 execucao', () => {
    const decisions = select(
      input({
        graph: graphOf(tasks),
        specs: specsOf(tasks),
        tasks: [taskRun('T01'), taskRun('T02'), taskRun('T03', 'VERIFYING')],
        pendingReviews: [pending('T03', EXECUTOR)],
        reviewCandidates: [REVIEWER_BETA],
        policies: policies({ maxParallelTasks: 2 }),
        capacity: capacity({ global: { maxParallelTasks: 2 } }),
      }),
    )
    expect(kinds(decisions)).toEqual(['dispatch-reviewer', 'dispatch-executor'])
    expect(ids(decisions)).toEqual(['T03', 'T01'])
  })

  it('com todos os slots ocupados por executores, a proxima vaga vai para a revisao', () => {
    const decisions = select(
      input({
        graph: graphOf(tasks),
        specs: specsOf(tasks),
        tasks: [taskRun('T01'), taskRun('T02'), taskRun('T03', 'VERIFYING')],
        pendingReviews: [pending('T03', EXECUTOR)],
        reviewCandidates: [REVIEWER_BETA],
        policies: policies({ maxParallelTasks: 3 }),
        capacity: capacity({
          global: { maxParallelTasks: 3, active: 2 },
          executor: { max: 3, active: 2 },
        }),
      }),
    )
    expect(kinds(decisions)).toEqual(['dispatch-reviewer'])
    expect(ids(decisions)).toEqual(['T03'])
  })

  it('sem a regra o run estrangularia: revisao sempre precede execucao na saida', () => {
    const decisions = select(
      input({
        graph: graphOf(tasks),
        specs: specsOf(tasks),
        tasks: [taskRun('T01'), taskRun('T02'), taskRun('T03', 'VERIFYING')],
        pendingReviews: [pending('T03', EXECUTOR)],
        reviewCandidates: [REVIEWER_BETA],
      }),
    )
    expect(kinds(decisions)).toEqual([
      'dispatch-reviewer',
      'dispatch-executor',
      'dispatch-executor',
    ])
  })

  it('revisao pendente sem candidato bloqueia a task e nao consome vaga de execucao', () => {
    const decisions = select(
      input({
        graph: graphOf(tasks),
        specs: specsOf(tasks),
        tasks: [taskRun('T01'), taskRun('T02'), taskRun('T03', 'VERIFYING')],
        pendingReviews: [pending('T03', EXECUTOR)],
        reviewCandidates: [],
        policies: policies({ maxParallelTasks: 2 }),
        capacity: capacity({ global: { maxParallelTasks: 2 } }),
      }),
    )
    // Bloquear nao gasta vaga: as duas execucoes saem na mesma leva. E T03 nao fica mais
    // girando em VERIFYING sem motivo na tela — nenhum tick futuro traria um revisor que o
    // projeto nao declarou.
    expect(kinds(decisions)).toEqual(['block-task', 'dispatch-executor', 'dispatch-executor'])
    expect(ids(decisions)).toEqual(['T03', 'T01', 'T02'])
  })
})

describe('select — capacidade de provider compartilhada entre papeis', () => {
  const tasks = [spec('T01'), spec('T02')]

  it('provider com 1 vaga executando nao sobra vaga para revisar nele', () => {
    const decisions = select(
      input({
        graph: graphOf(tasks),
        specs: specsOf(tasks),
        tasks: [taskRun('T01', 'VERIFYING')],
        pendingReviews: [pending('T01', identity('exec-beta', BETA, 'executor'))],
        reviewCandidates: [REVIEWER_ALPHA],
        projectReviewPolicy: { default: 'fresh-session' },
        capacity: capacity({ byProvider: { [ALPHA]: { maxConcurrent: 1, running: 1 } } }),
      }),
    )
    expect(decisions).toEqual([])
  })

  it('revisao despachada consome a vaga do provider e a execucao espera', () => {
    const decisions = select(
      input({
        graph: graphOf(tasks),
        specs: specsOf(tasks),
        tasks: [taskRun('T01'), taskRun('T02', 'VERIFYING')],
        pendingReviews: [pending('T02', identity('exec-beta', BETA, 'executor'))],
        reviewCandidates: [REVIEWER_ALPHA],
        capacity: capacity({ byProvider: { [ALPHA]: { maxConcurrent: 1, running: 0 } } }),
      }),
    )
    expect(kinds(decisions)).toEqual(['dispatch-reviewer'])
  })

  it('provider distinto para revisar nao rouba vaga da execucao', () => {
    const decisions = select(
      input({
        graph: graphOf(tasks),
        specs: specsOf(tasks),
        tasks: [taskRun('T01'), taskRun('T02', 'VERIFYING')],
        pendingReviews: [pending('T02', EXECUTOR)],
        reviewCandidates: [REVIEWER_BETA],
        capacity: capacity({
          byProvider: {
            [ALPHA]: { maxConcurrent: 1, running: 0 },
            [BETA]: { maxConcurrent: 1, running: 0 },
          },
        }),
      }),
    )
    expect(kinds(decisions)).toEqual(['dispatch-reviewer', 'dispatch-executor'])
  })
})

describe('select — politica de revisao', () => {
  const tasks = [spec('T01', { risk: 'high' })]
  const review = (overrides: Partial<SchedulerInput> = {}): SchedulerInput =>
    input({
      graph: graphOf(tasks),
      specs: specsOf(tasks),
      tasks: [taskRun('T01', 'VERIFYING')],
      pendingReviews: [pending('T01', EXECUTOR)],
      ...overrides,
    })

  it('cross-provider-required sem segundo fornecedor vira block-task', () => {
    const decisions = select(
      review({
        reviewCandidates: [REVIEWER_ALPHA],
        projectReviewPolicy: { default: 'cross-provider-required' },
      }),
    )
    expect(decisions).toEqual([
      {
        kind: 'block-task',
        taskId: T('T01'),
        reason: 'CROSS_PROVIDER_UNAVAILABLE',
        policy: 'cross-provider-required',
      },
    ])
  })

  it('so revisor de ENSAIO vira block-task, em qualquer politica (U12)', () => {
    const ensaio = { ...identity('rev-ensaio', GAMMA, 'reviewer'), simulated: true }
    for (const policy of [
      'fresh-session',
      'cross-provider-preferred',
      'cross-provider-required',
    ] as const) {
      expect(
        select(review({ reviewCandidates: [ensaio], projectReviewPolicy: { default: policy } })),
      ).toEqual([
        { kind: 'block-task', taskId: T('T01'), reason: 'SIMULATED_REVIEWER_ONLY', policy },
      ])
    }
  })

  it('cross-provider-required nunca produz dispatch-reviewer sem segundo fornecedor', () => {
    const decisions = select(
      review({
        reviewCandidates: [REVIEWER_ALPHA, identity('rev-alpha-2', ALPHA, 'auditor')],
        projectReviewPolicy: { default: 'cross-provider-required' },
      }),
    )
    expect(kinds(decisions)).not.toContain('dispatch-reviewer')
  })

  it('cross-provider-required com segundo fornecedor e satisfeita', () => {
    const decisions = select(
      review({
        reviewCandidates: [REVIEWER_ALPHA, REVIEWER_BETA],
        projectReviewPolicy: { default: 'cross-provider-required' },
      }),
    )
    expect(decisions).toEqual([
      {
        kind: 'dispatch-reviewer',
        taskId: T('T01'),
        attemptId: 'att-T01',
        reviewer: REVIEWER_BETA,
        policy: 'cross-provider-required',
        policyOutcome: 'satisfied',
      },
    ])
  })

  it('cross-provider-preferred sem segundo fornecedor rebaixa e registra', () => {
    const decisions = select(
      review({
        reviewCandidates: [REVIEWER_ALPHA],
        projectReviewPolicy: { default: 'cross-provider-preferred' },
      }),
    )
    expect(decisions).toEqual([
      {
        kind: 'dispatch-reviewer',
        taskId: T('T01'),
        attemptId: 'att-T01',
        reviewer: REVIEWER_ALPHA,
        policy: 'cross-provider-preferred',
        policyOutcome: 'downgraded',
      },
    ])
  })

  it('cross-provider-preferred com segundo fornecedor nao rebaixa', () => {
    const decisions = select(
      review({
        reviewCandidates: [REVIEWER_ALPHA, REVIEWER_BETA],
        projectReviewPolicy: { default: 'cross-provider-preferred' },
      }),
    )
    expect(decisions[0]).toMatchObject({
      reviewer: REVIEWER_BETA,
      policyOutcome: 'satisfied',
    })
  })

  it('fresh-session aceita o mesmo fornecedor com identidade distinta', () => {
    const decisions = select(
      review({
        reviewCandidates: [REVIEWER_ALPHA],
        projectReviewPolicy: { default: 'fresh-session' },
      }),
    )
    expect(decisions[0]).toMatchObject({ reviewer: REVIEWER_ALPHA, policyOutcome: 'satisfied' })
  })

  it('a identidade do executor nunca revisa a propria tentativa (I3)', () => {
    // I3 continua valendo: o executor NAO e eleito. O que mudou e o desfecho de nao haver
    // mais ninguem — impossivel nao espera, bloqueia com motivo.
    const decisions = select(review({ reviewCandidates: [EXECUTOR] }))
    expect(decisions).toEqual([
      {
        kind: 'block-task',
        taskId: T('T01'),
        reason: 'NO_REVIEWER_AVAILABLE',
        policy: 'fresh-session',
      },
    ])
  })

  it('projeto sem revisor declarado bloqueia, em vez de esperar para sempre', () => {
    expect(select(review({ reviewCandidates: [] }))).toEqual([
      {
        kind: 'block-task',
        taskId: T('T01'),
        reason: 'NO_REVIEWER_AVAILABLE',
        policy: 'fresh-session',
      },
    ])
  })

  it('cross-provider-required com segundo fornecedor sem capacidade espera, nao bloqueia', () => {
    const decisions = select(
      review({
        reviewCandidates: [REVIEWER_ALPHA, REVIEWER_BETA],
        projectReviewPolicy: { default: 'cross-provider-required' },
        capacity: capacity({
          byProvider: {
            [ALPHA]: { maxConcurrent: 2, running: 0 },
            [BETA]: { maxConcurrent: 1, running: 1 },
          },
        }),
      }),
    )
    expect(decisions).toEqual([])
  })

  it('cross-provider-preferred nao rebaixa por falta de capacidade', () => {
    const decisions = select(
      review({
        reviewCandidates: [REVIEWER_ALPHA, REVIEWER_BETA],
        projectReviewPolicy: { default: 'cross-provider-preferred' },
        capacity: capacity({
          byProvider: {
            [ALPHA]: { maxConcurrent: 2, running: 0 },
            [BETA]: { maxConcurrent: 1, running: 1 },
          },
        }),
      }),
    )
    expect(decisions).toEqual([])
  })

  it('politica da task vence o mapa de risco do projeto', () => {
    const withPolicy = [spec('T01', { risk: 'high', reviewPolicy: 'fresh-session' })]
    const decisions = select(
      review({
        graph: graphOf(withPolicy),
        specs: specsOf(withPolicy),
        reviewCandidates: [REVIEWER_ALPHA],
        projectReviewPolicy: { byRisk: { high: 'cross-provider-required' } },
      }),
    )
    expect(decisions[0]).toMatchObject({ policy: 'fresh-session' })
  })

  it('defaults da missao valem quando a task nao declara', () => {
    const decisions = select(
      review({
        reviewCandidates: [REVIEWER_ALPHA, REVIEWER_BETA],
        missionDefaults: { reviewPolicy: 'cross-provider-required' },
        projectReviewPolicy: { default: 'fresh-session' },
      }),
    )
    expect(decisions[0]).toMatchObject({ policy: 'cross-provider-required' })
  })

  it('mapa por risco do projeto aplica quando nada mais declara', () => {
    const decisions = select(
      review({
        reviewCandidates: [REVIEWER_ALPHA],
        projectReviewPolicy: { byRisk: { high: 'cross-provider-required' } },
      }),
    )
    expect(kinds(decisions)).toEqual(['block-task'])
  })

  it('politica irresolvivel nao vira default silencioso: nenhuma decisao', () => {
    const decisions = select(
      review({ reviewCandidates: [REVIEWER_ALPHA], projectReviewPolicy: undefined }),
    )
    expect(decisions).toEqual([])
  })

  it('block-task e emitido mesmo sem vaga de revisor', () => {
    const decisions = select(
      review({
        reviewCandidates: [REVIEWER_ALPHA],
        projectReviewPolicy: { default: 'cross-provider-required' },
        policies: policies({ maxReviewers: 0 }),
        capacity: capacity({ reviewer: { max: 0 } }),
      }),
    )
    expect(kinds(decisions)).toEqual(['block-task'])
  })
})

describe('select — estado do run', () => {
  const tasks = [spec('T01'), spec('T02')]
  const withStatus = (runStatus: RunStatus): SchedulerInput =>
    input({
      graph: graphOf(tasks),
      specs: specsOf(tasks),
      tasks: [taskRun('T01'), taskRun('T02', 'VERIFYING')],
      pendingReviews: [pending('T02', EXECUTOR)],
      reviewCandidates: [REVIEWER_BETA],
      runStatus,
    })

  it.each<RunStatus>([
    'DRAFT',
    'APPROVED',
    'PAUSED',
    'BLOCKED',
    'VERIFYING',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
  ])('run %s nao despacha execucao', (status) => {
    expect(kinds(select(withStatus(status)))).not.toContain('dispatch-executor')
  })

  it.each<RunStatus>([
    'BLOCKED',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'DRAFT',
    'APPROVED',
    'VERIFYING',
  ])('run %s nao produz decisao alguma', (status) => {
    expect(select(withStatus(status))).toEqual([])
  })

  it('run PAUSED ainda drena a revisao da tentativa em voo', () => {
    expect(kinds(select(withStatus('PAUSED')))).toEqual(['dispatch-reviewer'])
  })

  it('run RUNNING despacha os dois papeis', () => {
    expect(kinds(select(withStatus('RUNNING')))).toEqual(['dispatch-reviewer', 'dispatch-executor'])
  })
})

describe('select — apenas READY concorre a execucao', () => {
  const tasks = [spec('T01')]
  const withTaskStatus = (status: Parameters<typeof taskRun>[1]) =>
    select(input({ graph: graphOf(tasks), specs: specsOf(tasks), tasks: [taskRun('T01', status)] }))

  it.each([
    'PENDING',
    'RUNNING',
    'VERIFYING',
    'REVIEW',
    'INTEGRATING',
    'DONE',
    'FAILED',
    'RETRY',
    'BLOCKED',
    'SKIPPED',
    'CANCELLED',
  ] as const)('task em %s nao e candidata', (status) => {
    expect(withTaskStatus(status)).toEqual([])
  })

  it('task em READY e candidata', () => {
    expect(ids(withTaskStatus('READY'))).toEqual(['T01'])
  })
})

describe('select — determinismo', () => {
  const tasks = [
    spec('T01', { risk: 'low' }),
    spec('T02', { risk: 'high' }),
    spec('T03', { dependencies: [T('T01')] }),
    spec('T04', { risk: 'medium' }),
  ]
  const base = input({
    graph: graphOf(tasks),
    specs: specsOf(tasks),
    tasks: [taskRun('T01'), taskRun('T02'), taskRun('T04'), taskRun('T03', 'VERIFYING')],
    pendingReviews: [pending('T03', EXECUTOR)],
    reviewCandidates: [REVIEWER_ALPHA, REVIEWER_BETA],
    policies: policies({ maxParallelTasks: 3 }),
    capacity: capacity({ global: { maxParallelTasks: 3 } }),
  })

  it('mesma entrada, mesma saida em 5 execucoes', () => {
    const first = select(base)
    for (let i = 0; i < 4; i += 1) expect(select(base)).toEqual(first)
  })

  it('ordem canonica vem do grafo, nao do array de tasks', () => {
    const expected = select(base)
    expect(select({ ...base, tasks: shuffled(base.tasks) })).toEqual(expected)
    expect(select({ ...base, tasks: shuffled(shuffled(base.tasks)) })).toEqual(expected)
  })

  it('ordem das revisoes pendentes tambem nao depende do array', () => {
    const many = [pending('T01', EXECUTOR), pending('T02', EXECUTOR), pending('T04', EXECUTOR)]
    const reviewOnly: SchedulerInput = {
      ...base,
      tasks: [
        taskRun('T01', 'VERIFYING'),
        taskRun('T02', 'VERIFYING'),
        taskRun('T04', 'VERIFYING'),
      ],
      pendingReviews: many,
    }
    const expected = select(reviewOnly)
    expect(select({ ...reviewOnly, pendingReviews: shuffled(many) })).toEqual(expected)
  })
})

describe('select — ordem de prioridade', () => {
  it('(a) caminho critico vem antes de quem destrava mais dependentes', () => {
    const tasks = [
      spec('T01', { estimate: 10 }),
      spec('T02', { estimate: 1 }),
      spec('T03', { dependencies: [T('T02')] }),
      spec('T04', { dependencies: [T('T02')] }),
      spec('T05', { dependencies: [T('T02')] }),
    ]
    const decisions = select(
      input({
        graph: graphOf(tasks),
        specs: specsOf(tasks),
        tasks: [taskRun('T01'), taskRun('T02')],
        policies: policies({ maxParallelTasks: 1 }),
        capacity: capacity({ global: { maxParallelTasks: 1 } }),
      }),
    )
    expect(ids(decisions)).toEqual(['T01'])
  })

  it('(b) empate no caminho critico resolve por numero de dependentes', () => {
    const tasks = [
      spec('T01'),
      spec('T02'),
      spec('T03', { estimate: 50 }),
      spec('T04', { dependencies: [T('T01')] }),
      spec('T05', { dependencies: [T('T01')] }),
      spec('T06', { dependencies: [T('T02')] }),
    ]
    const decisions = select(
      input({
        graph: graphOf(tasks),
        specs: specsOf(tasks),
        tasks: [taskRun('T02'), taskRun('T01'), taskRun('T03', 'BLOCKED')],
        policies: policies({ maxParallelTasks: 1 }),
        capacity: capacity({ global: { maxParallelTasks: 1 } }),
      }),
    )
    expect(ids(decisions)).toEqual(['T01'])
  })

  it('(c) empate em dependentes resolve por risco alto primeiro', () => {
    const tasks = [
      spec('T01', { risk: 'low' }),
      spec('T02', { risk: 'high' }),
      spec('T03', { estimate: 50 }),
    ]
    const decisions = select(
      input({
        graph: graphOf(tasks),
        specs: specsOf(tasks),
        tasks: [taskRun('T01'), taskRun('T02'), taskRun('T03', 'BLOCKED')],
        policies: policies({ maxParallelTasks: 1 }),
        capacity: capacity({ global: { maxParallelTasks: 1 } }),
      }),
    )
    expect(ids(decisions)).toEqual(['T02'])
  })

  it('(d) empate final resolve pela ordem topologica canonica', () => {
    const tasks = [spec('T01'), spec('T02'), spec('T03', { estimate: 50 })]
    const decisions = select(
      input({
        graph: graphOf(tasks, ['T03', 'T02', 'T01']),
        specs: specsOf(tasks),
        tasks: [taskRun('T01'), taskRun('T02'), taskRun('T03', 'BLOCKED')],
        policies: policies({ maxParallelTasks: 1 }),
        capacity: capacity({ global: { maxParallelTasks: 1 } }),
      }),
    )
    expect(ids(decisions)).toEqual(['T02'])
  })
})

describe('select — escolha de perfil executor', () => {
  const tasks = [spec('T01', { agentProfile: undefined })]
  const one = (overrides: Partial<SchedulerInput> = {}): SchedulerInput =>
    input({ graph: graphOf(tasks), specs: specsOf(tasks), tasks: [taskRun('T01')], ...overrides })

  it('perfil declarado na task e respeitado', () => {
    const declared = [spec('T01', { agentProfile: profile('executor-gamma', GAMMA).id })]
    const decisions = select(
      one({
        graph: graphOf(declared),
        specs: specsOf(declared),
        executorCandidates: [profile('executor-alpha', ALPHA), profile('executor-gamma', GAMMA)],
      }),
    )
    expect(decisions[0]).toMatchObject({ profileId: 'executor-gamma', providerId: GAMMA })
  })

  it('perfil declarado sem capacidade espera em vez de substituir', () => {
    const declared = [spec('T01', { agentProfile: profile('executor-gamma', GAMMA).id })]
    const decisions = select(
      one({
        graph: graphOf(declared),
        specs: specsOf(declared),
        executorCandidates: [profile('executor-alpha', ALPHA), profile('executor-gamma', GAMMA)],
        capacity: capacity({
          byProvider: {
            [ALPHA]: { maxConcurrent: 4, running: 0 },
            [GAMMA]: { maxConcurrent: 1, running: 1 },
          },
        }),
      }),
    )
    expect(decisions).toEqual([])
  })

  it('perfil dos defaults da missao vale quando a task nao declara', () => {
    const decisions = select(
      one({
        missionDefaults: { agentProfile: profile('executor-beta', BETA).id },
        executorCandidates: [profile('executor-alpha', ALPHA), profile('executor-beta', BETA)],
      }),
    )
    expect(decisions[0]).toMatchObject({ profileId: 'executor-beta', providerId: BETA })
  })

  it('perfil de revisor nao executa', () => {
    const reviewerOnly = { ...profile('perfil-revisor', ALPHA), role: 'reviewer' as const }
    expect(select(one({ executorCandidates: [reviewerOnly] }))).toEqual([])
  })

  it('sem perfil executor algum nao ha despacho', () => {
    expect(select(one({ executorCandidates: [] }))).toEqual([])
  })

  it('primeiro perfil com capacidade vence quando nada e declarado', () => {
    const decisions = select(
      one({
        executorCandidates: [profile('executor-gamma', GAMMA), profile('executor-alpha', ALPHA)],
        capacity: capacity({
          byProvider: {
            [ALPHA]: { maxConcurrent: 4, running: 0 },
            [GAMMA]: { maxConcurrent: 1, running: 1 },
          },
        }),
      }),
    )
    expect(decisions[0]).toMatchObject({ profileId: 'executor-alpha', providerId: ALPHA })
  })
})

describe('select — DispatchReason responde "por que agora?"', () => {
  it('carrega dependencias satisfeitas, locks, provider, papel e prioridade', () => {
    const tasks = [spec('T01'), spec('T02', { dependencies: [T('T01')] })]
    const decisions = select(
      input({
        graph: graphOf(tasks),
        specs: specsOf(tasks),
        tasks: [taskRun('T02')],
      }),
    )
    expect(decisions[0]).toEqual({
      kind: 'dispatch-executor',
      taskId: T('T02'),
      providerId: ALPHA,
      profileId: 'executor-alpha',
      reason: {
        dependenciesSatisfied: [T('T01')],
        locksAcquired: [pathScope('packages/t02/')],
        providerId: ALPHA,
        slot: 'executor',
        priority: 1,
      },
    })
  })

  it('prioridade reflete a posicao na ordenacao', () => {
    const tasks = [spec('T01'), spec('T02')]
    const decisions = select(
      input({
        graph: graphOf(tasks),
        specs: specsOf(tasks),
        tasks: [taskRun('T01'), taskRun('T02')],
      }),
    )
    expect(decisions.map((d) => (d.kind === 'dispatch-executor' ? d.reason.priority : 0))).toEqual([
      1, 2,
    ])
  })
})

describe('select — entradas degeneradas', () => {
  it('sem tasks nao ha decisao', () => {
    expect(select(input({ tasks: [] }))).toEqual([])
  })

  it('grafo vazio nao quebra a ordenacao', () => {
    const empty = { specHash: 'sha256:x', tasks: [], edges: [], topologicalOrder: [] }
    expect(select(input({ graph: empty, specs: new Map(), tasks: [taskRun('T01')] }))).toEqual([])
  })

  it('spec fora do grafo congelado ainda e usada quando vem no mapa', () => {
    const loose = spec('T09')
    const empty = { specHash: 'sha256:x', tasks: [], edges: [], topologicalOrder: [] }
    const decisions = select(
      input({ graph: empty, specs: new Map([[loose.id, loose]]), tasks: [taskRun('T09')] }),
    )
    expect(ids(decisions)).toEqual(['T09'])
  })
})
