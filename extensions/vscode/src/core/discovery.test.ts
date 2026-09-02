import { describe, expect, it } from 'vitest'
import { type DiscoveryDeps, discoverLive, parseRuntimeRecord } from './discovery.js'

const INPUT = {
  runtimeDir: '/repo/.agentic',
  repoRoot: '/repo',
  declaredUrl: 'http://127.0.0.1:4317',
}

function deps(overrides: Partial<DiscoveryDeps> & { readonly file?: string }): DiscoveryDeps {
  return {
    readFile: () => Promise.resolve(overrides.file),
    alive: () => true,
    fetchHealth: () => Promise.resolve({ service: '@agentic/server', repoRoot: '/repo' }),
    canonical: (path) => path,
    ...overrides,
  }
}

const RECORD = JSON.stringify({
  host: '127.0.0.1',
  port: 45311,
  pid: 4242,
  url: 'http://127.0.0.1:45311',
  startedAt: '2026-01-01T00:00:00.000Z',
  instanceId: 'abc',
  repoRoot: '/repo',
})

describe('parseRuntimeRecord', () => {
  it('registro malformado vale como ausente', () => {
    expect(parseRuntimeRecord('nao e json')).toBeUndefined()
    expect(parseRuntimeRecord('{"host":"x"}')).toBeUndefined()
    expect(parseRuntimeRecord('{"host":"x","port":0,"pid":1}')).toBeUndefined()
  })

  it('registro valido carrega pid, url e identidade', () => {
    expect(parseRuntimeRecord(RECORD)).toMatchObject({
      pid: 4242,
      url: 'http://127.0.0.1:45311',
      instanceId: 'abc',
    })
  })
})

describe('discoverLive', () => {
  it('registro vivo que responde pelo projeto e o control plane', async () => {
    const live = await discoverLive(INPUT, deps({ file: RECORD }))
    expect(live).toMatchObject({ url: 'http://127.0.0.1:45311', pid: 4242, source: 'runtime-file' })
  })

  it('registro de processo morto nao e control plane; o endereco declarado ainda e sondado', async () => {
    const urls: string[] = []
    const live = await discoverLive(
      INPUT,
      deps({
        file: RECORD,
        alive: () => false,
        fetchHealth: (url) => {
          urls.push(url)
          return Promise.resolve(undefined)
        },
      }),
    )
    expect(live).toBeUndefined()
    expect(urls).toEqual(['http://127.0.0.1:4317'])
  })

  it('registro de OUTRO projeto e ignorado', async () => {
    const live = await discoverLive(
      INPUT,
      deps({
        file: RECORD.replace('"/repo"', '"/outro"'),
        fetchHealth: () => Promise.resolve(undefined),
      }),
    )
    expect(live).toBeUndefined()
  })

  it('quem responde na porta mas nao e o control plane do projeto nao conta', async () => {
    expect(
      await discoverLive(
        INPUT,
        deps({ file: RECORD, fetchHealth: () => Promise.resolve({ service: 'outro' }) }),
      ),
    ).toBeUndefined()
    expect(
      await discoverLive(
        INPUT,
        deps({
          file: RECORD,
          fetchHealth: () => Promise.resolve({ service: '@agentic/server', repoRoot: '/outro' }),
        }),
      ),
    ).toBeUndefined()
    expect(
      await discoverLive(
        INPUT,
        deps({ file: RECORD, fetchHealth: () => Promise.resolve({ service: '@agentic/server' }) }),
      ),
    ).toBeUndefined()
  })

  it('sem registro, o endereco declarado que responde pelo projeto e um dono sem pid', async () => {
    const live = await discoverLive(INPUT, deps({}))
    expect(live).toEqual({
      url: 'http://127.0.0.1:4317',
      repoRoot: '/repo',
      source: 'declared-endpoint',
    })
  })

  it('comparacao de repoRoot e canonica', async () => {
    const live = await discoverLive(
      { ...INPUT, repoRoot: '/atalho' },
      deps({ file: RECORD, canonical: (path) => (path === '/atalho' ? '/repo' : path) }),
    )
    expect(live?.repoRoot).toBe('/repo')
  })
})
