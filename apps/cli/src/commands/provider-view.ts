import type { ProviderDiagnosticDto, ProviderHealthDto, Tristate } from '@agentic/schemas'
import { pad, tristate } from '../output.js'
import { sanitize } from '../redact.js'

/**
 * Os cinco estados de um fornecedor. Existem porque `installed` e `ready` sozinhos deixam
 * o operador adivinhando: "nao instalado" e "instalado, prontidao nao apurada" tem
 * conserto diferente, e `unknown` nao e nenhum dos dois (ADR-0010, DASHBOARD 5.1).
 */
export const PROVIDER_STATES = [
  'READY',
  'NOT_READY',
  'INSTALLED',
  'NOT_INSTALLED',
  'UNKNOWN',
] as const

export type ProviderState = (typeof PROVIDER_STATES)[number]

export const UNKNOWN = 'unknown'

/**
 * Total e sem ambiguidade:
 *
 * - `NOT_INSTALLED` — nao ha executavel; nada mais importa ate isso mudar.
 * - `NOT_READY`     — existe (ou pode existir), mas a sonda de sessao REPROVOU.
 * - `UNKNOWN`       — a propria instalacao nao foi apurada.
 * - `READY`         — instalado e sonda de sessao aprovou.
 * - `INSTALLED`     — instalado, prontidao nao apurada. Nao e READY, e nao e falha.
 */
export function providerStateOf(health: ProviderHealthDto): ProviderState {
  if (health.installed === false) return 'NOT_INSTALLED'
  if (health.ready === false) return 'NOT_READY'
  if (health.installed === UNKNOWN) return 'UNKNOWN'
  if (health.ready === true) return 'READY'
  return 'INSTALLED'
}

/**
 * O que o doctor mostra por fornecedor, ja saneado. `running` aceita `unknown`: quando o
 * estado persistido nao pode ser lido, dizemos isso — nunca repetimos um numero que so
 * vale dentro de outro processo.
 */
export interface ProviderView {
  readonly provider: string
  readonly state: ProviderState
  readonly installed: Tristate
  readonly executable: string
  readonly resolvedPath: string
  readonly version: string
  readonly ready: Tristate
  readonly readinessSource: string
  readonly running: number | typeof UNKNOWN
  readonly capacity: number | null
  readonly detail: string
  readonly diagnostic?: ProviderDiagnosticDto
}

function sanitizedDiagnostic(
  diagnostic: ProviderDiagnosticDto | undefined,
): ProviderDiagnosticDto | undefined {
  if (diagnostic === undefined) return undefined
  return {
    kind: diagnostic.kind,
    detail: sanitize(diagnostic.detail),
    ...(diagnostic.target === undefined ? {} : { target: sanitize(diagnostic.target) }),
    ...(diagnostic.remediation === undefined
      ? {}
      : { remediation: sanitize(diagnostic.remediation) }),
  }
}

export interface ProviderViewInput {
  readonly health: ProviderHealthDto
  /** `command` declarado no project.yaml; ausente em provider in-process. */
  readonly executable?: string
  /** `undefined` = nao foi possivel apurar o numero de agentes em voo. */
  readonly running?: number
}

export function providerViewOf(input: ProviderViewInput): ProviderView {
  const health = input.health
  const diagnostic = sanitizedDiagnostic(health.diagnostic)
  return {
    provider: health.providerId,
    state: providerStateOf(health),
    installed: health.installed,
    executable: input.executable ?? '(in-process)',
    resolvedPath: health.resolvedPath ?? UNKNOWN,
    version: health.version,
    ready: health.ready,
    readinessSource: sanitize(health.readinessSource ?? UNKNOWN),
    running: input.running ?? UNKNOWN,
    capacity: health.capacity,
    detail: sanitize(health.detail),
    ...(diagnostic === undefined ? {} : { diagnostic }),
  }
}

const LABEL = 15

function field(label: string, value: string): string {
  return `  ${pad(label, LABEL)}${value}`
}

export function capacityLabel(capacity: number | null): string {
  return capacity === null ? 'sem teto' : String(capacity)
}

/**
 * Bloco por fornecedor. Um fornecedor quebrado precisa sair daqui com o CONSERTO na tela;
 * uma linha de tabela nao comporta isso.
 */
export function renderProviderView(view: ProviderView): string[] {
  const lines = [
    `${view.provider}  ${view.state}`,
    field('instalado', tristate(view.installed)),
    field('executavel', view.executable),
    field('caminho', view.resolvedPath),
    field('versao', view.version),
    field('pronto', `${tristate(view.ready)} · origem: ${view.readinessSource}`),
    field('em voo', `${view.running} · capacidade ${capacityLabel(view.capacity)}`),
  ]
  if (view.detail.length > 0) lines.push(field('detalhe', view.detail))
  const diagnostic = view.diagnostic
  if (diagnostic !== undefined) {
    lines.push(field('diagnostico', `[${diagnostic.kind}] ${diagnostic.detail}`))
    if (diagnostic.target !== undefined) {
      // O alvo de um link quebrado e justamente o que NAO existe: dizer isso poupa a busca.
      const missing = diagnostic.kind === 'broken-symlink' ? ' (nao existe)' : ''
      lines.push(field('alvo', `${diagnostic.target}${missing}`))
    }
    if (diagnostic.remediation !== undefined) {
      lines.push(field('conserto', diagnostic.remediation))
    }
  }
  return lines
}
