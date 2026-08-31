import type { Run, RunStatus } from '@agentic/domain'
import type {
  ApproveMissionCommand,
  CompileReportDto,
  CreateDraftResultDto,
  MissionSummaryDto,
  RunHeaderDto,
} from '@agentic/schemas'
import { ApproveMissionCommandSchema } from '@agentic/schemas'
import type { FastifyInstance } from 'fastify'
import type { ServerDeps } from '../deps.js'
import { toRunHeader } from '../dto.js'
import { badRequest, toApiIssues } from '../errors.js'
import {
  compileMissionRef,
  compileMissionSource,
  findRun,
  listRunSummaries,
  missionSpecOf,
  missionSummaries,
  readMissionSource,
  refuseOnErrors,
} from '../missions.js'

export interface ApproveMissionResult {
  readonly runId: string
  readonly run: RunHeaderDto
  readonly report: CompileReportDto
  /** Aprovar duas vezes o MESMO spec nao gera segundo registro humano. */
  readonly alreadyApproved: boolean
}

interface MissionParams {
  readonly file: string
}

function missionRefOf(body: unknown, fallback?: string): string {
  const source = (body ?? {}) as Record<string, unknown>
  const ref = source.file ?? source.missionPath ?? source.missionId ?? fallback
  if (typeof ref !== 'string' || ref.trim().length === 0) {
    throw badRequest('MISSION_REF_REQUIRED', 'informe a missao em `file`')
  }
  return ref
}

/** Sem `actor` nao ha aprovacao: o contrato exige o autor humano e o servidor nao inventa um. */
function approveCommandOf(body: unknown): ApproveMissionCommand {
  const source = (body ?? {}) as Record<string, unknown>
  const parsed = ApproveMissionCommandSchema.safeParse({
    actor: source.actor,
    ...(source.note === undefined ? {} : { note: source.note }),
  })
  if (!parsed.success) {
    throw badRequest('APPROVAL_REQUIRES_ACTOR', 'aprovacao exige o autor humano em `actor`', {
      issues: toApiIssues(parsed.error.issues),
    })
  }
  return parsed.data
}

/**
 * Um rascunho ja existente para ESTE spec. `APPROVED` conta: devolver o run que ja nasceu
 * deste plano e o que impede um segundo run do mesmo spec — o mesmo defeito de que a recusa
 * de START MISSION ja avisa. Run que ja partiu nao entra: aquele plano ja virou execucao, e
 * um rascunho novo e pedido legitimo.
 */
const DRAFTABLE_STATUSES = ['DRAFT', 'APPROVED'] as const satisfies readonly RunStatus[]

/**
 * I7 diz que o control plane e o unico ESCRITOR do estado; nao diz que ele atende uma
 * requisicao por vez. `findRun` seguido de `createRun` e consultar-depois-criar: dois POST
 * simultaneos do mesmo plano passam ambos pela consulta antes de qualquer um gravar, e
 * nascem dois rascunhos para o mesmo specHash — que e exatamente o que a idempotencia
 * promete impedir. Como o processo e um so, serializar por (missionId, specHash) fecha a
 * janela sem tocar no schema nem introduzir indice parcial.
 */
const draftGate = new Map<string, Promise<unknown>>()

export async function serializedByPlan<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = draftGate.get(key)
  const run = previous === undefined ? work() : previous.then(work, work)
  // O gate guarda apenas a ORDEM, nunca o resultado nem o erro: uma falha nao pode
  // envenenar o proximo pedido do mesmo plano.
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  draftGate.set(key, settled)
  void settled.then(() => {
    if (draftGate.get(key) === settled) draftGate.delete(key)
  })
  return run
}

/**
 * CreateDraft: compila, CONGELA o grafo e para. Nao aprova, nao parte e nao registra ato
 * humano — ver o DAG antes de decidir e justamente o que o humano precisa para decidir
 * (P15). Idempotente por versao do plano: o mesmo `specHash` devolve o mesmo run, entao
 * clicar duas vezes nao cria dois.
 */
async function createDraft(
  deps: ServerDeps,
  ref: string,
): Promise<{ result: CreateDraftResultDto; created: boolean }> {
  const compiled = await compileMissionRef(deps, ref)
  refuseOnErrors(compiled)
  const graph = compiled.graph
  if (graph === undefined) {
    throw badRequest('MISSION_HAS_ERRORS', 'missao nao compilou', {
      diagnostics: compiled.report.diagnostics,
    })
  }

  const missionId = String(compiled.report.missionId)
  // Consulta e criacao viram um ato so por plano: sem isto, dois cliques simultaneos criam
  // dois rascunhos e a idempotencia so vale para chamadas sequenciais.
  const decided = await serializedByPlan(`${missionId}@${graph.specHash}`, async () => {
    const existing = await findRun(deps, {
      missionId,
      specHash: graph.specHash,
      statuses: DRAFTABLE_STATUSES,
    })
    if (existing !== undefined) return { run: existing, created: false }
    const criado = await deps.plane.createRun({
      mission: missionSpecOf(compiled.source),
      compiled: graph,
      missionText: compiled.source.text,
    })
    return { run: criado, created: true }
  })
  if (!decided.created) {
    return {
      result: { run: toRunHeader(decided.run), report: compiled.report, alreadyExisted: true },
      created: false,
    }
  }

  const run = decided.run
  return {
    result: { run: toRunHeader(run), report: compiled.report, alreadyExisted: false },
    created: true,
  }
}

/**
 * ApproveMission: ato humano REGISTRADO (`human.mission_approved` com `actor`). O Run nasce
 * aqui em DRAFT com o grafo CONGELADO — editar o YAML depois nao muda o que foi aprovado
 * (ADR-0005). Nao existe aprovacao automatica.
 */
async function approve(
  deps: ServerDeps,
  ref: string,
  body: unknown,
): Promise<ApproveMissionResult> {
  const command = approveCommandOf(body)
  const source = await readMissionSource(deps, ref)
  const compiled = compileMissionSource(deps, source)
  refuseOnErrors(compiled)
  const graph = compiled.graph
  if (graph === undefined) {
    throw badRequest('MISSION_HAS_ERRORS', 'missao nao compilou', {
      diagnostics: compiled.report.diagnostics,
    })
  }

  const lookup = { missionId: String(compiled.report.missionId), specHash: graph.specHash }
  const existing = await findRun(deps, { ...lookup, statuses: ['APPROVED'] })
  if (existing !== undefined) {
    return {
      runId: existing.id,
      run: toRunHeader(existing),
      report: compiled.report,
      alreadyApproved: true,
    }
  }

  const draft = await findRun(deps, { ...lookup, statuses: ['DRAFT'] })
  const target: Run =
    draft ??
    (await deps.plane.createRun({
      mission: missionSpecOf(source),
      compiled: graph,
      missionText: source.text,
    }))
  const approved = await deps.plane.approveMission({
    runId: target.id,
    actor: command.actor,
    ...(command.note === undefined ? {} : { note: command.note }),
  })
  return {
    runId: approved.id,
    run: toRunHeader(approved),
    report: compiled.report,
    alreadyApproved: false,
  }
}

export function registerMissionRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get('/api/missions', async (): Promise<MissionSummaryDto[]> => {
    return missionSummaries(deps, await listRunSummaries(deps))
  })

  app.get('/api/missions/compile', async (request): Promise<CompileReportDto> => {
    const query = request.query as Record<string, unknown>
    return (await compileMissionRef(deps, missionRefOf(query))).report
  })

  app.post('/api/missions/compile', async (request): Promise<CompileReportDto> => {
    return (await compileMissionRef(deps, missionRefOf(request.body))).report
  })

  app.get<{ Params: MissionParams }>(
    '/api/missions/:file/compile',
    async (request): Promise<CompileReportDto> => {
      return (await compileMissionRef(deps, request.params.file)).report
    },
  )

  // 201 quando o rascunho nasceu agora, 200 quando ja existia: o corpo diz o mesmo em
  // `alreadyExisted`, e nenhum dos dois e erro.
  app.post('/api/missions/draft', async (request, reply) => {
    const { result, created } = await createDraft(deps, missionRefOf(request.body))
    return reply.status(created ? 201 : 200).send(result)
  })

  app.post<{ Params: MissionParams }>('/api/missions/:file/draft', async (request, reply) => {
    const ref = missionRefOf(request.body, request.params.file)
    const { result, created } = await createDraft(deps, ref)
    return reply.status(created ? 201 : 200).send(result)
  })

  app.post('/api/missions/approve', async (request, reply) => {
    return reply.status(200).send(await approve(deps, missionRefOf(request.body), request.body))
  })

  app.post<{ Params: MissionParams }>('/api/missions/:file/approve', async (request, reply) => {
    const ref = missionRefOf(request.body, request.params.file)
    return reply.status(200).send(await approve(deps, ref, request.body))
  })
}
