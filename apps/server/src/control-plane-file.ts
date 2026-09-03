import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
 *
 * E tambem NAO e a posse do projeto. Quem decide quem pode agir e o lock em
 * `control-plane.lock.db` (I14); este arquivo so PUBLICA o endereco de quem ja ganhou. A
 * distincao importa em cada linha abaixo: registro ausente, velho ou meio escrito nunca cria
 * um segundo dono — ele apenas deixa a descoberta muda ate o dono republicar.
 *
 * O `instanceId` e o que liga os dois: e o mesmo do lease de posse. Sem ele, um processo em
 * encerramento apagaria o registro de uma instancia NOVA que subiu no lugar dele.
 */
export const CONTROL_PLANE_FILE = 'control-plane.json'

export interface ControlPlaneRuntime {
  readonly host: string
  readonly port: number
  /** Diagnostico para o humano, NUNCA autoridade: PID e reaproveitado pelo sistema. */
  readonly pid: number
  readonly url: string
  readonly startedAt: string
  /** Identidade do dono. Ausente em registro escrito por uma versao anterior. */
  readonly instanceId?: string
  /** Projeto que este control plane possui, canonico. Ausente em registro antigo. */
  readonly repoRoot?: string
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
  const instanceId = record.instanceId
  const repoRoot = record.repoRoot
  return {
    host,
    port,
    pid: pid as number,
    url: typeof url === 'string' && url.length > 0 ? url : `http://${host}:${port}`,
    startedAt: typeof startedAt === 'string' ? startedAt : '',
    ...(typeof instanceId === 'string' && instanceId.length > 0 ? { instanceId } : {}),
    ...(typeof repoRoot === 'string' && repoRoot.length > 0 ? { repoRoot } : {}),
  }
}

export interface WriteRuntimeInput {
  readonly host: string
  readonly port: number
  readonly pid?: number
  readonly startedAt?: Date
  readonly instanceId?: string
  readonly repoRoot?: string
}

/**
 * Grava o registro do processo que ACABOU de publicar HTTP. Devolve o que ficou no disco.
 *
 * A escrita e ATOMICA: arquivo temporario e `rename`. Quem le nunca ve JSON pela metade —
 * e vai haver quem leia sem coordenacao nenhuma, comecando pela extensao do editor. O
 * temporario leva o pid no nome para que dois processos escrevendo ao mesmo tempo nao
 * disputem o mesmo intermediario.
 */
export async function writeControlPlaneFile(
  runtimeDir: string,
  input: WriteRuntimeInput,
): Promise<ControlPlaneRuntime> {
  const pid = input.pid ?? nodeProcess.pid
  const runtime: ControlPlaneRuntime = {
    host: input.host,
    port: input.port,
    pid,
    url: `http://${input.host}:${input.port}`,
    startedAt: (input.startedAt ?? new Date()).toISOString(),
    ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
    ...(input.repoRoot === undefined ? {} : { repoRoot: input.repoRoot }),
  }
  const dir = resolve(runtimeDir)
  const path = controlPlaneFilePath(dir)
  const temporario = `${path}.${pid}.tmp`
  await mkdir(dir, { recursive: true })
  await writeFile(temporario, `${JSON.stringify(runtime, null, 2)}\n`, 'utf8')
  try {
    await rename(temporario, path)
  } catch (error) {
    await rm(temporario, { force: true }).catch(() => undefined)
    throw error
  }
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
  /** A prova forte de que o registro e nosso; pid e porta podem ser reaproveitados. */
  readonly instanceId?: string
}

/**
 * Remove o registro. Com `expected`, so remove se o arquivo ainda for O NOSSO: um processo
 * encerrando nao pode apagar o registro de outro que subiu depois.
 *
 * Quando `expected.instanceId` e informado, ele DECIDE sozinho: identidade confere, remove;
 * nao confere, nao remove — e o registro nem precisa carregar `instanceId` para ser
 * protegido, porque registro sem identidade nao pode ser provado nosso.
 */
export async function removeControlPlaneFile(
  runtimeDir: string,
  expected?: RemoveExpectation,
): Promise<boolean> {
  if (expected !== undefined) {
    const current = await readControlPlaneFile(runtimeDir)
    if (current === undefined) return false
    if (expected.instanceId !== undefined) {
      if (current.instanceId !== expected.instanceId) return false
    } else {
      if (expected.pid !== undefined && current.pid !== expected.pid) return false
      if (expected.port !== undefined && current.port !== expected.port) return false
    }
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
 * control plane: e lixo de um encerramento abrupto, e a resposta e "nao ha".
 *
 * Descobrir NAO apaga nada, e isso e deliberado.
 *
 * Apagar aqui parecia limpeza e era uma corrida: entre ler um registro morto e remove-lo, um
 * control plane novo pode ter publicado o dele, e nao existe "compare-and-delete" atomico em
 * sistema de arquivos para impedir que o registro do vivo fosse o apagado. Quem chama isto e
 * CLIENTE — nao tem a posse do projeto e portanto nao tem como provar que ninguem publicou
 * naquele instante.
 *
 * O registro velho tambem nao precisa sumir: ele ja e ignorado aqui, e o proximo dono o
 * sobrescreve ao publicar. Escrita em `control-plane.json` fica sendo do DONO, so.
 */
export async function discoverControlPlane(
  runtimeDir: string,
  options: DiscoverOptions = {},
): Promise<ControlPlaneRuntime | undefined> {
  const runtime = await readControlPlaneFile(runtimeDir)
  if (runtime === undefined) return undefined
  const alive = options.alive ?? processAlive
  return alive(runtime.pid) ? runtime : undefined
}
