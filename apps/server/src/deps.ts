import { resolve } from 'node:path'
import type { RunId } from '@agentic/domain'
import type { ControlPlane } from '@agentic/orchestrator'
import type { ProjectFile } from '@agentic/schemas'
import { DEFAULT_HEARTBEAT_MS, DEFAULT_MISSIONS_DIR, DEFAULT_WEB_DIST } from './config.js'

/**
 * Como a orquestracao comeca depois do START MISSION. UM clique: o servidor pede o inicio
 * do loop e o orquestrador descobre TODAS as tasks READY. O servidor nao despacha task a
 * task e nao decide o que roda (ARCHITECTURE 4.1, DASHBOARD 2.1).
 */
export interface RunLauncher {
  start(runId: RunId): Promise<void>
}

export interface ServerDeps {
  /**
   * Unico caminho de escrita do estado (I7). O servidor traduz HTTP em caso de uso do
   * orquestrador — nunca abre transacao, nunca grava evento, nunca toca no banco.
   */
  readonly plane: ControlPlane
  readonly project: ProjectFile
  /** Conteudo bruto dos arquivos: compilar missao e funcao pura sobre texto. */
  readonly projectText: string
  readonly gatesText: string
  readonly repoRoot: string
  readonly missionsDir: string
  readonly webDist: string
  readonly heartbeatMs: number
  readonly launcher: RunLauncher
}

export interface ServerDepsInput {
  readonly plane: ControlPlane
  readonly project: ProjectFile
  readonly projectText: string
  readonly gatesText: string
  readonly repoRoot: string
  readonly missionsDir?: string
  readonly webDist?: string
  readonly heartbeatMs?: number
  readonly launcher?: RunLauncher
}

/** Abre o orquestrador do run e liga o loop. Nada mais: a descoberta e dele. */
export function defaultLauncher(plane: ControlPlane): RunLauncher {
  return {
    start: async (runId: RunId): Promise<void> => {
      const orchestrator = await plane.open(runId)
      orchestrator.start()
    },
  }
}

export function toServerDeps(input: ServerDepsInput): ServerDeps {
  const repoRoot = resolve(input.repoRoot)
  return {
    plane: input.plane,
    project: input.project,
    projectText: input.projectText,
    gatesText: input.gatesText,
    repoRoot,
    missionsDir: resolve(repoRoot, input.missionsDir ?? DEFAULT_MISSIONS_DIR),
    webDist: resolve(repoRoot, input.webDist ?? DEFAULT_WEB_DIST),
    heartbeatMs: input.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    launcher: input.launcher ?? defaultLauncher(input.plane),
  }
}
