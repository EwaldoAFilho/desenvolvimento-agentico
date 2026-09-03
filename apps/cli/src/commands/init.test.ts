import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { compileMission, toCompileReport } from '@agentic/orchestrator'
import { parseGatesFile, parseMissionFile, parseProjectFile } from '@agentic/schemas'
import { afterEach, describe, expect, it } from 'vitest'
import { captureDeps, fakeRegistry, health } from '../__fixtures__/harness.js'
import { GITIGNORE_PATTERNS } from '../gitignore.js'
import { EXIT_OK } from '../result.js'
import { gatesTemplate, missionTemplate, planGates, projectTemplate } from '../templates.js'
import { type InitData, initCommand } from './init.js'
import { SERVER_COMMAND, type ServeData, serveCommand } from './serve.js'

const exec = promisify(execFile)

let dir: string | undefined

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

async function scratch(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'agentic-init-'))
  return dir
}

async function withScripts(root: string, scripts: Readonly<Record<string, string>>): Promise<void> {
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'alvo', scripts }), 'utf8')
}

/** Registry de mentira com as CLIs reais PRONTAS — nenhuma sonda de verdade em teste. */
function readyRegistry(...ids: readonly string[]): ReturnType<typeof fakeRegistry> {
  return fakeRegistry(
    ids.map((providerId) =>
      health({
        providerId,
        installed: true,
        ready: true,
        version: '1.2.3',
        detail: 'sessao ativa',
      }),
    ),
  )
}

/** `gates.yaml` do humano, com os perfis que ELE escolheu. */
function gatesYaml(profiles: Readonly<Record<string, string>>): string {
  const linhas = ['apiVersion: agentic/v1', 'kind: Gates', 'profiles:']
  for (const [id, run] of Object.entries(profiles)) {
    linhas.push(`  ${id}:`, '    commands:', `      - run: ${run}`)
  }
  return `${linhas.join('\n')}\n`
}

async function dataOf(root: string, deps = captureDeps({ cwd: root }).deps): Promise<InitData> {
  const result = await initCommand({}, deps)
  return result.data as InitData
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

  it('o nome do projeto vem da pasta, nao de um placeholder', async () => {
    const root = await scratch()
    await initCommand({ dir: 'minha-app' }, captureDeps({ cwd: root }).deps)
    const text = await readFile(join(root, 'minha-app/.agentic/project.yaml'), 'utf8')
    const parsed = parseProjectFile(text)

    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.value.project.name).toBe('minha-app')
  })

  it('--json descreve o que foi criado', async () => {
    const root = await scratch()
    const captured = captureDeps({ cwd: root })
    const result = await initCommand({ json: true }, captured.deps)

    expect(captured.stdout()).toBe('')
    expect(result.data).toMatchObject({ created: expect.any(Array) })
  })
})

describe('init: .gitignore', () => {
  it('cria o arquivo quando nao existe, com os padroes de estado local', async () => {
    const root = await scratch()
    const data = await dataOf(root)
    const text = await readFile(join(root, '.gitignore'), 'utf8')

    expect(data.gitignore).toEqual([...GITIGNORE_PATTERNS])
    for (const pattern of GITIGNORE_PATTERNS) expect(text).toContain(pattern)
    // O que E versionado nunca pode ser ignorado: o contrato do projeto e revisavel.
    expect(text).not.toContain('.agentic/project.yaml')
    expect(text).not.toContain('.agentic/gates.yaml')
    expect(text).not.toContain('.agentic/missions')
    expect(text.split('\n')).not.toContain('.agentic/')
  })

  it('preserva o arquivo existente e acrescenta so o que falta', async () => {
    const root = await scratch()
    const original = '# meu projeto\nnode_modules/\n.agentic/runs/\n'
    await writeFile(join(root, '.gitignore'), original, 'utf8')

    const data = await dataOf(root)
    const text = await readFile(join(root, '.gitignore'), 'utf8')

    expect(text.startsWith(original)).toBe(true)
    expect(text).toContain('# meu projeto')
    expect(data.gitignore).not.toContain('.agentic/runs/')
    expect(data.gitignore).toContain('.agentic/state.db')
    // Nada duplicado: o padrao que ja existia aparece uma vez so.
    expect(text.split('\n').filter((line) => line === '.agentic/runs/')).toHaveLength(1)
  })

  it('e idempotente: o segundo init nao acrescenta nem duplica nada', async () => {
    const root = await scratch()
    await dataOf(root)
    const primeiro = await readFile(join(root, '.gitignore'), 'utf8')

    const segundo = await dataOf(root)

    expect(segundo.gitignore).toEqual([])
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe(primeiro)
  })

  it('num repositorio git de verdade, so o que e versionavel aparece no status', async () => {
    const root = await scratch()
    const git = (...args: string[]): Promise<unknown> => exec('git', args, { cwd: root })
    await git('init', '-q', '-b', 'main')
    await git('config', 'user.email', 'init@example.invalid')
    await git('config', 'user.name', 'Init')

    await dataOf(root)
    // Artefatos que o control plane cria em runtime, materializados a mao.
    await writeFile(join(root, '.agentic/state.db'), '', 'utf8')
    await writeFile(join(root, '.agentic/state.db-wal'), '', 'utf8')
    await writeFile(join(root, '.agentic/state.db-shm'), '', 'utf8')
    await writeFile(join(root, '.agentic/control-plane.json'), '{}', 'utf8')
    await writeFile(join(root, '.agentic/control-plane.lock.db'), '', 'utf8')
    await writeFile(join(root, '.agentic/control-plane.lock.db-wal'), '', 'utf8')
    await mkdir(join(root, '.agentic/runs/01'), { recursive: true })
    await writeFile(join(root, '.agentic/runs/01/evento.json'), '{}', 'utf8')
    await mkdir(join(root, '.agentic/worktrees/T01-a1'), { recursive: true })
    await writeFile(join(root, '.agentic/worktrees/T01-a1/arquivo.txt'), 'x', 'utf8')

    const { stdout } = await exec('git', ['status', '--porcelain'], { cwd: root })
    const paths = stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => line.slice(3))

    expect(paths.sort()).toEqual(['.agentic/', '.gitignore'])
    const { stdout: untracked } = await exec(
      'git',
      ['status', '--porcelain', '--untracked-files=all'],
      { cwd: root },
    )
    expect(untracked).toContain('.agentic/project.yaml')
    expect(untracked).toContain('.agentic/gates.yaml')
    expect(untracked).toContain('.agentic/missions/EXEMPLO-001.mission.yaml')
    expect(untracked).not.toContain('state.db')
    expect(untracked).not.toContain('control-plane')
    expect(untracked).not.toContain('.agentic/runs/')
    expect(untracked).not.toContain('.agentic/worktrees/')
  })
})

describe('init: gates detectados', () => {
  it('A. build + test + lint + typecheck viram gates com os comandos do projeto', async () => {
    const root = await scratch()
    await withScripts(root, {
      build: 'tsc -b',
      test: 'vitest run',
      lint: 'biome check .',
      typecheck: 'tsc --noEmit',
    })
    const data = await dataOf(root)
    const gates = parseGatesFile(await readFile(join(root, '.agentic/gates.yaml'), 'utf8'))

    expect(gates.ok).toBe(true)
    expect(data.gates).toContain('npm run lint')
    expect(data.gates).toContain('npm run typecheck')
    expect(data.gates).toContain('npm run test')
    expect(data.gates).toContain('npm run build')
    // Zero comando inventado: `verify` nao existe no projeto, entao nao existe no gate.
    expect(data.gates.join('\n')).not.toContain('npm run verify')
  })

  it('B. so `test` detectado: so `test` configurado', async () => {
    const root = await scratch()
    await withScripts(root, { test: 'node --test' })
    const data = await dataOf(root)

    expect(data.gates).toEqual(['npm run test', 'npm run test'])
    const text = await readFile(join(root, '.agentic/gates.yaml'), 'utf8')
    expect(text).not.toContain('npm run lint')
    expect(text).not.toContain('npm run build')
  })

  it('C. nenhum script relevante: nenhum gate, e a configuracao continua valida', async () => {
    const root = await scratch()
    await withScripts(root, { start: 'node server.js' })
    const data = await dataOf(root)
    const gatesText = await readFile(join(root, '.agentic/gates.yaml'), 'utf8')
    const projectText = await readFile(join(root, '.agentic/project.yaml'), 'utf8')

    expect(data.gates).toEqual([])
    expect(gatesText).not.toContain('npm run')
    expect(parseGatesFile(gatesText).ok).toBe(true)
    const project = parseProjectFile(projectText)
    expect(project.ok).toBe(true)
    expect(project.ok && project.value.gates.missionGate).toBeUndefined()
  })

  it('D. projeto que nao e Node: nenhum comando npm inventado', async () => {
    const root = await scratch()
    await writeFile(join(root, 'Cargo.toml'), '[package]\nname = "x"\n', 'utf8')
    const data = await dataOf(root)

    expect(data.gates).toEqual([])
    expect(await readFile(join(root, '.agentic/gates.yaml'), 'utf8')).not.toContain('npm')
  })

  it('`verify` presente vira o mission gate sozinho', async () => {
    const root = await scratch()
    await withScripts(root, { lint: 'x', test: 'y', verify: 'npm run lint && npm run test' })
    await dataOf(root)
    const parsed = parseGatesFile(await readFile(join(root, '.agentic/gates.yaml'), 'utf8'))

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.profiles.mission?.commands.map((c) => c.run)).toEqual(['npm run verify'])
    expect(parsed.value.profiles.unit?.commands.map((c) => c.run)).toEqual([
      'npm run lint',
      'npm run test',
    ])
  })

  it('`package.json` ilegivel nao inventa gate nem derruba o init', async () => {
    const root = await scratch()
    await writeFile(join(root, 'package.json'), '{ nao e json', 'utf8')
    const data = await dataOf(root)

    expect(data.gates).toEqual([])
  })
})

describe('init: gates.yaml preexistente manda', () => {
  it('perfis proprios: a missao e o project.yaml nao apontam gates que nao existem', async () => {
    const root = await scratch()
    await withScripts(root, { test: 'node --test', lint: 'x' })
    await mkdir(join(root, '.agentic'), { recursive: true })
    await writeFile(join(root, '.agentic/gates.yaml'), gatesYaml({ custom: 'make check' }), 'utf8')

    const data = await dataOf(root)
    const projectText = await readFile(join(root, '.agentic/project.yaml'), 'utf8')
    const missionText = await readFile(
      join(root, '.agentic/missions/EXEMPLO-001.mission.yaml'),
      'utf8',
    )
    const gatesText = await readFile(join(root, '.agentic/gates.yaml'), 'utf8')

    expect(data.skipped).toContain('.agentic/gates.yaml')
    expect(gatesText).toContain('make check')
    // O conjunto tem de COMPILAR, e nao so passar em cada schema isoladamente.
    const report = toCompileReport(
      compileMission({ missionText, projectFile: projectText, gatesFile: gatesText }),
      missionText,
    )
    expect(report.diagnostics).toEqual([])
    expect(report.ok).toBe(true)
  })

  it('perfis `unit` e `mission` proprios continuam sendo referenciados', async () => {
    const root = await scratch()
    await mkdir(join(root, '.agentic'), { recursive: true })
    await writeFile(
      join(root, '.agentic/gates.yaml'),
      gatesYaml({ unit: 'make test', mission: 'make all' }),
      'utf8',
    )

    await dataOf(root)
    const projectText = await readFile(join(root, '.agentic/project.yaml'), 'utf8')
    const missionText = await readFile(
      join(root, '.agentic/missions/EXEMPLO-001.mission.yaml'),
      'utf8',
    )
    const gatesText = await readFile(join(root, '.agentic/gates.yaml'), 'utf8')

    expect(projectText).toContain('missionGate: mission')
    const report = toCompileReport(
      compileMission({ missionText, projectFile: projectText, gatesFile: gatesText }),
      missionText,
    )
    expect(report.diagnostics).toEqual([])
  })

  it('gates.yaml ilegivel: preserva e nao aponta gate nenhum', async () => {
    const root = await scratch()
    await withScripts(root, { test: 'node --test' })
    await mkdir(join(root, '.agentic'), { recursive: true })
    await writeFile(join(root, '.agentic/gates.yaml'), 'isto: [nao\n  e: valido\n', 'utf8')

    await dataOf(root)
    const projectText = await readFile(join(root, '.agentic/project.yaml'), 'utf8')
    const missionText = await readFile(
      join(root, '.agentic/missions/EXEMPLO-001.mission.yaml'),
      'utf8',
    )

    expect(projectText).not.toContain('missionGate:')
    expect(missionText).not.toContain('gate:')
  })
})

describe('init: fornecedores observados', () => {
  it('sem CLI real PRONTA, o registry fica de ensaio e a saida nomeia a troca', async () => {
    const root = await scratch()
    const captured = captureDeps({ cwd: root })
    const result = await initCommand({}, captured.deps)
    const data = result.data as InitData
    const text = await readFile(join(root, '.agentic/project.yaml'), 'utf8')

    expect(data.rehearsalOnly).toBe(true)
    expect(data.defaultProvider).toBe('mock')
    expect(captured.stdout()).toContain('nenhuma CLI de agente esta PRONTA')
    expect(captured.stdout()).toContain('providers.default')
    // O ensaio nao se disfarca de revisor: ele nem declara o papel.
    const parsed = parseProjectFile(text)
    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.value.providers.registry.mock?.roles).toEqual(['executor'])
  })

  it('com CLI real PRONTA, o mock sai do registry e o executor padrao e a CLI', async () => {
    const root = await scratch()
    const captured = captureDeps({ cwd: root, registry: () => readyRegistry('claude-code') })
    const result = await initCommand({}, captured.deps)
    const data = result.data as InitData
    const parsed = parseProjectFile(await readFile(join(root, '.agentic/project.yaml'), 'utf8'))

    expect(data.rehearsalOnly).toBe(false)
    expect(data.defaultProvider).toBe('claude-code')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(Object.keys(parsed.value.providers.registry)).toEqual(['claude-code'])
    expect(parsed.value.providers.registry['claude-code']?.kind).toBe('local-cli')
    expect(captured.stdout()).not.toContain('nenhuma CLI de agente esta PRONTA')
  })

  it('duas CLIs PRONTAS entram as duas; a primeira observada e o default', async () => {
    const root = await scratch()
    const captured = captureDeps({
      cwd: root,
      registry: () => readyRegistry('codex', 'claude-code'),
    })
    await initCommand({}, captured.deps)
    const parsed = parseProjectFile(await readFile(join(root, '.agentic/project.yaml'), 'utf8'))

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(Object.keys(parsed.value.providers.registry).sort()).toEqual(['claude-code', 'codex'])
    expect(parsed.value.providers.default).toBe('claude-code')
  })

  it('CLI instalada mas sem sessao NAO entra, e o motivo aparece', async () => {
    const root = await scratch()
    const captured = captureDeps({
      cwd: root,
      registry: () =>
        fakeRegistry([
          health({
            providerId: 'claude-code',
            installed: true,
            ready: false,
            version: '1.0',
            detail: 'sessao nao autenticada',
          }),
        ]),
    })
    const result = await initCommand({}, captured.deps)
    const data = result.data as InitData

    expect(data.rehearsalOnly).toBe(true)
    expect(data.providers).toEqual([
      { providerId: 'claude-code', state: 'NOT_READY', detail: 'sessao nao autenticada' },
    ])
    expect(captured.stdout()).toContain('NOT_READY')
  })
})

describe('init: modelos gerados', () => {
  const cenarios = [
    { nome: 'com gates e CLI real', gates: ['lint', 'test', 'verify'], providers: 1 },
    { nome: 'sem gates', gates: [] as string[], providers: 1 },
    { nome: 'sem CLI real', gates: ['test'], providers: 0 },
    { nome: 'sem gates e sem CLI real', gates: [] as string[], providers: 0 },
  ]

  for (const cenario of cenarios) {
    it(`passam nos schemas e compilam sem diagnostico — ${cenario.nome}`, () => {
      const plan = planGates(cenario.gates.map((id) => ({ id: id as never, run: `npm run ${id}` })))
      const projectFile = projectTemplate({
        name: 'alvo',
        providers:
          cenario.providers === 0
            ? []
            : [
                {
                  id: 'claude-code',
                  command: 'claude',
                  maxConcurrent: 3,
                  versionArgs: ['--version'],
                },
              ],
        ...(plan.missionGate === undefined ? {} : { missionGate: plan.missionGate }),
      })
      const gatesFile = gatesTemplate(plan)
      const missionText = missionTemplate({
        ...(plan.taskGate === undefined ? {} : { taskGate: plan.taskGate }),
        ...(plan.missionGate === undefined ? {} : { missionGate: plan.missionGate }),
      })

      expect(parseProjectFile(projectFile).ok).toBe(true)
      expect(parseGatesFile(gatesFile).ok).toBe(true)
      expect(parseMissionFile(missionText).ok).toBe(true)

      const report = toCompileReport(
        compileMission({ missionText, projectFile, gatesFile }),
        missionText,
      )
      expect(report.diagnostics).toEqual([])
      expect(report.ok).toBe(true)
      expect(report.stats.tasks).toBe(4)
    })
  }
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
