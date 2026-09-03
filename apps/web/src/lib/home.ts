import type {
  MissionSummaryDto,
  MissionViewState,
  ProviderHealthDto,
  ProviderState,
  RunSummaryDto,
} from '@agentic/schemas'
import { providerStateOf } from '@agentic/schemas'

export type RunViewStatus = RunSummaryDto['status']

/**
 * Execucao que ainda esta em jogo. `PAUSED`, `BLOCKED` e `VERIFYING` entram: o run nao
 * acabou, so nao esta despachando — e quem abriu o projeto precisa ver isso, nao a lista.
 */
export const ACTIVE_RUN_STATUSES = ['RUNNING', 'PAUSED', 'BLOCKED', 'VERIFYING'] as const

export function isActiveRun(status: RunViewStatus): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(status)
}

/**
 * A execucao que toma a tela quando nao ha nada na URL. A lista chega do mais recente para o
 * mais antigo, entao a primeira ativa e a de agora. Run encerrado NAO conta: sequestrar a
 * Home com um run de ontem e o que impedia o projeto de mostrar o proprio estado.
 */
export function activeRunOf(runs: readonly RunSummaryDto[]): RunSummaryDto | undefined {
  return runs.find((run) => isActiveRun(run.status))
}

/**
 * Como a Home pinta um estado de missao. Icone e rotulo textual acompanham a cor sempre:
 * uma captura em preto e branco tem de continuar legivel (DASHBOARD 3).
 */
export interface MissionStateStyle {
  readonly state: MissionViewState
  readonly icon: string
  readonly label: string
}

const STATE_STYLES: Record<MissionViewState, MissionStateStyle> = {
  INVALID: { state: 'INVALID', icon: '⚠', label: 'INVÁLIDA' },
  PLANNED: { state: 'PLANNED', icon: '○', label: 'PLANEJADA' },
  DRAFT: { state: 'DRAFT', icon: '◔', label: 'RASCUNHO' },
  APPROVED: { state: 'APPROVED', icon: '◑', label: 'APROVADA' },
  RUNNING: { state: 'RUNNING', icon: '▶', label: 'EM EXECUÇÃO' },
  COMPLETED: { state: 'COMPLETED', icon: '✔', label: 'CONCLUÍDA' },
  FAILED: { state: 'FAILED', icon: '✖', label: 'FALHOU' },
  CANCELLED: { state: 'CANCELLED', icon: '⊗', label: 'CANCELADA' },
}

export function missionStateStyle(state: MissionViewState): MissionStateStyle {
  return STATE_STYLES[state]
}

/**
 * O que a Home oferece para uma missao. `none` nao e um botao desligado: e a ausencia do
 * botao mais o motivo escrito. Oferecer uma acao que o control plane recusaria transfere ao
 * usuario o trabalho de descobrir por que nada aconteceu.
 */
export type MissionActionKind = 'open-run' | 'open-mission' | 'none'

export interface MissionAction {
  readonly kind: MissionActionKind
  /** Vazio quando `kind` e `none`: nao ha rotulo porque nao ha botao. */
  readonly label: string
  /** Sempre presente: por que ha — ou por que nao ha — o que fazer. */
  readonly hint: string
  /** Alvo da navegacao. Presente exatamente quando ha acao. */
  readonly runId?: string
  readonly missionId?: string
}

interface ActionPlan {
  readonly kind: MissionActionKind
  readonly label: string
  readonly hint: string
}

/**
 * Tabela explicita por estado — `Record<MissionViewState, …>` faz o compilador cobrar um
 * estado novo aqui em vez de deixa-lo cair num `default` que oferece a acao errada.
 */
const PLANS: Record<MissionViewState, ActionPlan> = {
  INVALID: {
    kind: 'none',
    label: '',
    hint: 'não compila: corrija o YAML antes de qualquer ação',
  },
  PLANNED: {
    kind: 'open-mission',
    label: 'abrir missão',
    hint: 'compila e nunca virou execução',
  },
  DRAFT: {
    kind: 'open-mission',
    label: 'revisar e aprovar',
    hint: 'rascunho aguardando ato humano de aprovação',
  },
  APPROVED: {
    kind: 'open-mission',
    label: 'iniciar missão',
    hint: 'aprovada, ainda não iniciada',
  },
  RUNNING: {
    kind: 'open-run',
    label: 'acompanhar execução',
    hint: 'execução em andamento',
  },
  COMPLETED: { kind: 'open-run', label: 'ver execução', hint: 'execução concluída' },
  FAILED: { kind: 'open-run', label: 'ver execução', hint: 'execução falhou' },
  CANCELLED: { kind: 'open-run', label: 'ver execução', hint: 'execução cancelada' },
}

function withoutAction(hint: string): MissionAction {
  return { kind: 'none', label: '', hint }
}

/**
 * A acao coerente com o estado — e nenhuma quando o alvo nao existe. Um estado terminal sem
 * run registrado e uma missao sem id sao raros, mas em ambos o botao levaria a uma tela que
 * nao pode carregar: preferimos dizer o motivo a oferecer o beco sem saida.
 */
export function missionActionOf(mission: MissionSummaryDto): MissionAction {
  const plan = PLANS[mission.state]
  if (plan.kind === 'open-run') {
    const runId = mission.lastRun?.id
    if (runId === undefined) return withoutAction('sem execução registrada para abrir')
    return { ...plan, runId }
  }
  if (plan.kind === 'open-mission') {
    const missionId = mission.id
    if (missionId === undefined) return withoutAction('o arquivo não declara um id de missão')
    return { ...plan, missionId }
  }
  return withoutAction(plan.hint)
}

/**
 * Saude do ambiente COMO A HOME MOSTRA. `INDETERMINATE` existe para que prontidao nao
 * apurada nunca seja apresentada como ambiente pronto: `unknown` e resposta legitima e
 * continua `unknown` (DASHBOARD 5.1, ADR-0010).
 */
export type EnvironmentVerdict = 'READY' | 'ATTENTION' | 'INDETERMINATE' | 'NONE'

export interface EnvironmentSummary {
  readonly verdict: EnvironmentVerdict
  readonly icon: string
  readonly label: string
  readonly detail: string
  readonly byState: Readonly<Record<ProviderState, number>>
}

function tally(providers: readonly ProviderHealthDto[]): Record<ProviderState, number> {
  const counters: Record<ProviderState, number> = {
    READY: 0,
    NOT_READY: 0,
    INSTALLED: 0,
    NOT_INSTALLED: 0,
    UNKNOWN: 0,
  }
  for (const provider of providers) counters[providerStateOf(provider)] += 1
  return counters
}

/**
 * Ordem deliberada: falha observada vence indeterminacao, e indeterminacao vence prontidao.
 * `READY` so sai quando TODO fornecedor foi observado pronto — um unico `unknown` derruba o
 * veredito para `INDETERMINATE`, porque otimismo aqui vira diagnostico perdido depois.
 */
export function environmentOf(providers: readonly ProviderHealthDto[]): EnvironmentSummary {
  const byState = tally(providers)
  if (providers.length === 0) {
    return {
      verdict: 'NONE',
      icon: '—',
      label: 'sem fornecedor',
      detail: 'nenhum fornecedor configurado neste projeto',
      byState,
    }
  }
  const faulty = byState.NOT_INSTALLED + byState.NOT_READY
  if (faulty > 0) {
    return {
      verdict: 'ATTENTION',
      icon: '✖',
      label: 'ambiente com pendência',
      detail: `${faulty} de ${providers.length} fornecedor(es) indisponível(is)`,
      byState,
    }
  }
  const undetermined = byState.UNKNOWN + byState.INSTALLED
  if (undetermined > 0) {
    return {
      verdict: 'INDETERMINATE',
      icon: '?',
      label: 'prontidão não apurada',
      detail: `${undetermined} de ${providers.length} fornecedor(es) sem prontidão observada`,
      byState,
    }
  }
  return {
    verdict: 'READY',
    icon: '✔',
    label: 'ambiente pronto',
    detail: `${byState.READY} fornecedor(es) observados prontos`,
    byState,
  }
}
