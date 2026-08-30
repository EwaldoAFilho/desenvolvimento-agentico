import { type AgentProfile, resolveTaskSettings, type TaskSpec } from '@agentic/domain'
import type { Budget } from './capacity.js'
import type { ScopeLedger } from './locks.js'
import { type GraphPlan, sortByPriority } from './priority.js'
import type { SchedulerDecision, SchedulerInput } from './types.js'

/**
 * Candidatas a execucao: `READY` com escopo livre, perfil apto e vaga nos tres tetos.
 * Roda depois das revisoes, sobre o orcamento que elas ja consumiram.
 */
export function planExecutions(
  input: SchedulerInput,
  plan: GraphPlan,
  budget: Budget,
  ledger: ScopeLedger,
): SchedulerDecision[] {
  const decisions: SchedulerDecision[] = []
  const ready = input.tasks.filter((task) => task.status === 'READY')
  const ordered = sortByPriority(plan, ready, (task) => task.taskId)

  for (const [position, task] of ordered.entries()) {
    if (!budget.hasSlot('executor')) break

    const spec = plan.specOf(task.taskId)
    if (spec === undefined) continue
    // I2: contra lock em voo e contra o que esta leva ja reservou.
    if (ledger.conflicts(task.taskId, spec.touches)) continue

    const profile = chooseProfile(spec, input, budget)
    if (profile === undefined) continue
    if (!budget.reserve('executor', profile.providerId)) continue
    ledger.reserve(task.taskId, spec.touches)

    decisions.push({
      kind: 'dispatch-executor',
      taskId: task.taskId,
      providerId: profile.providerId,
      profileId: profile.id,
      reason: {
        dependenciesSatisfied: spec.dependencies,
        locksAcquired: spec.touches,
        providerId: profile.providerId,
        slot: 'executor',
        priority: position + 1,
      },
    })
  }

  return decisions
}

/**
 * Perfil declarado na task (ou nos defaults da missao) e restricao, nao preferencia: sem
 * capacidade nele a task espera, e nenhum outro perfil e substituido em silencio.
 */
function chooseProfile(
  spec: TaskSpec,
  input: SchedulerInput,
  budget: Budget,
): AgentProfile | undefined {
  const declared = resolveTaskSettings(spec, input.missionDefaults).agentProfile
  const pool = input.executorCandidates.filter((profile) => profile.role === 'executor')
  const scoped = declared === undefined ? pool : pool.filter((profile) => profile.id === declared)
  return scoped.find((profile) => budget.hasProvider(profile.providerId))
}
