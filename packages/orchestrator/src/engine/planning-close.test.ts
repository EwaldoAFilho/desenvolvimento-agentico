import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type {
  MissionPlanner,
  PlanningCapabilities,
  PlanningRequest,
  PlanningResult,
  ProviderId,
} from '@agentic/domain'
import { providerId as toProviderId } from '@agentic/domain'
import { acquireControlPlaneOwnership, type ControlPlaneLease } from '@agentic/persistence'
import { createMissionPlannerRegistry } from '@agentic/providers'
import { parseGatesFile, parseProjectFile } from '@agentic/schemas'
import { afterEach, describe, expect, it } from 'vitest'
import { GATE_ALWAYS_PASS, gatesYaml, projectYaml } from './__fixtures__/files.js'
import { createControlPlane } from './control-plane.js'

/**
 * I15 para o PLANEJAMENTO: um `close()` com planejamento em voo nao devolve a posse por baixo
 * de um processo de planejador vivo. O planejador que sabe cancelar e cancelado, o caso de
 * uso assenta (PLANNER_CANCELLED, nada gravado) e so entao o plane fecha. Quem nao assenta
 * dentro do prazo faz o `close` falhar — como um orquestrador que nao drena.
 */
class PlannerPendurado implements MissionPlanner {
  readonly id: ProviderId = toProviderId('pendurado')
  cancelled: string | undefined
  private resolvePending: ((result: PlanningResult) => void) | undefined

  capabilities(): PlanningCapabilities {
    return { simulated: true, acceptsRevision: false, reportsUsage: false }
  }

  plan(_request: PlanningRequest): Promise<PlanningResult> {
    return new Promise<PlanningResult>((resolve) => {
      this.resolvePending = resolve
    })
  }

  /** Como a CLI real: cancelar faz o `plan()` em voo devolver PLANNER_CANCELLED. */
  async cancel(reason: string): Promise<void> {
    this.cancelled = reason
    this.resolvePending?.({
      outcome: 'refused',
      failure: { code: 'PLANNER_CANCELLED', message: reason, problems: [] },
      logsRef: 'plan-log:pendurado/sem-processo',
    })
  }
}

/** Planejador que ignora o cancelamento: e o caso em que o close TEM de falhar. */
class PlannerSurdo extends PlannerPendurado {
  override async cancel(_reason: string): Promise<void> {
    // nao assenta
  }
}

function arquivos(): { project: never; gatesFile: never } {
  const project = parseProjectFile(projectYaml())
  if (!project.ok) throw new Error('fixture: project.yaml invalido')
  const gates = parseGatesFile(gatesYaml({ unit: [GATE_ALWAYS_PASS] }))
  if (!gates.ok) throw new Error('fixture: gates.yaml invalido')
  return { project: project.value as never, gatesFile: gates.value as never }
}

const roots: { root: string; lease: ControlPlaneLease }[] = []

const execFileAsync = promisify(execFile)

async function planeCom(planner: PlannerPendurado) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentic-plan-close-')))
  // O observador do repositorio precisa de git: sem ele o planejamento e recusado antes de
  // chegar ao planejador — e o que se prova aqui e o planejador EM VOO no close.
  await execFileAsync('git', ['init', '-q'], { cwd: root })
  await execFileAsync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'],
    { cwd: root },
  )
  const outcome = acquireControlPlaneOwnership({ baseDir: join(root, '.agentic') })
  if (!outcome.ok) throw new Error(`fixture: posse recusada (${outcome.detail})`)
  roots.push({ root, lease: outcome.lease })
  const plane = createControlPlane({
    ...arquivos(),
    repoRoot: root,
    lease: outcome.lease,
    projectText: projectYaml(),
    gatesText: gatesYaml({ unit: [GATE_ALWAYS_PASS] }),
    planners: createMissionPlannerRegistry({ planners: [planner] }),
  })
  return plane
}

afterEach(async () => {
  for (const { root, lease } of roots.splice(0)) {
    lease.release()
    await rm(root, { recursive: true, force: true })
  }
})

describe('close() com planejamento em voo (I15)', () => {
  it('cancela o planejador, espera o caso de uso assentar e so entao fecha', async () => {
    const planner = new PlannerPendurado()
    const plane = await planeCom(planner)
    if (plane.planMission === undefined) throw new Error('plane sem planejamento')
    const planning = plane.planMission({
      prompt: 'um plano qualquer',
      plannerId: toProviderId('pendurado'),
      actor: 'teste',
      acceptsSubscriptionUse: true,
    })
    // Deixa o caso de uso chegar ao planejador (impressao digital do repositorio e um await).
    await new Promise((resolve) => setTimeout(resolve, 200))
    await plane.close({ graceMs: 5_000 })
    expect(planner.cancelled).toBe('control plane encerrando')
    const result = await planning
    expect(result.outcome).toBe('refused')
    if (result.outcome === 'refused') expect(result.failure.code).toBe('PLANNER_CANCELLED')
    expect(plane.lifecycle).toBe('closed')
  })

  it('planejador que nao assenta no prazo faz o close falhar — a posse fica', async () => {
    const planner = new PlannerSurdo()
    const plane = await planeCom(planner)
    if (plane.planMission === undefined) throw new Error('plane sem planejamento')
    const planning = plane.planMission({
      prompt: 'um plano qualquer',
      plannerId: toProviderId('pendurado'),
      actor: 'teste',
      acceptsSubscriptionUse: true,
    })
    planning.catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 200))
    await expect(plane.close({ graceMs: 300 })).rejects.toThrow(/planejamento\(s\) em voo/)
    expect(plane.lifecycle).not.toBe('closed')
    // Destrava para o teste terminar limpo.
    await planner.cancel('fim do teste')
    await Promise.race([
      PlannerPendurado.prototype.cancel.call(planner, 'fim do teste'),
      new Promise((resolve) => setTimeout(resolve, 50)),
    ])
    await plane.close({ graceMs: 2_000 }).catch(() => undefined)
  })
})
