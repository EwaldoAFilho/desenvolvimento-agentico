import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgenticApiError, AgenticClient } from './client.js'
import { PROJECT_HEADER } from './contracts.js'

let server: Server
let url = ''
const seen: { path: string; header: string | undefined }[] = []

beforeAll(async () => {
  server = createServer((request, response) => {
    seen.push({
      path: request.url ?? '',
      header: request.headers[PROJECT_HEADER] as string | undefined,
    })
    if (request.url === '/api/health') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ status: 'ok', service: '@agentic/server', repoRoot: '/repo' }))
      return
    }
    if (request.url?.startsWith('/api/missions/compile?file=')) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ missionId: 'X', ok: true, diagnostics: [], stats: {} }))
      return
    }
    response.statusCode = 409
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ error: { code: 'PROJECT_MISMATCH', message: 'outro projeto' } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('sem porta')
  url = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('AgenticClient', () => {
  it('toda requisicao carrega o repoRoot do projeto no header de guarda', async () => {
    const client = new AgenticClient(`${url}/`, '/repo')
    const health = await client.health()
    expect(health.service).toBe('@agentic/server')
    expect(seen.at(-1)).toEqual({ path: '/api/health', header: '/repo' })
  })

  it('o arquivo da mission viaja codificado na query', async () => {
    const client = new AgenticClient(url, '/repo')
    const report = await client.compile('.agentic/missions/A B.mission.yaml')
    expect(report.missionId).toBe('X')
    expect(seen.at(-1)?.path).toBe(
      '/api/missions/compile?file=.agentic%2Fmissions%2FA%20B.mission.yaml',
    )
  })

  it('erro do servidor vira AgenticApiError com codigo e status', async () => {
    const client = new AgenticClient(url, '/repo')
    const error = await client.runs().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AgenticApiError)
    expect(error).toMatchObject({ status: 409, code: 'PROJECT_MISMATCH', message: 'outro projeto' })
  })
})
