import { join } from 'node:path'
import { CONTROL_PLANE_FILE_NAME, CONTROL_PLANE_SERVICE } from './contracts.js'

/**
 * "Com quem eu falo?" — a mesma pergunta que a CLI faz, com as mesmas duas provas.
 *
 * 1. `control-plane.json` diz onde um processo esta AGORA, e com qual pid. Registro de
 *    processo morto nao e control plane; registro de OUTRO `repoRoot` tambem nao.
 * 2. `/api/health` confirma quem atende e por qual projeto responde. Sem as duas provas a
 *    resposta e "nao ha control plane" — nunca "pode escrever".
 *
 * A extensao nunca apaga o registro (ela e cliente, nao tem a posse), e nunca trata o pid
 * como autoridade: ele serve para a sonda de vivacidade e para o sinal de encerramento, e a
 * prova de que algo encerrou e o silencio do `/api/health`, nao o retorno do `kill`.
 */
export interface LiveControlPlane {
  readonly url: string
  /** Ausente quando o dono nao publicou registro (so respondeu no endereco declarado). */
  readonly pid?: number
  readonly instanceId?: string
  readonly startedAt?: string
  readonly repoRoot: string
  readonly source: 'runtime-file' | 'declared-endpoint'
}

export interface HealthLike {
  readonly service?: unknown
  readonly repoRoot?: unknown
}

export interface DiscoveryDeps {
  readFile(path: string): Promise<string | undefined>
  alive(pid: number): boolean
  /** `undefined` = ninguem respondeu (ou nao em tempo). */
  fetchHealth(url: string): Promise<HealthLike | undefined>
  canonical(path: string): string
}

export interface DiscoveryInput {
  readonly runtimeDir: string
  readonly repoRoot: string
  readonly declaredUrl: string
}

interface RuntimeRecord {
  readonly url: string
  readonly pid: number
  readonly instanceId?: string
  readonly startedAt?: string
  readonly repoRoot?: string
}

export function parseRuntimeRecord(text: string): RuntimeRecord | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const { host, port, pid, url, instanceId, startedAt, repoRoot } = record
  if (typeof host !== 'string' || host.length === 0) return undefined
  if (!Number.isInteger(port) || (port as number) <= 0 || (port as number) > 65_535)
    return undefined
  if (!Number.isInteger(pid) || (pid as number) <= 0) return undefined
  return {
    url: typeof url === 'string' && url.length > 0 ? url : `http://${host}:${port}`,
    pid: pid as number,
    ...(typeof instanceId === 'string' && instanceId.length > 0 ? { instanceId } : {}),
    ...(typeof startedAt === 'string' ? { startedAt } : {}),
    ...(typeof repoRoot === 'string' && repoRoot.length > 0 ? { repoRoot } : {}),
  }
}

async function answersFor(
  url: string,
  repoRoot: string,
  deps: DiscoveryDeps,
): Promise<string | undefined> {
  const body = await deps.fetchHealth(url)
  if (body === undefined) return undefined
  if (body.service !== CONTROL_PLANE_SERVICE) return undefined
  if (typeof body.repoRoot !== 'string' || body.repoRoot.length === 0) return undefined
  const answered = deps.canonical(body.repoRoot)
  return answered === deps.canonical(repoRoot) ? answered : undefined
}

export async function discoverLive(
  input: DiscoveryInput,
  deps: DiscoveryDeps,
): Promise<LiveControlPlane | undefined> {
  const text = await deps.readFile(join(input.runtimeDir, CONTROL_PLANE_FILE_NAME))
  const record = text === undefined ? undefined : parseRuntimeRecord(text)
  if (record !== undefined) {
    const sameProject =
      record.repoRoot === undefined ||
      deps.canonical(record.repoRoot) === deps.canonical(input.repoRoot)
    if (sameProject && deps.alive(record.pid)) {
      const repoRoot = await answersFor(record.url, input.repoRoot, deps)
      if (repoRoot !== undefined) {
        return {
          url: record.url,
          pid: record.pid,
          repoRoot,
          source: 'runtime-file',
          ...(record.instanceId === undefined ? {} : { instanceId: record.instanceId }),
          ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
        }
      }
    }
  }
  // Sem registro (ou registro morto): o endereco declarado ainda pode responder — um dono
  // que subiu numa versao sem registro, por exemplo. Ele existe, mas nao ha pid para parar.
  const repoRoot = await answersFor(input.declaredUrl, input.repoRoot, deps)
  if (repoRoot === undefined) return undefined
  return { url: input.declaredUrl, repoRoot, source: 'declared-endpoint' }
}
