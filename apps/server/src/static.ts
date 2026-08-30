import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ServerDeps } from './deps.js'

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
}

export const MISSING_BUILD_MESSAGE =
  'Dashboard nao compilado. Rode `npm run build -w @agentic/web` e recarregue esta pagina.'

const MISSING_BUILD_PAGE = `<!doctype html>
<html lang="pt-BR">
  <head><meta charset="utf-8" /><title>Desenvolvimento Agentico</title></head>
  <body>
    <h1>Control plane no ar</h1>
    <p>${MISSING_BUILD_MESSAGE}</p>
    <p>A API continua respondendo em <code>/api</code>.</p>
  </body>
</html>
`

function contentTypeOf(path: string): string {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

async function readIfFile(path: string): Promise<Buffer | undefined> {
  try {
    if (!(await stat(path)).isFile()) return undefined
    return await readFile(path)
  } catch {
    return undefined
  }
}

/** Caminho do pedido confinado ao `dist`: `..` no URL nao le fora do diretorio servido. */
export function safeJoin(root: string, urlPath: string): string | undefined {
  const decoded = (() => {
    try {
      return decodeURIComponent(urlPath)
    } catch {
      return undefined
    }
  })()
  if (decoded === undefined || decoded.includes('\0')) return undefined
  const target = resolve(root, `.${normalize(decoded)}`)
  if (target !== root && !target.startsWith(`${root}${sep}`)) return undefined
  return target
}

export function pathnameOf(url: string): string {
  const index = url.indexOf('?')
  return index === -1 ? url : url.slice(0, index)
}

export function isApiPath(url: string): boolean {
  const pathname = pathnameOf(url)
  return pathname === '/api' || pathname.startsWith('/api/')
}

/**
 * Estaticos do dashboard com fallback SPA. Regra que nao se negocia: `/api` NUNCA cai no
 * index.html — rota de API inexistente responde 404 JSON, senao o cliente recebe HTML onde
 * esperava contrato.
 */
export function registerStatic(app: FastifyInstance, deps: ServerDeps): void {
  const dist = resolve(deps.webDist)

  const sendIndex = async (reply: FastifyReply): Promise<FastifyReply> => {
    const index = await readIfFile(join(dist, 'index.html'))
    if (index === undefined) {
      return reply.status(200).type('text/html; charset=utf-8').send(MISSING_BUILD_PAGE)
    }
    return reply.status(200).type('text/html; charset=utf-8').send(index)
  }

  app.setNotFoundHandler(async (request: FastifyRequest, reply: FastifyReply) => {
    if (isApiPath(request.url)) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: `rota ${request.method} ${request.url} nao existe` },
      })
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: `rota ${request.method} ${request.url} nao existe` },
      })
    }
    const pathname = pathnameOf(request.url)
    const target = safeJoin(dist, pathname)
    if (target === undefined) {
      return reply.status(400).send({
        error: { code: 'INVALID_PATH', message: 'caminho invalido' },
      })
    }
    const file = pathname === '/' ? undefined : await readIfFile(target)
    if (file !== undefined) {
      return reply.status(200).type(contentTypeOf(target)).send(file)
    }
    return sendIndex(reply)
  })
}
