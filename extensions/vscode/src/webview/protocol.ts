import type {
  CompileReportDto,
  ProviderHealthDto,
  RunHeaderDto,
  RunSnapshot,
  TaskDetail,
} from '../core/contracts.js'
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
  readonly report?: CompileReportDto
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

/** Ref de git que NUNCA vira opcao: sem `-` inicial, sem espaco, sem `..`/`:`; nomes e hashes so. */
export const GIT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

export function isGitRef(value: unknown): value is string {
  return (
    nonEmpty(value) && GIT_REF_PATTERN.test(value) && !value.includes('..') && !value.endsWith('/')
  )
}

/** Caminho de arquivo que nunca vira opcao do git nem sai por `..`. */
export function isRepoPath(value: unknown): value is string {
  return nonEmpty(value) && !value.startsWith('-') && !value.split(/[\\/]/).includes('..')
}

const SHAPES: Record<WebviewToHost['type'], readonly string[]> = {
  ready: [],
  refresh: [],
  start: [],
  stop: [],
  restart: [],
  showLog: [],
  selectMission: ['file'],
  openFile: ['path'],
  openMissionFile: ['file'],
  openDiff: ['path', 'base', 'head'],
  openWorktree: ['path'],
}

/** Valida a mensagem INTEIRA: tipo conhecido, exatamente as chaves esperadas, cada campo no formato certo. */
export function isWebviewToHost(raw: unknown): raw is WebviewToHost {
  if (typeof raw !== 'object' || raw === null) return false
  const message = raw as Record<string, unknown>
  const type = message.type
  if (typeof type !== 'string' || !(type in SHAPES)) return false
  const expected = SHAPES[type as WebviewToHost['type']]
  const keys = Object.keys(message)
    .filter((k) => k !== 'type')
    .sort()
  if (keys.join(',') !== [...expected].sort().join(',')) return false
  switch (type) {
    case 'selectMission':
    case 'openMissionFile':
      return nonEmpty(message.file)
    case 'openFile':
    case 'openWorktree':
      return nonEmpty(message.path)
    case 'openDiff':
      return isRepoPath(message.path) && isGitRef(message.base) && isGitRef(message.head)
    default:
      return true
  }
}
