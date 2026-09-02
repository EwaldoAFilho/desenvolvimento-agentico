/**
 * Competidor mínimo da corrida de posse.
 *
 * Importa SO o primitivo — nada de servidor, orquestrador ou banco de estado. E o que torna
 * viavel soltar oito processos de verdade ao mesmo tempo, varias vezes, dentro da suite.
 *
 * Espera o instante combinado antes de tentar: sem essa janela, os processos chegariam em
 * fila por causa do tempo de partida e a corrida nao seria corrida.
 */
import nodeProcess from 'node:process'
import { acquireControlPlaneOwnership } from '@agentic/persistence'

const baseDir = nodeProcess.argv[2]
const at = Number(nodeProcess.argv[3] ?? '0')
if (baseDir === undefined) throw new Error('uso: lock-racer.ts <baseDir> <instanteMs>')

while (Date.now() < at) {
  /* espera ativa: a disputa precisa ser simultanea de verdade */
}

const outcome = acquireControlPlaneOwnership({ baseDir })
if (outcome.ok) {
  nodeProcess.stdout.write(`WIN ${nodeProcess.pid} ${outcome.lease.instanceId}\n`)
  /**
   * O vencedor segura a posse ate o PAI mandar sair — nunca por temporizador.
   *
   * Segurar por 500ms parecia bastar e nao bastava, e o modo de falhar merece ficar
   * escrito porque ele acusa a invariante errada. O competidor so tenta depois de nascer,
   * e nascer custa o boot do `vite-node`. Com a maquina ociosa todos os oito nascem ANTES
   * do instante combinado (medido: ~600ms antes) e disputam juntos. Sob carga — a suite E2E
   * inteira em paralelo — parte deles nasce DEPOIS (medido: ate +700ms), ja com a espera
   * ativa vencida, e tenta na hora em que chega. Um retardatario que chega depois do
   * vencedor ter soltado ganha LEGITIMAMENTE, e a rodada acusa "dois vencedores" sem nunca
   * ter havido dois donos ao mesmo tempo.
   *
   * Medido nesta arvore, com os oito nucleos ocupados: 7 de 8 rodadas com dois vencedores,
   * e os carimbos mostram a sequencia — vencedor em +247ms, `release` em +748ms, segundo
   * vencedor em +755ms. Sequencial, jamais simultaneo. O lock estava certo; a prova e que
   * estava medindo tempo de partida.
   *
   * `entrypoint-racer.ts` ja fazia assim desde a 003B; este arquivo tinha ficado para tras.
   */
  await new Promise<void>((resolve) => {
    // O `setInterval` nao e enfeite: um processo que so registra tratador de sinal NAO fica
    // vivo — o handle de sinal do Node nao segura o event loop.
    const batimento = setInterval(() => undefined, 60_000)
    const encerrar = (): void => {
      clearInterval(batimento)
      resolve()
    }
    nodeProcess.once('SIGTERM', encerrar)
    nodeProcess.once('SIGINT', encerrar)
  })
  outcome.lease.release()
} else {
  nodeProcess.stdout.write(`LOSE ${nodeProcess.pid} ${outcome.code}\n`)
}
