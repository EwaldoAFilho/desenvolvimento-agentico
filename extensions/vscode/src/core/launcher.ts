import { spawn } from 'node:child_process'
import type { Toolchain } from './toolchain.js'

/**
 * Sobe `agentic serve -C <repoRoot>` como processo filho — o unico lugar da extensao que
 * cria processo. O control plane NAO roda dentro do extension host: ele e um processo com
 * posse propria (I14), e a extensao e um cliente com uma alavanca a mais (o handle do
 * filho que ELA criou).
 *
 * `detached`: o filho ganha o proprio grupo, entao um encerramento abrupto do editor nao o
 * mata pela metade — ele continua dono ate ser parado de forma graciosa (pela proxima
 * janela, por `Stop`, ou por SIGTERM no terminal). O encerramento normal do editor passa
 * pelo `deactivate`, que pede `stop` com prazo.
 */
export interface SpawnedProcess {
  readonly pid: number
  /** Resolve quando o processo sai; nunca rejeita. */
  readonly exited: Promise<ProcessExit>
  readonly done: boolean
  kill(signal: NodeJS.Signals): boolean
  /** Ultimas linhas de stdout/stderr, para diagnostico. */
  output(): string
}

export interface ProcessExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

export interface LaunchInput {
  readonly toolchain: Toolchain
  /** Onde esta `.agentic/project.yaml`: e o que `-C` recebe. */
  readonly projectDir: string
  /** Identidade do projeto: `cwd` do processo. Pode ser outro diretorio (`project.repoRoot: ../x`). */
  readonly repoRoot: string
  readonly env: Record<string, string | undefined>
  readonly onLine?: (line: string) => void
  /** Primeira linha do diagnostico: com qual node e qual CLI o processo nasceu. */
  readonly banner?: string
}

const OUTPUT_TAIL_LINES = 40

export function launchServe(input: LaunchInput): SpawnedProcess {
  const { file, args } = input.toolchain.command(['serve', '-C', input.projectDir])
  const child = spawn(file, args, {
    cwd: input.repoRoot,
    env: input.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  })
  const tail: string[] = input.banner === undefined ? [] : [input.banner]
  let done = false
  const feed = (chunk: unknown): void => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.length === 0) continue
      tail.push(line)
      if (tail.length > OUTPUT_TAIL_LINES) tail.shift()
      input.onLine?.(line)
    }
  }
  child.stdout?.on('data', feed)
  child.stderr?.on('data', feed)
  const exited = new Promise<ProcessExit>((resolve) => {
    child.once('error', (error) => {
      feed(`falha ao iniciar: ${error.message}`)
    })
    child.once('exit', (code, signal) => {
      done = true
      resolve({ code, signal })
    })
    child.once('error', () => {
      if (!done) {
        done = true
        resolve({ code: null, signal: null })
      }
    })
  })
  child.unref()
  return {
    pid: child.pid ?? -1,
    exited,
    get done(): boolean {
      return done
    },
    kill: (signal) => {
      try {
        return child.kill(signal)
      } catch {
        return false
      }
    },
    output: () => tail.join('\n'),
  }
}
