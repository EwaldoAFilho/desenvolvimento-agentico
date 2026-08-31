import {
  PROVIDER_STATES,
  type ProviderDiagnosticDto,
  type ProviderHealthDto,
  type ProviderState,
  providerStateOf,
  type Tristate,
  UNKNOWN,
} from '@agentic/schemas'
import { pad, tristate } from '../output.js'
import { sanitize } from '../redact.js'

/**
 * Os cinco estados e a derivacao moraram aqui ate o dashboard precisar dos mesmos cinco.
 * Agora vivem no contrato (`@agentic/schemas`), o unico pacote que terminal e navegador
 * compartilham — duas derivacoes com a mesma intencao divergem, e a divergencia aparece como
 * fornecedor verde de um lado e amarelo do outro (ADR-0013).
 *
 * A reexportacao fica: o ponto de entrada da CLI ja publica estes nomes, e tirar um nome
 * publicado para mover codigo seria quebrar contrato por conveniencia de arquivo.
 */
export { PROVIDER_STATES, type ProviderState, providerStateOf, UNKNOWN }

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
