#!/usr/bin/env node
import { startServer } from '../dist/index.js'

const argOf = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
const port = argOf('port')
const server = await startServer({
  ...(port === undefined ? {} : { port: Number(port) }),
  ...(argOf('project') === undefined ? {} : { projectFile: argOf('project') }),
})
process.stdout.write(`control plane no ar em ${server.url}\n`)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  })
}
