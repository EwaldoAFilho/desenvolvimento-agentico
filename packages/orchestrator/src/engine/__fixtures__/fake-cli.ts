import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import { createLocalAgentRuntime } from '@agentic/agent-runtime'
import type { RuntimeDeps } from '@agentic/process'
import type { LocalCliDescriptor, ProviderFactory } from '@agentic/providers'
import { LocalCliAgentProvider } from '@agentic/providers'

/**
 * O que o executavel falso faz nesta tentativa. Nenhuma CLI de agente e nenhuma quota:
 * um script node em diretorio temporario, com processo, sinais e exit code de verdade.
 */
export interface FakeStep {
  /** `ok` escreve e sai 0; `exit` sai com `exitCode`; `kill` se mata; `hang` nunca termina. */
  readonly kind: 'ok' | 'exit' | 'kill' | 'hang' | 'noisy'
  readonly exitCode?: number
  /** Escreve o arquivo da task na worktree. Default: true em `ok` e `noisy`. */
  readonly write?: boolean
  /** Caminho relativo escrito na worktree. Default: `packages/<task>/<Task>.ts`. */
  readonly writePath?: string
  /** Silencio total em stdout/stderr: expoe o que sobra para o relato do agente. */
  readonly silent?: boolean
  readonly stdoutBytes?: number
  readonly stderrBytes?: number
  /** Arquivo que um NETO escreve depois do atraso; prova se a arvore morreu ou nao. */
  readonly grandchildTarget?: string
  readonly grandchildDelayMs?: number
  /** Arquivo criado assim que o processo comeca; prova que ele chegou a rodar. */
  readonly aliveMarker?: string
  /** Arquivo com o pid do processo: deixa o teste perguntar ao SO se ele ainda vive. */
  readonly pidFile?: string
  /** Espera antes de agir, em ms. */
  readonly delayMs?: number
}

/** Roteiro por diretorio de worktree (`T01-a1`), por task (`T01`) ou `default`. */
export type FakeCliScript = Readonly<Record<string, FakeStep>>

export interface FakeCli {
  readonly factory: ProviderFactory
  readonly scriptPath: string
  cleanup(): Promise<void>
}

export interface FakeCliOptions {
  /**
   * Primitivo de processo do runtime que executa o script: e por aqui que a suite injeta a
   * sonda do grupo de processos (`probeGroup`) e os tetos — um grupo que sobrevive a SIGKILL
   * nao se fabrica de forma portavel.
   */
  readonly processDeps?: RuntimeDeps
}

/** O roteiro e embutido no proprio arquivo: nada depende de variavel de ambiente (P17). */
function runnerSource(script: FakeCliScript): string {
  return `
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const SCRIPT = ${JSON.stringify(script)}
const dir = basename(process.cwd())
const taskId = dir.split('-a')[0]
const step = SCRIPT[dir] ?? SCRIPT[taskId] ?? SCRIPT.default ?? { kind: 'ok' }

const bulk = (bytes) => 'x'.repeat(Math.max(0, bytes))

function writeChange() {
  const relative = step.writePath ?? join('packages', taskId.toLowerCase(), taskId + '.ts')
  const target = join(process.cwd(), relative)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, 'export const ' + taskId + ' = ' + JSON.stringify(dir) + '\\n', 'utf8')
}

function noise() {
  if ((step.stdoutBytes ?? 0) > 0) process.stdout.write(bulk(step.stdoutBytes))
  if ((step.stderrBytes ?? 0) > 0) process.stderr.write(bulk(step.stderrBytes))
}

function act() {
  if (step.aliveMarker) writeFileSync(step.aliveMarker, dir, 'utf8')
  if (step.pidFile) writeFileSync(step.pidFile, String(process.pid), 'utf8')
  if (step.write ?? (step.kind === 'ok' || step.kind === 'noisy')) writeChange()
  noise()

  if (step.kind === 'ok' || step.kind === 'noisy') {
    if (!step.silent) process.stdout.write(taskId + ': alteracao aplicada\\n')
    process.exit(0)
  }
  if (step.kind === 'exit') {
    if (!step.silent) process.stderr.write(taskId + ': recusei a tarefa\\n')
    process.exit(step.exitCode ?? 1)
  }
  if (step.kind === 'kill') {
    if (!step.silent) process.stdout.write(taskId + ': vou morrer agora\\n')
    process.kill(process.pid, 'SIGKILL')
    return
  }
  // hang: opcionalmente deixa um neto no mesmo grupo de processos e nunca termina.
  if (step.grandchildTarget) {
    const neto =
      'setTimeout(() => { require("node:fs").writeFileSync(' +
      JSON.stringify(step.grandchildTarget) +
      ', "neto") }, ' +
      String(step.grandchildDelayMs ?? 1500) +
      ')'
    spawn(process.execPath, ['-e', neto], { stdio: 'ignore' })
  }
  process.stdout.write(taskId + ': trabalhando\\n')
  setInterval(() => {}, 1000)
}

if (step.delayMs) setTimeout(act, step.delayMs)
else act()
`
}

const CAPABILITIES = {
  roles: ['executor', 'reviewer'] as const,
  streaming: true,
  cancellation: true,
  // Sonda de prontidao inexistente: o despacho nao gasta um processo extra por tentativa.
  readinessProbe: 'unsupported' as const,
  reportsUsage: false,
}

/**
 * Provider real (`LocalCliAgentProvider`) sobre um executavel falso: exercita spawn,
 * timeout, tree-kill, exit code e devolucao de vaga sem tocar em CLI de agente.
 */
export async function createFakeCli(
  script: FakeCliScript,
  options: FakeCliOptions = {},
): Promise<FakeCli> {
  const dir = await mkdtemp(join(tmpdir(), 'agentic-fakecli-'))
  const scriptPath = join(dir, 'runner.mjs')
  await writeFile(scriptPath, runnerSource(script), 'utf8')

  const descriptor: LocalCliDescriptor = {
    id: 'fake',
    command: nodeProcess.execPath,
    capabilities: CAPABILITIES,
    versionArgs: ['--version'],
    runArgs: [scriptPath],
  }
  const processDeps = options.processDeps

  return {
    scriptPath,
    factory: (input) =>
      new LocalCliAgentProvider(descriptor, {
        id: input.id,
        capacity: input.capacity,
        roles: input.config.roles,
        ...(processDeps === undefined
          ? {}
          : { runtime: createLocalAgentRuntime({ processDeps }) }),
      }),
    cleanup: (): Promise<void> => rm(dir, { recursive: true, force: true }),
  }
}
