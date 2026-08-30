import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import type { AttemptId, Gate, GateCommand, RunId } from '@agentic/domain'
import { attemptId, gateId, runId } from '@agentic/domain'

export const RUN_ID: RunId = runId(`01J${'0'.repeat(23)}`)
export const ATTEMPT_ID: AttemptId = attemptId('T07:1')

export const ENV_ALLOW: readonly string[] = ['PATH', 'HOME']

export function makeGate(
  commands: readonly GateCommand[],
  env: readonly string[] = ENV_ALLOW,
): Gate {
  return { id: gateId('unit'), commands, env }
}

const created: string[] = []

/** Workspace de tentativa de mentira. `realpath` porque /tmp e symlink em alguns sistemas. */
export function makeWorkspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agentic-gate-')))
  created.push(dir)
  return dir
}

export function cleanupWorkspaces(): void {
  for (const dir of created.splice(0, created.length)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function envSource(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: nodeProcess.env.PATH ?? '',
    HOME: nodeProcess.env.HOME ?? tmpdir(),
    ...extra,
  }
}

/** `node -e "<js>"`: processo real, sem depender de nenhuma ferramenta do projeto. */
export function nodeCommand(js: string): string {
  return `node -e "${js}"`
}

export function appendMarker(file: string, text: string): string {
  return nodeCommand(`require('node:fs').appendFileSync('${file}', '${text}')`)
}

export function writeMarker(file: string, text: string): string {
  return nodeCommand(`require('node:fs').writeFileSync('${file}', '${text}')`)
}
