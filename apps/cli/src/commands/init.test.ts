import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileMission, toCompileReport } from '@agentic/orchestrator'
import { parseGatesFile, parseMissionFile, parseProjectFile } from '@agentic/schemas'
import { afterEach, describe, expect, it } from 'vitest'
import { captureDeps } from '../__fixtures__/harness.js'
import { EXIT_OK } from '../result.js'
import { GATES_TEMPLATE, MISSION_TEMPLATE, PROJECT_TEMPLATE } from '../templates.js'
import { type InitData, initCommand } from './init.js'
import { SERVER_COMMAND, type ServeData, serveCommand } from './serve.js'

let dir: string | undefined

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

async function scratch(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'agentic-init-'))
  return dir
}

describe('init', () => {
  it('cria os tres arquivos do projeto', async () => {
    const root = await scratch()
    const captured = captureDeps({ cwd: root })
    const result = await initCommand({}, captured.deps)
    const data = result.data as InitData

    expect(result.exitCode).toBe(EXIT_OK)
    expect(data.created).toEqual([
      '.agentic/project.yaml',
      '.agentic/gates.yaml',
      '.agentic/missions/EXEMPLO-001.mission.yaml',
    ])
    expect(data.skipped).toEqual([])
  })

  it('nunca sobrescreve arquivo existente', async () => {
    const root = await scratch()
    const captured = captureDeps({ cwd: root })
    await initCommand({}, captured.deps)
    await writeFile(join(root, '.agentic', 'gates.yaml'), '# meu\n', 'utf8')

    const again = await initCommand({}, captureDeps({ cwd: root }).deps)
    const data = again.data as InitData

    expect(data.created).toEqual([])
    expect(data.skipped).toHaveLength(3)
    expect(await readFile(join(root, '.agentic', 'gates.yaml'), 'utf8')).toBe('# meu\n')
  })

  it('cria em um diretorio informado', async () => {
    const root = await scratch()
    const captured = captureDeps({ cwd: root })
    const result = await initCommand({ dir: 'sub/projeto' }, captured.deps)

    expect(result.exitCode).toBe(EXIT_OK)
    expect((result.data as InitData).baseDir).toBe(join(root, 'sub/projeto/.agentic'))
  })

  it('os modelos gerados passam nos schemas', () => {
    expect(parseProjectFile(PROJECT_TEMPLATE).ok).toBe(true)
    expect(parseGatesFile(GATES_TEMPLATE).ok).toBe(true)
    expect(parseMissionFile(MISSION_TEMPLATE).ok).toBe(true)
  })

  it('a missao de exemplo compila sem nenhum diagnostico', () => {
    const result = compileMission({
      missionText: MISSION_TEMPLATE,
      projectFile: PROJECT_TEMPLATE,
      gatesFile: GATES_TEMPLATE,
    })
    const report = toCompileReport(result, MISSION_TEMPLATE)

    expect(report.ok).toBe(true)
    expect(report.diagnostics).toEqual([])
    expect(report.stats.tasks).toBe(4)
  })

  it('--json descreve o que foi criado', async () => {
    const root = await scratch()
    const captured = captureDeps({ cwd: root })
    const result = await initCommand({ json: true }, captured.deps)

    expect(captured.stdout()).toBe('')
    expect(result.data).toMatchObject({ created: expect.any(Array) })
  })
})

describe('serve', () => {
  it('sobe o control plane sem run ativo (ARCHITECTURE 4)', async () => {
    const root = await scratch()
    await initCommand({}, captureDeps({ cwd: root }).deps)

    const bootCalls: unknown[] = []
    let closed = false
    const captured = captureDeps({
      cwd: root,
      waitForShutdown: () => Promise.resolve(),
      bootServer: (config) => {
        bootCalls.push(config)
        return Promise.resolve({
          url: 'http://127.0.0.1:4317',
          close: () => {
            closed = true
            return Promise.resolve()
          },
        })
      },
    })

    const result = await serveCommand({}, captured.deps)
    const data = result.data as ServeData

    expect(result.exitCode).toBe(0)
    expect(data.running).toBe(true)
    expect(data.endpoint).toBe('http://127.0.0.1:4317')
    expect(bootCalls).toHaveLength(1)
    expect(closed).toBe(true)
    expect(captured.stdout()).toContain('control plane no ar')
  })

  it('stop que nao devolve a posse NAO sai: espera outro sinal e tenta de novo (I15)', async () => {
    const root = await scratch()
    await initCommand({}, captureDeps({ cwd: root }).deps)
    let closes = 0
    let sinais = 0
    const captured = captureDeps({
      cwd: root,
      // Dois sinais: o primeiro encontra efeito vivo (close falha), o segundo encerra.
      waitForShutdown: () => {
        sinais += 1
        return Promise.resolve()
      },
      bootServer: () =>
        Promise.resolve({
          url: 'http://127.0.0.1:4317',
          close: () => {
            closes += 1
            return closes === 1
              ? Promise.reject(new Error('orquestrador nao encerrou dentro do prazo'))
              : Promise.resolve()
          },
        }),
    })

    const result = await serveCommand({}, captured.deps)

    expect(result.exitCode).toBe(0)
    expect(closes).toBe(2)
    expect(sinais).toBe(2)
    expect(captured.stdout()).toContain('nao encerrou limpo')
    expect(captured.stdout()).toContain('continua com este processo')
  })

  it('sinal que chega DURANTE o boot e atendido logo depois, pelo mesmo stop', async () => {
    const root = await scratch()
    await initCommand({}, captureDeps({ cwd: root }).deps)
    const ordem: string[] = []
    const captured = captureDeps({
      cwd: root,
      // O sinal e assinado antes de subir e "chega" antes de o boot terminar.
      waitForShutdown: () => {
        ordem.push('sinal-assinado')
        return Promise.resolve()
      },
      bootServer: async () => {
        ordem.push('boot-comecou')
        await new Promise((resolve) => setTimeout(resolve, 30))
        ordem.push('boot-terminou')
        return {
          url: 'http://127.0.0.1:4317',
          close: () => {
            ordem.push('close')
            return Promise.resolve()
          },
        }
      },
    })

    const result = await serveCommand({}, captured.deps)

    expect(result.exitCode).toBe(0)
    expect(ordem).toEqual(['sinal-assinado', 'boot-comecou', 'boot-terminou', 'close'])
  })

  it('CONTROLE: falha ao subir vira SERVER_UNAVAILABLE com a alternativa', async () => {
    const root = await scratch()
    await initCommand({}, captureDeps({ cwd: root }).deps)

    const captured = captureDeps({
      cwd: root,
      bootServer: () => Promise.reject(new Error('EADDRINUSE 4317')),
    })

    const result = await serveCommand({}, captured.deps)
    const data = result.data as ServeData

    expect(result.exitCode).toBe(1)
    expect(result.error?.code).toBe('SERVER_UNAVAILABLE')
    expect(result.error?.message).toContain('EADDRINUSE')
    expect(data.running).toBe(false)
    expect(captured.stdout()).toContain(SERVER_COMMAND)
  })

  it('com control plane ja no ar, reporta o endereco e sai 0', async () => {
    const root = await scratch()
    await initCommand({}, captureDeps({ cwd: root }).deps)
    const captured = captureDeps({
      cwd: root,
      connect: (endpoint) =>
        Promise.resolve({ endpoint, send: () => Promise.reject(new Error('nao usado')) }),
    })
    const result = await serveCommand({ port: 5000 }, captured.deps)

    expect(result.exitCode).toBe(EXIT_OK)
    expect((result.data as ServeData).endpoint).toBe('http://127.0.0.1:5000')
    expect(captured.stdout()).toContain('ja no ar')
  })
})
