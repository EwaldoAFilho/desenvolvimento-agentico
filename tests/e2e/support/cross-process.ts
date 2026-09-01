import { type ChildProcess, spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import nodeProcess from 'node:process'
import { fileURLToPath } from 'node:url'
import type { OwnerReport } from './owner-process.js'

/**
 * Processos de verdade a partir do FONTE.
 *
 * `vite-node` resolve os alias de `@agentic/*` do mesmo jeito que a suite: o filho executa o
 * codigo de producao, nao uma copia. `process.execPath` garante que o filho nasce no mesmo
 * Node que roda o teste — a extensao nativa do SQLite nao atravessa versao de Node.
 */
const here = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(here, '../../..')
const VITE_NODE = resolve(REPO_ROOT, 'node_modules/.bin/vite-node')
const VITEST_CONFIG = resolve(REPO_ROOT, 'vitest.config.ts')
export const OWNER_SCRIPT = resolve(here, 'owner-process.ts')

export interface SpawnedOwner {
  readonly label: string
  /** O que o processo reportou: virou dono, ou foi recusado com motivo. */
  readonly report: OwnerReport
  readonly pid: number
  /** Encerramento gracioso: o control plane fecha e retira o proprio registro. */
  stop(): Promise<void>
  /** Queda ABRUPTA: nenhum `close`, nenhum cleanup — o caso do §9-C. */
  kill(): Promise<void>
}

function ended(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((done) => child.once('exit', () => done()))
}

/**
 * Sobe UM control plane em processo separado e espera ele reportar.
 *
 * `port = 0` de proposito (§17): ownership tem de valer por `repoRoot`, e uma porta ocupada
 * nao pode ser confundida com a garantia. Quem quiser provar o contrario passa portas
 * explicitas e DIFERENTES.
 */
export function spawnOwner(
  repoRoot: string,
  options: { readonly label: string; readonly port?: number } = { label: 'A' },
): Promise<SpawnedOwner> {
  const child = spawn(
    nodeProcess.execPath,
    [
      VITE_NODE,
      '--config',
      VITEST_CONFIG,
      OWNER_SCRIPT,
      repoRoot,
      String(options.port ?? 0),
      options.label,
    ],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  )

  let stdout = ''
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })

  return new Promise<SpawnedOwner>((done, fail) => {
    const finish = (report: OwnerReport): void => {
      clearTimeout(timer)
      done({
        label: options.label,
        report,
        pid: child.pid ?? -1,
        stop: async (): Promise<void> => {
          child.kill('SIGTERM')
          await ended(child)
        },
        kill: async (): Promise<void> => {
          child.kill('SIGKILL')
          await ended(child)
        },
      })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      fail(new Error(`processo ${options.label} nao reportou em 90s. stderr:\n${stderr}`))
    }, 90_000)
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      const nl = stdout.indexOf('\n')
      if (nl === -1) return
      try {
        finish(JSON.parse(stdout.slice(0, nl)) as OwnerReport)
      } catch {
        /* linha ainda incompleta ou ruido: espera a proxima */
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      fail(new Error(`processo ${options.label} saiu com ${code} SEM reportar. stderr:\n${stderr}`))
    })
  })
}

/** Quem, entre os processos, ficou responsavel pelo run — a pergunta inteira de D4. */
export function adopters(owners: readonly SpawnedOwner[], runId: string): string[] {
  return owners
    .filter((owner) => (owner.report.adopted ?? []).some((entry) => entry.runId === runId))
    .map((owner) => owner.label)
}
