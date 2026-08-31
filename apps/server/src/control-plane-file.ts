import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import nodeProcess from 'node:process'

/**
 * Descoberta do control plane no ar — o minimo que resolve o problema real.
 *
 * O endereco declarado em `project.yaml` e uma INTENCAO; o que existe agora e um processo.
 * Quem publica HTTP grava aqui host, porta e pid; quem procura le, confirma que o processo
 * existe e so entao confia. Nao ha daemon, registry nem descoberta em rede: e um arquivo
 * local, escrito ao subir e removido ao encerrar.
 *
 * O arquivo NAO e fonte de verdade de estado: continua valendo I7 (o orquestrador e o unico
 * escritor do run). Ele responde uma pergunta de interface — "com quem eu falo?".
 */
export const CONTROL_PLANE_FILE = 'control-plane.json'

/** Diretorio local do projeto; o mesmo que guarda `state.db` e `runs/`. */
export const RUNTIME_DIR_NAME = '.agentic'

export interface ControlPlaneRuntime {
  readonly host: string
  readonly port: number
  readonly pid: number
  readonly url: string
  readonly startedAt: string
}

export function runtimeDirOf(repoRoot: string): string {
  return resolve(repoRoot, RUNTIME_DIR_NAME)
}

export function controlPlaneFilePath(runtimeDir: string): string {
  return join(resolve(runtimeDir), CONTROL_PLANE_FILE)
}

/** `undefined` = nao da para afirmar nada; o chamador trata como "nao ha control plane". */
export type AliveProbe = (pid: number) => boolean

/**
 * Sinal 0 nao entrega nada ao processo: so pergunta se ele existe. `EPERM` significa que
 * existe e nao e nosso — vivo, portanto. `ESRCH` significa que morreu.
 */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    nodeProcess.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function isPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= 65_535
}

/** Registro malformado nao vira excecao: vale o mesmo que registro ausente. */
export function parseControlPlaneRuntime(raw: unknown): ControlPlaneRuntime | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const { host, port, pid, url, startedAt } = record
  if (typeof host !== 'string' || host.length === 0) return undefined
  if (!isPort(port)) return undefined
  if (!Number.isInteger(pid) || (pid as number) <= 0) return undefined
  return {
    host,
    port,
    pid: pid as number,
    url: typeof url === 'string' && url.length > 0 ? url : `http://${host}:${port}`,
    startedAt: typeof startedAt === 'string' ? startedAt : '',
  }
}

export interface WriteRuntimeInput {
  readonly host: string
  readonly port: number
  readonly pid?: number
  readonly startedAt?: Date
}

/** Grava o registro do processo que ACABOU de publicar HTTP. Devolve o que ficou no disco. */
export async function writeControlPlaneFile(
  runtimeDir: string,
  input: WriteRuntimeInput,
): Promise<ControlPlaneRuntime> {
  const runtime: ControlPlaneRuntime = {
    host: input.host,
    port: input.port,
    pid: input.pid ?? nodeProcess.pid,
    url: `http://${input.host}:${input.port}`,
    startedAt: (input.startedAt ?? new Date()).toISOString(),
  }
  const path = controlPlaneFilePath(runtimeDir)
  await mkdir(resolve(runtimeDir), { recursive: true })
  await writeFile(path, `${JSON.stringify(runtime, null, 2)}\n`, 'utf8')
  return runtime
}

export async function readControlPlaneFile(
  runtimeDir: string,
): Promise<ControlPlaneRuntime | undefined> {
  let text: string
  try {
    text = await readFile(controlPlaneFilePath(runtimeDir), 'utf8')
  } catch {
    return undefined
  }
  try {
    return parseControlPlaneRuntime(JSON.parse(text))
  } catch {
    return undefined
  }
}

export interface RemoveExpectation {
  readonly pid?: number
  readonly port?: number
}

/**
 * Remove o registro. Com `expected`, so remove se o arquivo ainda for O NOSSO: um processo
 * encerrando nao pode apagar o registro de outro que subiu depois.
 */
export async function removeControlPlaneFile(
  runtimeDir: string,
  expected?: RemoveExpectation,
): Promise<boolean> {
  if (expected !== undefined) {
    const current = await readControlPlaneFile(runtimeDir)
    if (current === undefined) return false
    if (expected.pid !== undefined && current.pid !== expected.pid) return false
    if (expected.port !== undefined && current.port !== expected.port) return false
  }
  try {
    await rm(controlPlaneFilePath(runtimeDir), { force: true })
    return true
  } catch {
    return false
  }
}

export interface DiscoverOptions {
  /** Sonda de processo vivo; injetavel para o teste nao depender de pid do sistema. */
  readonly alive?: AliveProbe
}

/**
 * Onde esta o control plane, se e que ha um. Registro apontando para processo morto NAO e
 * control plane: e lixo de um encerramento abrupto — some do disco e a resposta e "nao ha".
 */
export async function discoverControlPlane(
  runtimeDir: string,
  options: DiscoverOptions = {},
): Promise<ControlPlaneRuntime | undefined> {
  const runtime = await readControlPlaneFile(runtimeDir)
  if (runtime === undefined) return undefined
  const alive = options.alive ?? processAlive
  if (alive(runtime.pid)) return runtime
  await removeControlPlaneFile(runtimeDir)
  return undefined
}
