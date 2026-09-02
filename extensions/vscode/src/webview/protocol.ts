import type { ProviderHealthDto, RunHeaderDto, RunSnapshot, TaskDetail } from '../core/contracts.js'
import type { MissionSummary } from '../core/missions.js'
import type { ServiceView } from '../core/service.js'

/**
 * Protocolo Webview <-> Extension Host. A webview nunca fala com o control plane: ela pede
 * ao host, e o host fala com o cliente HTTP. Isso mantem a webview sem rede (CSP sem
 * `connect-src`) e deixa o transporte pronto para Remote SSH / WSL / Dev Containers, onde
 * `localhost` da webview nao e o `localhost` do control plane.
 */
export interface HomeProject {
  readonly name: string
  readonly repoRoot: string
  readonly projectFile: string
  readonly branch?: string
  readonly gitRepository: boolean
}

export interface MissionDetail {
  readonly summary: MissionSummary
  readonly runs: RunHeaderDto[]
  readonly snapshot?: RunSnapshot
  readonly tasks?: TaskDetail[]
  readonly error?: string
}

export interface HomeState {
  readonly project?: HomeProject
  readonly service: ServiceView
  readonly providers?: ProviderHealthDto[]
  readonly missions: MissionSummary[]
  readonly runs?: RunHeaderDto[]
  readonly selected?: MissionDetail
  readonly busy?: string
  readonly error?: string
  readonly updatedAt: string
}

export type WebviewToHost =
  | { readonly type: 'ready' }
  | { readonly type: 'refresh' }
  | { readonly type: 'start' }
  | { readonly type: 'stop' }
  | { readonly type: 'restart' }
  | { readonly type: 'showLog' }
  | { readonly type: 'selectMission'; readonly file: string }
  | { readonly type: 'openFile'; readonly path: string }
  | { readonly type: 'openMissionFile'; readonly file: string }
  | {
      readonly type: 'openDiff'
      readonly path: string
      readonly base: string
      readonly head: string
    }
  | { readonly type: 'openWorktree'; readonly path: string }

export type HostToWebview = { readonly type: 'state'; readonly state: HomeState }

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Valida a mensagem INTEIRA: tipo conhecido e cada campo do payload com o formato esperado. */
export function isWebviewToHost(raw: unknown): raw is WebviewToHost {
  if (typeof raw !== 'object' || raw === null) return false
  const message = raw as Record<string, unknown>
  switch (message.type) {
    case 'ready':
    case 'refresh':
    case 'start':
    case 'stop':
    case 'restart':
    case 'showLog':
      return true
    case 'selectMission':
    case 'openMissionFile':
      return nonEmpty(message.file)
    case 'openFile':
    case 'openWorktree':
      return nonEmpty(message.path)
    case 'openDiff':
      return nonEmpty(message.path) && nonEmpty(message.base) && nonEmpty(message.head)
    default:
      return false
  }
}
