import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTROL_PLANE_SERVICE, connectHttp, httpLink } from './link.js'

let server: Server | undefined

afterEach(async () => {
  const active = server
  server = undefined
  if (active !== undefined) await new Promise<void>((done) => active.close(() => done()))
})

/** Servidor HTTP de verdade: a sonda precisa falar com um socket, nao com um stub. */
async function listen(
  handler: (path: string) => { status: number; body: unknown },
): Promise<string> {
  const active = createServer((request, response) => {
    const { status, body } = handler(request.url ?? '/')
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  server = active
  await new Promise<void>((done) => active.listen(0, '127.0.0.1', () => done()))
  const address = active.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

describe('sonda do control plane', () => {
  it('reconhece o nosso control plane pela identidade do /api/health', async () => {
    const endpoint = await listen((path) =>
      path === '/api/health'
        ? { status: 200, body: { status: 'ok', service: CONTROL_PLANE_SERVICE } }
        : { status: 404, body: {} },
    )

    const link = await connectHttp(endpoint)
    expect(link?.endpoint).toBe(endpoint)
  })

  it('processo estranho na porta declarada NAO e control plane', async () => {
    // Qualquer servico pode estar na porta do `project.yaml`. Aceita-lo faria a CLI entregar
    // um `mission pause` a um estranho e devolver `HTTP 404` no lugar do caminho de volta.
    const endpoint = await listen(() => ({ status: 404, body: { error: 'nao existe aqui' } }))

    expect(await connectHttp(endpoint)).toBeUndefined()
  })

  it('servico que responde 200 sem ser o nosso tambem e recusado', async () => {
    const endpoint = await listen(() => ({ status: 200, body: { status: 'ok', service: 'outro' } }))

    expect(await connectHttp(endpoint)).toBeUndefined()
  })

  it('control plane de OUTRO projeto nao e o nosso control plane', async () => {
    // Descoberta velha, `.agentic` copiado junto com o diretorio, porta reaproveitada: do
    // outro lado ha um control plane REAL, so que de outro repositorio. Aceita-lo faria
    // `approve`, `pause` e `stop` mutarem o run errado, no projeto errado.
    const endpoint = await listen(() => ({
      status: 200,
      body: { status: 'ok', service: CONTROL_PLANE_SERVICE, repoRoot: '/projetos/outro' },
    }))

    expect(await connectHttp(endpoint, { repoRoot: '/projetos/nosso' })).toBeUndefined()
    expect((await connectHttp(endpoint, { repoRoot: '/projetos/outro' }))?.endpoint).toBe(endpoint)
  })

  it('control plane que nao diz por qual projeto responde e recusado para mutacao', async () => {
    // Ler a ausencia como "versao antiga, deixa passar" seria o mesmo erro de tratar
    // `undefined` como permissao que 003B veio corrigir na posse.
    const endpoint = await listen(() => ({
      status: 200,
      body: { status: 'ok', service: CONTROL_PLANE_SERVICE },
    }))

    expect(await connectHttp(endpoint, { repoRoot: '/projetos/nosso' })).toBeUndefined()
    // Sem expectativa declarada (sonda de leitura), a identidade do servico ainda basta.
    expect((await connectHttp(endpoint))?.endpoint).toBe(endpoint)
  })

  it('porta fechada e "nao ha control plane", nao excecao', async () => {
    const endpoint = await listen(() => ({ status: 200, body: {} }))
    const active = server
    server = undefined
    await new Promise<void>((done) => active?.close(() => done()))

    expect(await connectHttp(endpoint)).toBeUndefined()
  })
})

describe('erro devolvido pelo control plane', () => {
  it('mostra o motivo do servidor, nao apenas o codigo HTTP', async () => {
    // Envelope real da API: `{ error: { code, message } }`.
    const endpoint = await listen(() => ({
      status: 404,
      body: { error: { code: 'RUN_NOT_FOUND', message: 'run 01ABC nao existe' } },
    }))

    await expect(
      httpLink(endpoint).send({ method: 'POST', path: '/api/runs/01ABC/pause', body: {} }),
    ).rejects.toThrow('run 01ABC nao existe')
  })
})
