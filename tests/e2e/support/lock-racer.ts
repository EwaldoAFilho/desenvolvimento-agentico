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
  // Segura a posse por um instante: se ela fosse solta na hora, o proximo competidor
  // ganharia legitimamente e a rodada teria dois vencedores sem nenhuma corrida perdida.
  setTimeout(() => {
    outcome.lease.release()
  }, 500)
} else {
  nodeProcess.stdout.write(`LOSE ${nodeProcess.pid} ${outcome.code}\n`)
}
