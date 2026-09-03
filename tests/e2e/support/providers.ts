/**
 * Bloco `providers:` das suites que trocam o fixture por agentes roteirizados.
 *
 * Estava copiado em sete arquivos, identico, e a copia cobrava: mudar a semantica de um
 * `kind` obrigava a caçar as sete. Agora e um lugar so.
 *
 * `local-cli`, e nao `inprocess`, de proposito. `inprocess` e a marca de ENSAIO no contrato
 * — e agente de ensaio nao executa nem revisa tentativa real (`selectReviewer`, transicao
 * 12b). O que torna estes fornecedores baratos e a substituicao do FACTORY pelo harness,
 * nao a declaracao no arquivo: nenhuma CLI e construida no processo do teste, e o `command`
 * abaixo nunca existe. Num processo FILHO (`agentic serve`), que nao substitui factory
 * nenhuma, o comando inexistente falha o spawn e a tentativa reprova com causa observada —
 * que e o que essas suites querem: um agente que nao entrega, sem quota e sem rede.
 */
export const SCRIPTED_PROVIDERS = ['alfa', 'beta'] as const

const BLOCK = [
  '  default: alfa',
  '  registry:',
  '    alfa:',
  '      kind: local-cli',
  '      command: agente-roteirizado-alfa',
  '      maxConcurrent: 3',
  '      roles: [executor, reviewer]',
  '    beta:',
  '      kind: local-cli',
  '      command: agente-roteirizado-beta',
  '      maxConcurrent: 2',
  '      roles: [executor, reviewer]',
  '',
].join('\n')

/** Troca o bloco de fornecedores do `project.yaml` do fixture, preservando o resto. */
export function withScriptedProviders(projectText: string): string {
  const inicio = projectText.indexOf('  default: claude-code')
  const fim = projectText.indexOf('\ngates:')
  if (inicio === -1 || fim === -1) throw new Error('fixture: bloco de providers nao encontrado')
  return projectText.slice(0, inicio) + BLOCK + projectText.slice(fim)
}
