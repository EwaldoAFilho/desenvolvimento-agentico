import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CONTROL_PLANE_FILE,
  controlPlaneFilePath,
  discoverControlPlane,
  parseControlPlaneRuntime,
  processAlive,
  readControlPlaneFile,
  removeControlPlaneFile,
  runtimeDirOf,
  writeControlPlaneFile,
} from './control-plane-file.js'

const exec = promisify(execFile)

let dir: string | undefined

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

async function runtimeDir(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'agentic-runtime-'))
  return dir
}

/** Pid de um processo que JA morreu: o kernel confirma a ausencia, o teste nao adivinha. */
async function deadPid(): Promise<number> {
  const { stdout } = await exec(nodeProcess.execPath, [
    '-e',
    'process.stdout.write(String(process.pid))',
  ])
  return Number.parseInt(stdout, 10)
}

describe('registro de runtime do control plane', () => {
  it('grava host, porta, pid e url em .agentic/control-plane.json', async () => {
    const base = await runtimeDir()
    const written = await writeControlPlaneFile(base, { host: '127.0.0.1', port: 4317 })

    expect(written).toMatchObject({ host: '127.0.0.1', port: 4317, url: 'http://127.0.0.1:4317' })
    expect(written.pid).toBe(nodeProcess.pid)
    const raw = JSON.parse(await readFile(join(base, CONTROL_PLANE_FILE), 'utf8')) as unknown
    expect(raw).toMatchObject({ port: 4317, pid: nodeProcess.pid })
  })

  it('o caminho fica dentro do diretorio local do projeto', () => {
    expect(controlPlaneFilePath('/projeto/.agentic')).toBe('/projeto/.agentic/control-plane.json')
    expect(runtimeDirOf('/projeto')).toBe('/projeto/.agentic')
  })

  it('le de volta exatamente o que gravou', async () => {
    const base = await runtimeDir()
    await writeControlPlaneFile(base, { host: '127.0.0.1', port: 5000, pid: 42 })

    expect(await readControlPlaneFile(base)).toMatchObject({ port: 5000, pid: 42 })
  })

  it('arquivo ausente e leitura vazia, nao excecao', async () => {
    expect(await readControlPlaneFile(await runtimeDir())).toBeUndefined()
  })

  it('JSON quebrado vale o mesmo que arquivo ausente', async () => {
    const base = await runtimeDir()
    await writeFile(join(base, CONTROL_PLANE_FILE), '{ isto nao e json', 'utf8')

    expect(await readControlPlaneFile(base)).toBeUndefined()
  })

  it('registro sem porta valida e recusado', () => {
    expect(parseControlPlaneRuntime({ host: '127.0.0.1', port: 0, pid: 1 })).toBeUndefined()
    expect(parseControlPlaneRuntime({ host: '127.0.0.1', port: 70_000, pid: 1 })).toBeUndefined()
    expect(parseControlPlaneRuntime({ host: '', port: 4317, pid: 1 })).toBeUndefined()
    expect(parseControlPlaneRuntime({ host: '127.0.0.1', port: 4317, pid: 0 })).toBeUndefined()
    expect(parseControlPlaneRuntime('nada')).toBeUndefined()
  })

  it('deriva a url quando o registro nao traz uma', () => {
    const parsed = parseControlPlaneRuntime({ host: '127.0.0.1', port: 4317, pid: 7 })
    expect(parsed?.url).toBe('http://127.0.0.1:4317')
  })
})

describe('processo vivo', () => {
  it('o proprio processo esta vivo', () => {
    expect(processAlive(nodeProcess.pid)).toBe(true)
  })

  it('pid de processo encerrado nao esta vivo', async () => {
    expect(processAlive(await deadPid())).toBe(false)
  })

  it('pid absurdo nao esta vivo', () => {
    expect(processAlive(0)).toBe(false)
    expect(processAlive(-1)).toBe(false)
    expect(processAlive(Number.NaN)).toBe(false)
  })
})

describe('descoberta', () => {
  it('processo VIVO: devolve o registro e mantem o arquivo', async () => {
    const base = await runtimeDir()
    await writeControlPlaneFile(base, { host: '127.0.0.1', port: 4317 })

    const found = await discoverControlPlane(base)
    expect(found?.url).toBe('http://127.0.0.1:4317')
    expect(await readControlPlaneFile(base)).toBeDefined()
  })

  it('processo MORTO: nao ha control plane, e o registro e limpo', async () => {
    const base = await runtimeDir()
    await writeControlPlaneFile(base, { host: '127.0.0.1', port: 4317, pid: await deadPid() })

    expect(await discoverControlPlane(base)).toBeUndefined()
    // Limpou: a segunda consulta nem precisa sondar o pid de novo.
    expect(await readControlPlaneFile(base)).toBeUndefined()
  })

  it('EPERM conta como vivo: existe e nao e nosso', async () => {
    const base = await runtimeDir()
    await writeControlPlaneFile(base, { host: '127.0.0.1', port: 4317, pid: 999_001 })

    const found = await discoverControlPlane(base, {
      alive: (pid) => {
        expect(pid).toBe(999_001)
        return true
      },
    })
    expect(found?.pid).toBe(999_001)
  })

  it('sem arquivo nenhum, a resposta e "nao ha control plane"', async () => {
    expect(await discoverControlPlane(await runtimeDir())).toBeUndefined()
  })
})

describe('remocao do registro', () => {
  it('remove sem condicao quando nao ha expectativa', async () => {
    const base = await runtimeDir()
    await writeControlPlaneFile(base, { host: '127.0.0.1', port: 4317 })

    expect(await removeControlPlaneFile(base)).toBe(true)
    expect(await readControlPlaneFile(base)).toBeUndefined()
  })

  it('NAO remove o registro de outro processo que subiu depois', async () => {
    const base = await runtimeDir()
    await writeControlPlaneFile(base, { host: '127.0.0.1', port: 4317, pid: 4242 })

    // Quem esta encerrando e o pid 111: o arquivo no disco pertence a outro.
    expect(await removeControlPlaneFile(base, { pid: 111, port: 4317 })).toBe(false)
    expect(await readControlPlaneFile(base)).toMatchObject({ pid: 4242 })
  })

  it('NAO remove quando a porta mudou, mesmo com o pid igual', async () => {
    const base = await runtimeDir()
    await writeControlPlaneFile(base, { host: '127.0.0.1', port: 4400, pid: 4242 })

    expect(await removeControlPlaneFile(base, { pid: 4242, port: 4317 })).toBe(false)
    expect(await readControlPlaneFile(base)).toBeDefined()
  })

  it('remove quando pid e porta batem', async () => {
    const base = await runtimeDir()
    await writeControlPlaneFile(base, { host: '127.0.0.1', port: 4317, pid: 4242 })

    expect(await removeControlPlaneFile(base, { pid: 4242, port: 4317 })).toBe(true)
    expect(await readControlPlaneFile(base)).toBeUndefined()
  })
})
