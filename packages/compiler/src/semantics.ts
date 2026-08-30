import type { MissionSpec, TaskSpec } from '@agentic/domain'
import type { GatesFile, ProjectFile } from '@agentic/schemas'
import type { Analysis } from './analysis.js'
import { diagnostic } from './diagnostics.js'
import { deniedBy } from './paths.js'
import type { Locate } from './sources.js'
import type { Diagnostic } from './types.js'

export interface SemanticInput {
  readonly spec: MissionSpec
  readonly project: ProjectFile
  readonly gates: GatesFile
  readonly analysis: Analysis
  readonly locateMission: Locate
  readonly locateProject: Locate
}

/** Objetivo sem uma letra ou digito nao descreve resultado nenhum. */
const MEANINGFUL = /[\p{L}\p{N}]/u

function declaredProfiles(project: ProjectFile): Set<string> {
  const profiles = new Set<string>()
  for (const config of Object.values(project.providers.registry)) {
    for (const id of Object.keys(config.profiles ?? {})) profiles.add(id)
  }
  return profiles
}

function taskPath(index: number, field?: string): (string | number)[] {
  return field === undefined ? ['tasks', index] : ['tasks', index, field]
}

/**
 * Validacao semantica: tudo o que o schema nao pode decidir sozinho porque depende da
 * missao inteira, do projeto ou de gates.yaml (ARCHITECTURE 7.1, DA1002 a DA1011).
 */
export function semanticDiagnostics(input: SemanticInput): Diagnostic[] {
  const { spec, project, gates, analysis, locateMission, locateProject } = input
  const diagnostics: Diagnostic[] = []
  const at = (index: number, field?: string) => locateMission(taskPath(index, field))

  const phases = new Set<string>(spec.phases.map((phase) => String(phase.id)))
  const profiles = new Set<string>(Object.keys(gates.profiles))
  const agentProfiles = declaredProfiles(project)
  const declared = new Set<string>()
  const denyPaths = project.policies.denyPaths

  spec.tasks.forEach((task: TaskSpec, index: number) => {
    if (declared.has(task.id)) {
      diagnostics.push(
        diagnostic('DA1002', {
          message: `task ${task.id} e declarada mais de uma vez`,
          targets: [task.id],
          at: at(index, 'id'),
        }),
      )
    }
    declared.add(task.id)

    if (!phases.has(task.phase)) {
      diagnostics.push(
        diagnostic('DA1006', {
          message: `task ${task.id} referencia a fase ${task.phase}, que nao esta em phases`,
          targets: [task.id, task.phase],
          at: at(index, 'phase'),
        }),
      )
    }

    if (task.gate !== undefined && !profiles.has(String(task.gate))) {
      diagnostics.push(
        diagnostic('DA1007', {
          message: `task ${task.id} usa o gate ${task.gate}, que nao existe em gates.yaml`,
          targets: [task.id, String(task.gate)],
          at: at(index, 'gate'),
        }),
      )
    }

    if (task.agentProfile !== undefined && !agentProfiles.has(String(task.agentProfile))) {
      diagnostics.push(
        diagnostic('DA1011', {
          message: `task ${task.id} pede o perfil ${task.agentProfile}, que nao existe no registry do projeto`,
          targets: [task.id, String(task.agentProfile)],
          at: at(index, 'agentProfile'),
        }),
      )
    }

    if (task.touches.length === 0) {
      diagnostics.push(
        diagnostic('DA1008', {
          message: `task ${task.id} nao declara touches: sem escopo de escrita nao ha contrato a verificar`,
          targets: [task.id],
          at: at(index),
        }),
      )
    }

    for (const touch of task.touches) {
      const denied = deniedBy(touch, denyPaths)
      if (denied !== undefined) {
        diagnostics.push(
          diagnostic('DA1008', {
            message: `task ${task.id} declara touches em ${touch}, negado por denyPaths (${denied})`,
            targets: [task.id, String(touch)],
            at: at(index, 'touches'),
          }),
        )
      }
    }

    if (task.touches.length > 0 && !MEANINGFUL.test(task.objective)) {
      diagnostics.push(
        diagnostic('DA1009', {
          message: `task ${task.id} altera codigo e nao descreve objective`,
          targets: [task.id],
          at: at(index, 'objective'),
        }),
      )
    }
  })

  spec.tasks.forEach((task: TaskSpec, index: number) => {
    for (const dependency of task.dependencies) {
      if (dependency === task.id) {
        diagnostics.push(
          diagnostic('DA1004', {
            message: `task ${task.id} depende de si mesma`,
            targets: [task.id],
            at: at(index, 'dependencies'),
          }),
        )
        continue
      }
      if (!declared.has(dependency)) {
        diagnostics.push(
          diagnostic('DA1003', {
            message: `task ${task.id} depende de ${dependency}, que nao existe na missao`,
            targets: [task.id, dependency],
            at: at(index, 'dependencies'),
          }),
        )
      }
    }
  })

  // Auto-dependencia ja saiu como DA1004: aqui so entram ciclos com mais de uma task.
  for (const cycle of analysis.cycles) {
    if (cycle.nodes.length < 2) continue
    diagnostics.push(
      diagnostic('DA1005', {
        message: `ciclo de dependencias: ${cycle.path.join(' → ')}`,
        targets: [...cycle.nodes],
        at: locateMission(['tasks']),
      }),
    )
  }

  if (spec.missionGate !== undefined && !profiles.has(String(spec.missionGate))) {
    diagnostics.push(
      diagnostic('DA1007', {
        message: `a missao usa o gate ${spec.missionGate}, que nao existe em gates.yaml`,
        targets: [String(spec.id), String(spec.missionGate)],
        at: locateMission(['missionGate']),
      }),
    )
  }

  const projectGate = project.gates.missionGate
  if (projectGate !== undefined && !profiles.has(projectGate)) {
    diagnostics.push(
      diagnostic('DA1007', {
        message: `project.yaml aponta o mission gate ${projectGate}, que nao existe em gates.yaml`,
        targets: ['project.gates.missionGate', projectGate],
        at: locateProject(['gates', 'missionGate']),
      }),
    )
  }

  if (project.execution.workspace === 'shared' && project.execution.maxParallelTasks > 1) {
    diagnostics.push(
      diagnostic('DA1010', {
        message: `maxParallelTasks ${project.execution.maxParallelTasks} com workspace shared: duas tasks simultaneas escreveriam na mesma arvore`,
        targets: ['project.execution.maxParallelTasks'],
        at: locateProject(['execution', 'maxParallelTasks']),
      }),
    )
  }

  const defaultProvider = project.providers.default
  if (!Object.hasOwn(project.providers.registry, defaultProvider)) {
    diagnostics.push(
      diagnostic('DA1011', {
        message: `providers.default aponta ${defaultProvider}, que nao esta no registry`,
        targets: ['project.providers.default', defaultProvider],
        at: locateProject(['providers', 'default']),
      }),
    )
  }

  return diagnostics
}
