import { type ChildProcess, spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import nodeProcess from 'node:process'
import type { Readable } from 'node:stream'
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
export const RACER_SCRIPT = resolve(here, 'lock-racer.ts')

interface NodeChild {
  readonly child: ChildProcess
  readonly out: Readable
  readonly err: Readable
}

/** `stdio` pedido em pipe nos dois canais; se o SO nao entregar, o teste falha aqui e agora. */
function nodeChild(script: string, args: readonly string[]): NodeChild {
  const child = spawn(
    nodeProcess.execPath,
    [VITE_NODE, '--config', VITEST_CONFIG, script, ...args],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const { stdout, stderr } = child
  if (stdout === null || stderr === null) {
    child.kill('SIGKILL')
    throw new Error(`processo filho sem stdout/stderr: ${script}`)
  }
  return { child, out: stdout, err: stderr }
}

function ended(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((done) => child.once('exit', () => done()))
}

export interface SpawnedOwner {
  readonly label: string
  /** O que o processo reportou: virou dono, ou foi recusado com motivo. */
  readonly report: OwnerReport
  readonly pid: number
  /** Encerramento gracioso: o control plane fecha, retira o registro e solta a posse. */
  stop(signal?: 'SIGTERM' | 'SIGINT'): Promise<void>
  /** Queda ABRUPTA: nenhum handler roda, nada e liberado pelo processo. */
  kill(): Promise<void>
}

export interface SpawnOwnerOptions {
  readonly label: string
  /** Ausente = porta EFEMERA. Portas explicitas existem para provar que elas nao mandam. */
  readonly port?: number
}

/**
 * Sobe UM control plane em processo separado e espera ele reportar.
 *
 * A porta e efemera por padrao (§17): posse tem de valer por projeto, e uma porta ocupada
 * nao pode ser confundida com a garantia.
 */
export function spawnOwner(
  repoRoot: string,
  options: SpawnOwnerOptions = { label: 'A' },
): Promise<SpawnedOwner> {
  const { child, out, err } = nodeChild(OWNER_SCRIPT, [
    repoRoot,
    String(options.port ?? 0),
    options.label,
  ])

  let stdout = ''
  let stderr = ''
  err.on('data', (chunk: unknown) => {
    stderr += String(chunk)
  })

  return new Promise<SpawnedOwner>((done, fail) => {
    const finish = (report: OwnerReport): void => {
      clearTimeout(timer)
      done({
        label: options.label,
        report,
        pid: child.pid ?? -1,
        stop: async (signal = 'SIGTERM'): Promise<void> => {
          child.kill(signal)
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
    out.on('data', (chunk: unknown) => {
      stdout += String(chunk)
      const nl = stdout.indexOf('\n')
      if (nl === -1) return
      try {
        finish(JSON.parse(stdout.slice(0, nl)) as OwnerReport)
      } catch {
        /* linha ainda incompleta ou ruido: espera a proxima */
      }
    })
    child.once('exit', (code: number | null) => {
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

export interface RaceResult {
  readonly winners: readonly string[]
  readonly losers: readonly string[]
}

/**
 * `competidores` processos disputando a MESMA posse no MESMO instante.
 *
 * O instante combinado (`Date.now() + margem`) e o que faz disto uma corrida: sem ele, o
 * custo de partida do Node enfileiraria os processos e o teste mediria latencia, nao
 * exclusividade.
 */
export function raceForOwnership(
  baseDir: string,
  competidores: number,
  margemMs = 1_200,
): Promise<RaceResult> {
  const at = Date.now() + margemMs
  const corridas = Array.from({ length: competidores }, () => {
    const { child, out, err } = nodeChild(RACER_SCRIPT, [baseDir, String(at)])
    let stdout = ''
    let stderr = ''
    err.on('data', (chunk: unknown) => {
      stderr += String(chunk)
    })
    out.on('data', (chunk: unknown) => {
      stdout += String(chunk)
    })
    return new Promise<string>((done, fail) => {
      child.once('exit', (code: number | null) => {
        const linha = stdout.trim().split('\n').at(-1) ?? ''
        if (linha.startsWith('WIN') || linha.startsWith('LOSE')) return done(linha)
        fail(new Error(`competidor saiu com ${code} sem veredito. stderr:\n${stderr}`))
      })
    })
  })

  return Promise.all(corridas).then((linhas) => ({
    winners: linhas.filter((linha) => linha.startsWith('WIN')),
    losers: linhas.filter((linha) => linha.startsWith('LOSE')),
  }))
}

export const CLI_SCRIPT = resolve(here, 'cli-process.ts')
const CLI_RESULT_MARKER = '##CLI-RESULT##'

export interface CliOutcome {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  /** Envelope do `--json`, quando o comando foi chamado com ele. */
  json(): {
    readonly ok: boolean
    readonly data?: unknown
    readonly error?: { readonly code: string; readonly message: string }
  }
}

function parseCliResult(buffer: string): CliOutcome | undefined {
  const marker = buffer.lastIndexOf(CLI_RESULT_MARKER)
  if (marker === -1) return undefined
  const line = buffer.slice(marker + CLI_RESULT_MARKER.length).trim()
  if (line.length === 0) return undefined
  let parsed: { readonly code: number; readonly stdout: string; readonly stderr: string }
  try {
    parsed = JSON.parse(line) as typeof parsed
  } catch {
    return undefined
  }
  return {
    ...parsed,
    json: () => {
      const start = parsed.stdout.indexOf('{')
      if (start === -1) throw new Error(`saida sem JSON:\n${parsed.stdout}`)
      return JSON.parse(parsed.stdout.slice(start)) as never
    },
  }
}

/** Roda um comando da CLI ate o fim, num processo separado. */
export function runCli(
  cwd: string,
  argv: readonly string[],
  timeoutMs = 90_000,
): Promise<CliOutcome> {
  const { child, out, err } = nodeChild(CLI_SCRIPT, [cwd, JSON.stringify(argv)])
  let stdout = ''
  let stderr = ''
  out.on('data', (chunk: unknown) => {
    stdout += String(chunk)
  })
  err.on('data', (chunk: unknown) => {
    stderr += String(chunk)
  })
  return new Promise<CliOutcome>((done, fail) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      fail(
        new Error(
          `\`agentic ${argv.join(' ')}\` nao terminou em ${timeoutMs}ms:\n${stdout}\n${stderr}`,
        ),
      )
    }, timeoutMs)
    child.once('exit', (code: number | null) => {
      clearTimeout(timer)
      const outcome = parseCliResult(stdout)
      if (outcome === undefined) {
        fail(
          new Error(
            `\`agentic ${argv.join(' ')}\` saiu com ${code} sem reportar.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        )
        return
      }
      done(outcome)
    })
  })
}

export interface LiveCli {
  /** Linha de prontidao que o teste esperava (ex.: o endereco publicado). */
  readonly ready: string
  readonly pid: number
  stop(signal?: 'SIGTERM' | 'SIGINT'): Promise<void>
  kill(): Promise<void>
  /** Tudo que o comando imprimiu ate agora. */
  output(): string
}

/**
 * Sobe um comando de PRIMEIRO PLANO (`serve`, `mission start --serve`) e devolve o controle
 * assim que ele imprime a linha de prontidao. O processo continua vivo ate `stop`/`kill`.
 */
export function spawnCli(
  cwd: string,
  argv: readonly string[],
  ready: RegExp,
  timeoutMs = 90_000,
): Promise<LiveCli> {
  const { child, out, err } = nodeChild(CLI_SCRIPT, [cwd, JSON.stringify(argv)])
  let stdout = ''
  let stderr = ''
  err.on('data', (chunk: unknown) => {
    stderr += String(chunk)
  })
  return new Promise<LiveCli>((done, fail) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      fail(
        new Error(
          `\`agentic ${argv.join(' ')}\` nao ficou pronto em ${timeoutMs}ms.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      )
    }, timeoutMs)
    out.on('data', (chunk: unknown) => {
      stdout += String(chunk)
      const match = ready.exec(stdout)
      if (match === null) return
      clearTimeout(timer)
      done({
        ready: match[0],
        pid: child.pid ?? -1,
        output: () => stdout,
        stop: async (signal = 'SIGTERM'): Promise<void> => {
          child.kill(signal)
          await ended(child)
        },
        kill: async (): Promise<void> => {
          child.kill('SIGKILL')
          await ended(child)
        },
      })
    })
    child.once('exit', (code: number | null) => {
      clearTimeout(timer)
      fail(
        new Error(
          `\`agentic ${argv.join(' ')}\` saiu com ${code} sem ficar pronto.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      )
    })
  })
}

export const ENTRYPOINT_RACER_SCRIPT = resolve(here, 'entrypoint-racer.ts')

/** Por qual entrypoint de producao o competidor deriva a chave de posse. */
export type RaceEntrypoint = 'cli' | 'server'

export interface EntrypointRaceResult extends RaceResult {
  /** Diretorio que cada competidor disputou. Mais de um valor aqui JA e a falha. */
  readonly dirs: readonly string[]
}

/**
 * A mesma corrida do `raceForOwnership`, mas com os competidores chegando por entrypoints
 * DIFERENTES sobre o mesmo projeto.
 *
 * `entrypoints` e ciclico: com `['cli', 'server']` e oito competidores, quatro derivam a
 * chave pelo caminho da CLI e quatro pelo caminho do servidor.
 */
export function raceEntrypointsForOwnership(
  projectDir: string,
  competidores: number,
  entrypoints: readonly RaceEntrypoint[],
  margemMs = 2_500,
): Promise<EntrypointRaceResult> {
  const at = Date.now() + margemMs
  const filhos: ChildProcess[] = []
  const corridas = Array.from({ length: competidores }, (_, index) => {
    const entrypoint = entrypoints[index % entrypoints.length] ?? 'cli'
    const { child, out, err } = nodeChild(ENTRYPOINT_RACER_SCRIPT, [
      projectDir,
      entrypoint,
      String(at),
    ])
    filhos.push(child)
    let stdout = ''
    let stderr = ''
    err.on('data', (chunk: unknown) => {
      stderr += String(chunk)
    })
    return new Promise<string>((done, fail) => {
      const veredito = (): string | undefined => {
        const linha = stdout.trim().split('\n').at(-1) ?? ''
        return linha.startsWith('WIN') || linha.startsWith('LOSE') ? linha : undefined
      }
      // O veredito vem do STDOUT, nao da saida do processo: o vencedor fica vivo segurando
      // a posse ate o fim da rodada, e e o pai quem decide quando ela acabou. Esperar pela
      // saida faria o vencedor ter de soltar a posse para reportar — e ai um competidor
      // lento ganharia legitimamente depois, com a rodada acusando dois vencedores que
      // nunca coexistiram.
      out.on('data', (chunk: unknown) => {
        stdout += String(chunk)
        const linha = veredito()
        if (linha !== undefined) done(linha)
      })
      child.once('exit', (code: number | null) => {
        const linha = veredito()
        if (linha !== undefined) return done(linha)
        fail(
          new Error(
            `competidor (${entrypoint}) saiu com ${code} sem veredito.\nstderr:\n${stderr}`,
          ),
        )
      })
    })
  })

  return Promise.all(corridas)
    .then((linhas) => ({
      winners: linhas.filter((linha) => linha.startsWith('WIN')),
      losers: linhas.filter((linha) => linha.startsWith('LOSE')),
      dirs: [...new Set(linhas.map((linha) => linha.split(' ')[1] ?? '<sem diretorio>'))],
    }))
    .finally(async () => {
      // Fim da rodada: o vencedor solta a posse ao receber o sinal, e a rodada seguinte
      // comeca com o projeto livre de verdade.
      for (const filho of filhos) filho.kill('SIGTERM')
      for (const filho of filhos) await ended(filho)
    })
}
