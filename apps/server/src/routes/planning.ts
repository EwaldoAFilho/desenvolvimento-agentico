import type { PlanningFailureCode } from '@agentic/domain'
import { providerId as toProviderId } from '@agentic/domain'
import type { PlanMissionInput, PlanMissionResult } from '@agentic/orchestrator'
import { toProviderHealthDto } from '@agentic/orchestrator'
import type {
  PlanMissionCommand,
  PlanMissionResultDto,
  PlannerDto,
  PlanningFailureDto,
} from '@agentic/schemas'
import { PlanMissionCommandSchema, providerStateOf } from '@agentic/schemas'
import type { FastifyInstance } from 'fastify'
import type { ServerDeps } from '../deps.js'
import { toRunHeader } from '../dto.js'
import { badRequest, HttpError, toApiIssues } from '../errors.js'

/**
 * Planejar pela API. A rota e FINA como as outras: valida o comando, chama UM caso de uso do
 * orquestrador e traduz a saida em DTO. Quem aciona o planejador, confere o repositorio,
 * grava o arquivo da missao e compila e o control plane — o servidor nao escreve arquivo,
 * nao compila por conta e nao decide quantas correcoes cabem.
 */

/**
 * Falha de planejamento e DIAGNOSTICO, nao erro de protocolo: o corpo e o proprio
 * `PlanningFailureDto`, para a tela poder dizer o que aconteceu em vez de mostrar "erro".
 * O status separa o que o humano conserta (422) do que e ambiente (503/504).
 */
const STATUS_BY_FAILURE: Readonly<Partial<Record<PlanningFailureCode, number>>> = {
  PLANNER_UNAVAILABLE: 503,
  PLANNER_TIMEOUT: 504,
}

const REFUSED_STATUS = 422

function statusOf(code: PlanningFailureCode): number {
  return STATUS_BY_FAILURE[code] ?? REFUSED_STATUS
}

function commandOf(body: unknown): PlanMissionCommand {
  const parsed = PlanMissionCommandSchema.safeParse(body ?? {})
  if (!parsed.success) {
    throw badRequest('PLAN_COMMAND_INVALID', 'pedido de planejamento invalido', {
      issues: toApiIssues(parsed.error.issues),
    })
  }
  return parsed.data
}

/**
 * O caso de uso, ou uma recusa explicita. Um control plane montado sem planejamento diz
 * isso com codigo proprio — melhor do que uma rota que existe e nunca responde.
 */
function planMissionOf(deps: ServerDeps): (input: PlanMissionInput) => Promise<PlanMissionResult> {
  const plane = deps.plane
  const plan = plane.planMission
  if (plan === undefined) {
    throw new HttpError(
      501,
      'PLANNING_UNAVAILABLE',
      'este control plane foi montado sem planejamento de missao',
    )
  }
  return (input) => plan.call(plane, input)
}

/**
 * Quem pode planejar, e com que honestidade se apresenta. `simulated` vem da porta e nao de
 * um palpite: e o que impede um planejador de fixture de ser oferecido como planejamento de
 * verdade, e o que permite a tela avisar o consumo ANTES de acionar o que e real (P17).
 *
 * `state` sai da MESMA derivacao do painel de fornecedores. Planejador sem fornecedor
 * correspondente fica `UNKNOWN`: prontidao nao apurada nunca vira verde.
 */
export async function planners(deps: ServerDeps): Promise<PlannerDto[]> {
  const registry = deps.plane.planners
  if (registry === undefined) return []
  const health = await deps.plane.registry.health()
  const states = new Map(
    health.map((item) => {
      const dto = toProviderHealthDto(item)
      return [String(dto.providerId), providerStateOf(dto)] as const
    }),
  )
  return registry.list().map((id): PlannerDto => {
    const capabilities = registry.get(id).capabilities()
    return {
      providerId: id,
      simulated: capabilities.simulated,
      acceptsRevision: capabilities.acceptsRevision,
      reportsUsage: capabilities.reportsUsage,
      state: states.get(String(id)) ?? 'UNKNOWN',
    }
  })
}

function toFailureDto(
  result: Extract<PlanMissionResult, { outcome: 'refused' }>,
): PlanningFailureDto {
  return {
    code: result.failure.code,
    message: result.failure.message,
    problems: result.failure.problems.map((problem) => ({
      path: problem.path,
      message: problem.message,
    })),
    revisions: result.revisions,
    plannerId: result.plannerId,
  }
}

function toResultDto(
  result: Extract<PlanMissionResult, { outcome: 'planned' }>,
): PlanMissionResultDto {
  return {
    missionId: result.missionId,
    file: result.file,
    plannerId: result.plannerId,
    revisions: result.revisions,
    run: toRunHeader(result.run),
    report: result.report,
    ...(result.rationale === undefined ? {} : { rationale: result.rationale }),
  }
}

export function registerPlanningRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get('/api/planners', async (): Promise<PlannerDto[]> => planners(deps))

  // 201 porque nasceu uma missao e um rascunho. Nunca 200 com plano vazio: planejamento que
  // nao deu certo responde com o motivo, no status que separa conserto humano de ambiente.
  app.post('/api/missions/plan', async (request, reply) => {
    const command = commandOf(request.body)
    const plan = planMissionOf(deps)
    const result = await plan({
      prompt: command.prompt,
      actor: command.actor,
      acceptsSubscriptionUse: command.acceptsSubscriptionUse,
      ...(command.plannerId === undefined ? {} : { plannerId: toProviderId(command.plannerId) }),
    })
    if (result.outcome === 'refused') {
      return reply.status(statusOf(result.failure.code)).send(toFailureDto(result))
    }
    return reply.status(201).send(toResultDto(result))
  })
}
