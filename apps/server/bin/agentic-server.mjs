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
const started = await service.start()
process.stdout.write(`control plane no ar em ${started.url}\n`)
// SIGINT e SIGTERM passam pela MESMA primitiva de encerramento que `agentic serve` e o
// futuro Stop da extensao: parar de atender, drenar, fechar o banco, devolver a posse.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    service.stop().then(
      () => process.exit(0),
      (error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
        process.exit(1)
      },
    )
  })
}
