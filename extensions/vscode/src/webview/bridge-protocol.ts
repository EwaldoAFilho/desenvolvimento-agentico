import type { ServiceView } from '../core/service.js'
import { isGitRef, isRepoPath } from './protocol.js'

/**
 * Protocolo da PONTE entre o dashboard (React, na webview) e o extension host.
 *
 * A webview nao tem rede: toda chamada de API vira uma mensagem `api` que o host executa
 * contra o control plane e responde com status e corpo; o stream de eventos (SSE) e aberto
 * pelo host e repassado evento a evento. As acoes de editor passam pela mesma validacao de
 * caminho/refs do painel anterior. Mensagem com tipo ou forma desconhecida e descartada.
 */
export interface AppRoute {
  readonly run?: string
  readonly mission?: string
  readonly new?: true
}

export interface HostState {
  readonly service: ServiceView
  readonly project?: { readonly name: string; readonly repoRoot: string; readonly branch?: string }
  readonly defaultActor?: string
  readonly route?: AppRoute
  readonly busy?: string
}

export type ApiMethod = 'GET' | 'POST'

export type WebviewToHostBridge =
  | { readonly type: 'ready' }
  | {
      readonly type: 'api'
      readonly id: number
      readonly method: ApiMethod
      /** Caminho SEM o prefixo `/api`, como o cliente do dashboard o emite. */
      readonly path: string
      readonly body?: string
    }
  | { readonly type: 'stream.open'; readonly streamId: number; readonly path: string }
  | { readonly type: 'stream.close'; readonly streamId: number }
  | { readonly type: 'editor.openPath'; readonly path: string }
  | {
      readonly type: 'editor.openDiff'
      readonly path: string
      readonly base: string
      readonly head: string
    }
  | { readonly type: 'navigated'; readonly route: AppRoute }
  | { readonly type: 'lifecycle'; readonly op: 'start' | 'stop' | 'restart' }
  | { readonly type: 'showLog' }

export type HostToWebviewBridge =
  | { readonly type: 'host'; readonly state: HostState }
  | {
      readonly type: 'api.result'
      readonly id: number
      readonly status: number
      readonly ok: boolean
      readonly text: string
    }
  | {
      readonly type: 'stream.event'
      readonly streamId: number
      readonly event: { readonly type: string; readonly data: string; readonly id?: string }
    }
  | { readonly type: 'stream.closed'; readonly streamId: number; readonly error?: string }

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** Caminho de API: comeca por `/`, relativo, sem esquema, sem `..`, sem quebra de linha. */
export function isApiPath(value: unknown): value is string {
  if (!nonEmpty(value)) return false
  if (!value.startsWith('/') || value.startsWith('//')) return false
  if (/[\s]/.test(value)) return false
  if (value.includes('..') || value.includes('://')) return false
  return true
}

const ROUTE_KEYS: ReadonlySet<string> = new Set(['run', 'mission', 'new'])

export function isAppRoute(value: unknown): value is AppRoute {
  if (typeof value !== 'object' || value === null) return false
  const route = value as Record<string, unknown>
  for (const key of Object.keys(route)) {
    if (!ROUTE_KEYS.has(key)) return false
  }
  if (route.run !== undefined && !nonEmpty(route.run)) return false
  if (route.mission !== undefined && !nonEmpty(route.mission)) return false
  if (route.new !== undefined && route.new !== true) return false
  return true
}

const SHAPES: Record<WebviewToHostBridge['type'], readonly string[]> = {
  ready: [],
  api: ['id', 'method', 'path', 'body'],
  'stream.open': ['streamId', 'path'],
  'stream.close': ['streamId'],
  'editor.openPath': ['path'],
  'editor.openDiff': ['path', 'base', 'head'],
  navigated: ['route'],
  lifecycle: ['op'],
  showLog: [],
}

const OPTIONAL: Readonly<Record<string, readonly string[]>> = { api: ['body'] }

/** Valida a mensagem INTEIRA: tipo conhecido, chaves esperadas (as opcionais podem faltar), formato de cada campo. */
export function isWebviewToHostBridge(raw: unknown): raw is WebviewToHostBridge {
  if (typeof raw !== 'object' || raw === null) return false
  const message = raw as Record<string, unknown>
  const type = message.type
  if (typeof type !== 'string' || !(type in SHAPES)) return false
  const expected = SHAPES[type as WebviewToHostBridge['type']]
  const optional = new Set(OPTIONAL[type] ?? [])
  const keys = Object.keys(message).filter((k) => k !== 'type')
  if (keys.some((k) => !expected.includes(k))) return false
  if (expected.some((k) => !optional.has(k) && !(k in message))) return false
  switch (type) {
    case 'api':
      return (
        isId(message.id) &&
        (message.method === 'GET' || message.method === 'POST') &&
        isApiPath(message.path) &&
        (message.body === undefined || typeof message.body === 'string')
      )
    case 'stream.open':
      return isId(message.streamId) && isApiPath(message.path)
    case 'stream.close':
      return isId(message.streamId)
    case 'editor.openPath':
      return nonEmpty(message.path)
    case 'editor.openDiff':
      return isRepoPath(message.path) && isGitRef(message.base) && isGitRef(message.head)
    case 'navigated':
      return isAppRoute(message.route)
    case 'lifecycle':
      return message.op === 'start' || message.op === 'stop' || message.op === 'restart'
    default:
      return true
  }
}
