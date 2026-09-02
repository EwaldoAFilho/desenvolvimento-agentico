#!/usr/bin/env node
import { createControlPlaneService } from '../dist/index.js'

const argOf = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
const port = argOf('port')
const service = createControlPlaneService({
  ...(port === undefined ? {} : { port: Number(port) }),
  ...(argOf('project') === undefined ? {} : { projectFile: argOf('project') }),
})

/**
 * SIGINT e SIGTERM passam pela MESMA primitiva de encerramento que `agentic serve` e o futuro
 * Stop da extensao: parar de aceitar, drenar, fechar o banco, devolver a posse (I15).
 *
 * Assinados ANTES de subir: a adocao dos runs no boot ja despacha agente, e um sinal nessa
 * janela nao pode cair no tratador padrao do Node. O servico serializa: um `stop` pedido
 * durante o `start` acontece logo depois dele.
 *
 * Um `stop` que falha e um `stop` que NAO devolveu a posse (efeito ainda em voo, dentro do
 * prazo). Sair do processo aqui soltaria o lock pelo sistema operacional com o efeito vivo —
 * exatamente o que I15 proibe. Entao o processo FICA, diz o que houve, e o proximo sinal
 * tenta de novo. Quem quiser derrubar de qualquer jeito usa `kill -9`, sabendo o que faz.
 */
let encerrando = false
const encerrar = () => {
  if (encerrando) return
  encerrando = true
  service.stop().then(
    () => process.exit(0),
    (error) => {
      encerrando = false
      process.stderr.write(
        `o control plane nao encerrou limpo: ${error instanceof Error ? error.message : String(error)}\n` +
          'a posse do projeto continua com este processo; envie o sinal de novo para tentar outra vez.\n',
      )
    },
  )
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, encerrar)

const started = await service.start()
process.stdout.write(`control plane no ar em ${started.url}\n`)
