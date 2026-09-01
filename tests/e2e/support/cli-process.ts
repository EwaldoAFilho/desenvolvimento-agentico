/**
 * A CLI DE VERDADE, num processo de sistema operacional separado.
 *
 * Nao e uma imitacao do comando: e `main(argv)` de `@agentic/cli`, com as dependencias
 * padrao (banco de verdade, servidor de verdade, HTTP de verdade). So duas coisas sao
 * injetadas, e nenhuma delas muda a decisao sob teste:
 *
 * - `cwd`, para o comando encontrar o `.agentic/` do projeto descartavel;
 * - `waitForShutdown`, resolvida por SIGTERM/SIGINT, para o processo poder ser encerrado
 *   pelo teste (o default ja e exatamente isto, mas aqui ele fica visivel).
 *
 * Protocolo com o pai: o stdout do comando e repassado cru (o teste espera por uma linha
 * de prontidao, ex.: `control plane no ar em ...`), e o fim e anunciado numa linha unica
 * `##CLI-RESULT## {json}`.
 */
import nodeProcess from 'node:process'
import { main } from '@agentic/cli'

export const RESULT_MARKER = '##CLI-RESULT##'

interface CliProcessResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

async function run(): Promise<void> {
  const cwd = nodeProcess.argv[2]
  const rawArgv = nodeProcess.argv[3]
  if (cwd === undefined || rawArgv === undefined) {
    throw new Error('uso: cli-process.ts <cwd> <argv-json>')
  }
  const argv = JSON.parse(rawArgv) as string[]

  let out = ''
  let err = ''
  const code = await main(['node', 'agentic', ...argv], {
    cwd,
    stdout: (text: string) => {
      out += text
      nodeProcess.stdout.write(text)
    },
    stderr: (text: string) => {
      err += text
      nodeProcess.stderr.write(text)
    },
    exit: () => undefined,
    waitForShutdown: () =>
      new Promise<void>((resolve) => {
        nodeProcess.once('SIGTERM', () => resolve())
        nodeProcess.once('SIGINT', () => resolve())
      }),
  })

  const result: CliProcessResult = { code, stdout: out, stderr: err }
  nodeProcess.stdout.write(`\n${RESULT_MARKER} ${JSON.stringify(result)}\n`)
}

await run()
