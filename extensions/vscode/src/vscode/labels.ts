import type { BlockageDto, ProviderHealthDto } from '../core/contracts.js'

/**
 * Derivacoes PURAS das sidebars. Nenhum import de `vscode` mora aqui, de proposito: e o
 * que permite prende-las em teste unitario contra o contrato publicado — o modulo que
 * importa `vscode` so carrega dentro do editor.
 */

/**
 * Os CINCO estados de um fornecedor, copiados do contrato
 * (`packages/schemas/src/api/provider-health.ts`, `providerStateOf`).
 *
 * E uma COPIA deliberada, e nao um import: a extensao e cliente e o bundle nao carrega o
 * core (`src/bundle.test.ts`). O que impede a copia de envelhecer e `labels.test.ts`, que
 * roda em Node e compara esta funcao com a derivacao canonica em TODAS as combinacoes.
 *
 * A tabela anterior tinha QUATRO rotulos e mentia em dois pontos: chamava `NOT_INSTALLED`
 * de `UNAVAILABLE`, e — pior — devolvia `UNKNOWN` para um fornecedor INSTALADO cuja
 * prontidao nao foi apurada, o mesmo caso em que a CLI e o dashboard mostram `INSTALLED`.
 * O usuario via um estado no editor e outro no terminal, para o mesmo fato (ADR-0016).
 */
export type ProviderState = 'READY' | 'NOT_READY' | 'INSTALLED' | 'NOT_INSTALLED' | 'UNKNOWN'

export function providerStateLabel(provider: ProviderHealthDto): ProviderState {
  if (provider.installed === false) return 'NOT_INSTALLED'
  if (provider.ready === false) return 'NOT_READY'
  if (provider.installed === 'unknown') return 'UNKNOWN'
  if (provider.ready === true) return 'READY'
  return 'INSTALLED'
}

/**
 * Icone por estado. `INSTALLED` nao e verde e nao e erro: e "instalado, prontidao nao
 * apurada" — pintar de verde seria o otimismo que o contrato proibe (DASHBOARD 5.1).
 */
const PROVIDER_ICONS: Readonly<Record<ProviderState, string>> = {
  READY: 'check',
  NOT_READY: 'warning',
  INSTALLED: 'circle-outline',
  NOT_INSTALLED: 'error',
  UNKNOWN: 'question',
}

export function providerIcon(state: ProviderState): string {
  return PROVIDER_ICONS[state]
}

/**
 * O motivo de a task ter parado — na TASK, nunca no fornecedor.
 *
 * Saude de fornecedor e estado global, apurado por sonda; um bloqueio e o desfecho de UMA
 * tentativa. Misturar os dois faria a sidebar acusar a CLI quando o que houve foi uma
 * politica de revisao insatisfazivel — e calar quando a CLI e que esta quebrada.
 */
export function taskTooltip(title: string, blockage: BlockageDto | undefined): string | undefined {
  if (blockage === undefined) return title === '' ? undefined : title
  const lines = title === '' ? [] : [title]
  lines.push(`bloqueada (${blockage.kind}): ${blockage.reason}`)
  if (blockage.needs !== '') lines.push(`precisa de: ${blockage.needs}`)
  return lines.join('\n')
}
