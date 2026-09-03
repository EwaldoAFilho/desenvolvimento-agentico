import type { PlannerDto, PlanningFailureDto, ProviderState } from '@agentic/schemas'

/**
 * Regras da tela de nova missao que nao dependem de React. Estao aqui porque sao as que
 * decidem coisas caras: quem planeja por padrao, se a acao gasta a assinatura do usuario e o
 * que dizer quando o planejamento nao deu certo.
 */

export type PlanningFailureCode = PlanningFailureDto['code']

/**
 * Como a tela apresenta o ambiente de um planejador. Icone E rotulo textual sempre juntos:
 * uma captura em preto e branco tem de continuar legivel (DASHBOARD 3).
 */
export interface PlannerStateStyle {
  readonly icon: string
  readonly label: string
}

/**
 * `INSTALLED` e `UNKNOWN` NAO sao falha: prontidao nao apurada e resposta legitima e continua
 * assim (DASHBOARD 5.1, ADR-0010). Sao dois textos diferentes porque tem conserto diferente.
 */
const STATE_STYLES: Record<ProviderState, PlannerStateStyle> = {
  READY: { icon: '✔', label: 'observado pronto' },
  INSTALLED: { icon: '?', label: 'instalado, prontidão não apurada' },
  UNKNOWN: { icon: '?', label: 'nem a instalação foi apurada' },
  NOT_READY: { icon: '✖', label: 'sessão reprovada na sonda' },
  NOT_INSTALLED: { icon: '✖', label: 'executável ausente' },
}

export function plannerStateStyle(state: ProviderState): PlannerStateStyle {
  return STATE_STYLES[state]
}

/**
 * Falha JA OBSERVADA impede a acao; falta de observacao, nao. Oferecer partida para um
 * planejador cujo executavel sumiu transfere ao usuario o trabalho de descobrir por que nada
 * aconteceu — mas recusar por `unknown` seria tratar prontidao nao apurada como defeito.
 */
export function canPlanWith(planner: PlannerDto): boolean {
  return planner.state !== 'NOT_INSTALLED' && planner.state !== 'NOT_READY'
}

/** Planejar de verdade aciona a CLI local do usuario; simulado nao aciona nada (P17). */
export function usesSubscription(planner: PlannerDto): boolean {
  return !planner.simulated
}

/**
 * Um planejador no seletor. `simulado` vem antes de qualquer coisa sobre ambiente: um
 * fornecedor de teste pronto continua sendo fornecedor de teste, e apresenta-lo pelo estado
 * do ambiente o faria parecer capaz de planejar de verdade.
 */
export function plannerOptionLabel(planner: PlannerDto): string {
  if (planner.simulated) return `${planner.providerId} — simulado, não planeja de verdade`
  return `${planner.providerId} — ${plannerStateStyle(planner.state).label}`
}

/**
 * O padrao da tela. Com um so planejador nao ha o que escolher; com mais de um, o simulado
 * nunca e o padrao enquanto existir um real — padrao e o que o distraido aceita, e aceitar um
 * planejador simulado sem perceber produz um plano que nao serve para executar.
 *
 * `preferred` e o fornecedor padrao do projeto: sinal fraco (ele e escolhido para EXECUTAR,
 * nao para planejar), entao so vale quando aponta para um planejador real.
 */
export function defaultPlannerOf(
  planners: readonly PlannerDto[],
  preferred?: string,
): PlannerDto | undefined {
  if (planners.length <= 1) return planners[0]
  const real = planners.filter((planner) => !planner.simulated)
  const asked = real.find((planner) => planner.providerId === preferred)
  if (asked !== undefined) return asked
  return real.find((planner) => planner.state === 'READY') ?? real[0] ?? planners[0]
}

/**
 * O que a tela diz ANTES de acionar. Planejar com fornecedor real executa a CLI local ja
 * autenticada e consome a assinatura do usuario: isso se avisa antes, nunca depois (P17).
 */
export interface SubscriptionNotice {
  /** `true` obriga aceite explicito — o control plane recusa o pedido sem ele. */
  readonly consumes: boolean
  readonly title: string
  readonly detail: string
}

export function subscriptionNoticeOf(planner: PlannerDto): SubscriptionNotice {
  if (planner.simulated) {
    return {
      consumes: false,
      title: `${planner.providerId} é um planejador simulado`,
      detail:
        'não aciona fornecedor nenhum e não consome assinatura. O plano que ele devolve serve ' +
        'para exercitar a jornada — não é planejamento de verdade e não deve ser executado ' +
        'como se fosse.',
    }
  }
  return {
    consumes: true,
    title: `planejar com ${planner.providerId} consome a sua assinatura`,
    detail:
      `o control plane executa a CLI local ${planner.providerId}, já instalada e autenticada ` +
      'na sua máquina. Nenhuma chave de API é pedida, lida ou guardada, e planejar é leitura: ' +
      'quem grava o arquivo da missão é o control plane, não o agente.',
  }
}

/**
 * Falha de planejamento vira diagnostico: o que aconteceu e o que da para fazer com isso.
 * Sem esta tabela sobra a frase crua do control plane, que diz o sintoma e nao o conserto.
 */
export interface PlanningDiagnosis {
  readonly title: string
  readonly hint: string
}

const DIAGNOSES: Record<PlanningFailureCode, PlanningDiagnosis> = {
  PLANNER_UNAVAILABLE: {
    title: 'o planejador não estava disponível',
    hint:
      'a CLI do planejador não pôde ser acionada. Confira a instalação e a sessão dela nesta ' +
      'máquina (`agentic doctor`) — nenhuma credencial é pedida aqui.',
  },
  PLANNER_FAILED: {
    title: 'o planejador falhou durante o planejamento',
    hint:
      'a falha é do lado do agente, não do pedido. Tentar de novo é razoável; se repetir, ' +
      'escolha outro planejador ou escreva o YAML da missão à mão.',
  },
  PLANNER_TIMEOUT: {
    title: 'o planejador não respondeu no prazo',
    hint:
      'o prazo é do control plane e existe para a tela não ficar esperando para sempre. Um ' +
      'pedido mais curto e mais específico costuma caber no tempo.',
  },
  PLANNER_CANCELLED: {
    title: 'o planejamento foi interrompido antes de terminar',
    hint: 'nada ficou pela metade: peça de novo quando quiser.',
  },
  NO_PROPOSAL: {
    title: 'o planejador terminou sem propor um plano',
    hint:
      'ele não devolveu nenhuma proposta. Descreva o resultado que você quer, e não o caminho ' +
      'até ele — pedido vago costuma voltar vazio.',
  },
  CONTRACT_REJECTED: {
    title: 'o plano proposto não respeita o formato de missão',
    hint:
      'a proposta foi recusada pelo mesmo contrato que vale para uma missão escrita à mão. Os ' +
      'pontos abaixo dizem onde ela feriu o formato.',
  },
  PLAN_UNCHANGED: {
    title: 'a correção repetiu o plano anterior',
    hint:
      'o planejador devolveu de novo a mesma proposta em vez de corrigi-la, então o ciclo ' +
      'parou de andar. Reformular o pedido costuma render mais do que insistir.',
  },
  REVISIONS_EXHAUSTED: {
    title: 'as correções acabaram e o plano ainda não compilava',
    hint:
      'o crédito de correção é curto de propósito: esgotado, a decisão volta para você (P15). ' +
      'Ajuste o pedido, escolha outro planejador ou escreva a missão à mão.',
  },
}

export function planningDiagnosisOf(failure: PlanningFailureDto): PlanningDiagnosis {
  return DIAGNOSES[failure.code]
}

/** `3 correções`, `1 correção`, `nenhuma correção` — o numero cru sozinho nao se le. */
export function revisionsText(revisions: number): string {
  if (revisions === 0) return 'nenhuma correção'
  return revisions === 1 ? '1 correção' : `${revisions} correções`
}
