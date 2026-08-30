import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServerHarness, type ServerHarness } from './__fixtures__/harness.js'
import { isApiPath, MISSING_BUILD_MESSAGE, pathnameOf, safeJoin } from './static.js'

let harness: ServerHarness | undefined

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

async function withDashboard(active: ServerHarness): Promise<void> {
  const dist = join(active.root, 'apps', 'web', 'dist')
  await mkdir(join(dist, 'assets'), { recursive: true })
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>DAG</title>', 'utf8')
  await writeFile(join(dist, 'assets', 'app.js'), 'export const app = 1\n', 'utf8')
}

describe('caminhos', () => {
  it('reconhece o que e rota de API', () => {
    expect(isApiPath('/api/runs')).toBe(true)
    expect(isApiPath('/api')).toBe(true)
    expect(isApiPath('/api/runs?since=1')).toBe(true)
    expect(isApiPath('/apifake')).toBe(false)
    expect(isApiPath('/runs/123')).toBe(false)
  })

  it('separa a querystring do caminho', () => {
    expect(pathnameOf('/a/b?c=1')).toBe('/a/b')
    expect(pathnameOf('/a/b')).toBe('/a/b')
  })

  it('nao deixa o pedido sair do diretorio servido', () => {
    expect(safeJoin('/srv/dist', '/index.html')).toBe('/srv/dist/index.html')
    expect(safeJoin('/srv/dist', '/../../etc/passwd')).toBe('/srv/dist/etc/passwd')
    expect(safeJoin('/srv/dist', '/%2e%2e/%2e%2e/etc/passwd')).toBe('/srv/dist/etc/passwd')
  })
})

describe('estaticos do dashboard', () => {
  it('sem build responde com a orientacao, sem quebrar', async () => {
    harness = await createServerHarness()
    const response = await harness.app.inject({ method: 'GET', url: '/' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.payload).toContain(MISSING_BUILD_MESSAGE)
  })

  it('sem build a API continua respondendo', async () => {
    harness = await createServerHarness()
    const response = await harness.app.inject({ method: 'GET', url: '/api/health' })
    expect(response.statusCode).toBe(200)
  })

  it('com build serve o index.html', async () => {
    harness = await createServerHarness()
    await withDashboard(harness)
    const response = await harness.app.inject({ method: 'GET', url: '/' })
    expect(response.statusCode).toBe(200)
    expect(response.payload).toContain('<title>DAG</title>')
  })

  it('serve o asset com o content-type certo', async () => {
    harness = await createServerHarness()
    await withDashboard(harness)
    const response = await harness.app.inject({ method: 'GET', url: '/assets/app.js' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/javascript')
    expect(response.payload).toContain('export const app = 1')
  })

  it('fallback SPA: rota do cliente cai no index.html', async () => {
    harness = await createServerHarness()
    await withDashboard(harness)
    const response = await harness.app.inject({ method: 'GET', url: '/runs/01J/tasks/T01' })
    expect(response.statusCode).toBe(200)
    expect(response.payload).toContain('<title>DAG</title>')
  })

  it('o fallback SPA NAO engole rota /api inexistente', async () => {
    harness = await createServerHarness()
    await withDashboard(harness)
    const response = await harness.app.inject({ method: 'GET', url: '/api/nao-existe' })
    expect(response.statusCode).toBe(404)
    expect(response.headers['content-type']).toContain('application/json')
    expect(response.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND')
  })

  it('POST em rota /api inexistente tambem responde 404 JSON', async () => {
    harness = await createServerHarness()
    await withDashboard(harness)
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/runs/nada/desconhecido',
      payload: {},
    })
    expect(response.statusCode).toBe(404)
    expect(response.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND')
  })

  it('metodo nao-GET fora de /api nao vira index.html', async () => {
    harness = await createServerHarness()
    await withDashboard(harness)
    const response = await harness.app.inject({ method: 'PUT', url: '/qualquer', payload: {} })
    expect(response.statusCode).toBe(404)
  })

  it('travessia de caminho nao le arquivo fora do dist', async () => {
    harness = await createServerHarness()
    await withDashboard(harness)
    const response = await harness.app.inject({
      method: 'GET',
      url: '/../../.agentic/project.yaml',
    })
    expect(response.payload).not.toContain('kind: Project')
  })
})
