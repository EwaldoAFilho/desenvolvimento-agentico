import type { CompiledGraph } from '@agentic/compiler'
import { toFrozenGraph } from '@agentic/compiler'
import {
  applyRunTransition,
  createTaskRun,
  type DiagnosticSeverity,
  type GateId,
  type MissionSpec,
  type Run,
  type RunId,
  type RunPolicies,
  type TaskRun,
  gateId as toGateId,
} from '@agentic/domain'
import type { CompileReportDto, DiagnosticDto, ProjectFile } from '@agentic/schemas'
import { CommandRefusedError, engineEvent, humanActor, RunNotFoundError } from '../engine/index.js'
import { hasSeverity, toCompileReport } from './compile.js'
import { type ApplicationDeps, COMPILE_REPORT_ARTIFACT, MISSION_ARTIFACT } from './deps.js'

/** As politicas efetivas do run sao congeladas no start (DOMAIN-MODEL 3.1). */
export function policiesOf(project: ProjectFile): RunPolicies {
  const execution = project.execution
  return {
    maxParallelTasks: execution.maxParallelTasks,
    maxExecutors: execution.maxExecutors,
    maxReviewers: execution.maxReviewers,
    defaultMaxAttempts: execution.defaultMaxAttempts,
    attemptTimeoutMs: Math.round(execution.attemptTimeoutMinutes * 60_000),
    retryBackoffMs: Math.round(execution.retryBackoffSeconds * 1_000),
    workspaceMode: execution.workspace,
    enforceTouches: project.policies.enforceTouches,
    denyPaths: project.policies.denyPaths,
  }
}

export function missionGateOf(mission: MissionSpec, project: ProjectFile): GateId | undefined {
  const declared = mission.missionGate ?? project.gates.missionGate
  return declared === undefined ? undefined : toGateId(declared)
}

export interface CreateRunInput {
  readonly mission: MissionSpec
  readonly compiled: CompiledGraph
  readonly project: ProjectFile
  /** Sobrescreve os diagnosticos gravados; por padrao os do proprio grafo compilado. */
  readonly diagnostics?: readonly DiagnosticDto[]
  readonly missionText?: string
}

/**
 * Cria o Run em `DRAFT` com o grafo CONGELADO: editar o mission.yaml durante a execucao
 * nao muda o run corrente (ADR-0005). Nada comeca a executar aqui.
 */
export async function createRun(deps: ApplicationDeps, input: CreateRunInput): Promise<Run> {
  const report =
    input.diagnostics === undefined
      ? toCompileReport(
          { graph: input.compiled, diagnostics: input.compiled.diagnostics },
          input.missionText ?? '',
        )
      : ({
          ...toCompileReport(
            { graph: input.compiled, diagnostics: input.compiled.diagnostics },
            input.missionText ?? '',
          ),
          diagnostics: [...input.diagnostics],
          ok: !hasSeverity(input.diagnostics, 'ERROR'),
        } satisfies CompileReportDto)

  if (!report.ok) {
    throw new CommandRefusedError('missao com diagnostico ERROR nao vira run (P01)')
  }

  const now = deps.clock.now()
  const missionGateId = missionGateOf(input.mission, input.project)
  const run: Run = {
    id: deps.ids.runId(),
    missionId: input.mission.id,
    specHash: input.compiled.specHash,
    graph: toFrozenGraph(input.compiled),
    status: 'DRAFT',
    policies: policiesOf(input.project),
    createdAt: now,
    missionGateId,
    integrationBranch:
      input.project.execution.workspace === 'git-worktree'
        ? `${input.project.integration.missionBranchPrefix}${input.mission.id}`
        : undefined,
  }
  const taskRuns: TaskRun[] = input.compiled.nodes.map((node) =>
    createTaskRun(run.id, node.task.id),
  )
  await deps.store.createRun(run, taskRuns)
  // Definicao e diagnosticos viram artefato: apos um reinicio o control plane nao depende
  // de ter o YAML em maos para decidir aprovacao e aceite de WARNING.
  await deps.artifacts.write({
    runId: run.id,
    kind: 'mission-spec',
    relativePath: MISSION_ARTIFACT,
    content: JSON.stringify(input.mission, null, 2),
  })
  await deps.artifacts.write({
    runId: run.id,
    kind: 'compile-report',
    relativePath: COMPILE_REPORT_ARTIFACT,
    content: JSON.stringify(report, null, 2),
  })
  return run
}

export async function loadRun(deps: ApplicationDeps, runId: RunId): Promise<Run> {
  const run = await deps.store.loadRun(runId)
  if (run === undefined) throw new RunNotFoundError(runId)
  return run
}

export async function loadCompileReport(
  deps: ApplicationDeps,
  runId: RunId,
): Promise<CompileReportDto | undefined> {
  try {
    const raw = await deps.artifacts.readText(runId, COMPILE_REPORT_ARTIFACT)
    return JSON.parse(raw) as CompileReportDto
  } catch {
    return undefined
  }
}

export async function loadMissionSpec(
  deps: ApplicationDeps,
  runId: RunId,
): Promise<MissionSpec | undefined> {
  try {
    const raw = await deps.artifacts.readText(runId, MISSION_ARTIFACT)
    return JSON.parse(raw) as MissionSpec
  } catch {
    return undefined
  }
}

export interface ApproveMissionInput {
  readonly runId: RunId
  readonly actor: string
  readonly note?: string
}

/**
 * ApproveMission: ato humano REGISTRADO (`human.mission_approved` com `actor`). Nao existe
 * caminho de aprovacao automatica — a guarda exige o registro para sair de DRAFT.
 */
export async function approveMission(
  deps: ApplicationDeps,
  input: ApproveMissionInput,
): Promise<Run> {
  const run = await loadRun(deps, input.runId)
  if (input.actor.trim().length === 0) {
    throw new CommandRefusedError('aprovacao exige o autor humano')
  }
  const report = await loadCompileReport(deps, input.runId)
  const diagnostics = severities(report)
  const now = deps.clock.now()
  const approved = applyRunTransition(
    run,
    { to: 'APPROVED', trigger: 'HUMAN_APPROVED' },
    { now, diagnostics, approval: { actor: input.actor, at: now } },
  )
  const warnings = diagnostics.filter((item) => item.severity === 'WARNING').length
  await deps.store.withTransaction(async (uow) => {
    await uow.saveRun(approved)
    await uow.appendEvent(
      engineEvent(
        run.id,
        now,
        'human.mission_approved',
        { actor: input.actor, at: now },
        {
          actor: humanActor(input.actor),
        },
      ),
    )
    await uow.appendEvent(
      engineEvent(
        run.id,
        now,
        'run.approved',
        { approvedBy: input.actor, warnings },
        {
          actor: humanActor(input.actor),
        },
      ),
    )
  })
  return approved
}

export interface StartRunInput {
  readonly runId: RunId
  readonly actor: string
  /** Obrigatorio e explicito: com WARNING pendente a partida exige aceite (DASHBOARD 2.1). */
  readonly acceptWarnings: boolean
  readonly diagnostics?: readonly DiagnosticDto[]
}

/**
 * StartRun: exige APPROVED, recusa ERROR, exige aceite explicito de WARNING e emite
 * `run.started` com o aceite registrado.
 */
export async function startRun(deps: ApplicationDeps, input: StartRunInput): Promise<Run> {
  const run = await loadRun(deps, input.runId)
  if (run.status !== 'APPROVED') {
    throw new CommandRefusedError(
      `run ${run.id} esta ${run.status}: START MISSION exige APPROVED (P01)`,
    )
  }
  const report = await loadCompileReport(deps, input.runId)
  const diagnostics = input.diagnostics ?? report?.diagnostics ?? []
  if (hasSeverity(diagnostics, 'ERROR')) {
    throw new CommandRefusedError('missao com diagnostico ERROR nao inicia (P01)')
  }
  if (hasSeverity(diagnostics, 'WARNING') && !input.acceptWarnings) {
    throw new CommandRefusedError(
      'ha diagnostico WARNING: a partida exige aceite explicito (--accept-warnings)',
    )
  }
  const now = deps.clock.now()
  const started = applyRunTransition(
    run,
    { to: 'RUNNING', trigger: 'RUN_STARTED' },
    {
      now,
      diagnostics: diagnostics.map((item) => ({ severity: item.severity as DiagnosticSeverity })),
      warningsAccepted: input.acceptWarnings,
    },
  )
  await deps.store.withTransaction(async (uow) => {
    await uow.saveRun(started)
    await uow.appendEvent(
      engineEvent(
        run.id,
        now,
        'run.started',
        { warningsAccepted: input.acceptWarnings },
        {
          actor: humanActor(input.actor),
        },
      ),
    )
  })
  return started
}

function severities(
  report: CompileReportDto | undefined,
): { readonly severity: DiagnosticSeverity }[] {
  return (report?.diagnostics ?? []).map((item) => ({
    severity: item.severity as DiagnosticSeverity,
  }))
}
