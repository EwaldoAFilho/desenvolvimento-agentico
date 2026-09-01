import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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

describe('identidade da instancia no registro de descoberta', () => {
  it('grava e devolve o instanceId de quem publicou', async () => {
    const base = await runtimeDir()
    await writeControlPlaneFile(base, {
      host: '127.0.0.1',
      port: 4317,
      pid: 4242,
      instanceId: 'inst-a',
      repoRoot: '/projeto',
    })

    expect(await readControlPlaneFile(base)).toMatchObject({
      instanceId: 'inst-a',
      repoRoot: '/projeto',
    })
  })

  it('registro de uma versao anterior, sem instanceId, continua legivel', async () => {
    const base = await runtimeDir()
    const antigo = { host: '127.0.0.1', port: 4317, pid: 4242, url: 'http://127.0.0.1:4317' }
    await writeFile(controlPlaneFilePath(base), JSON.stringify(antigo), 'utf8')

    const lido = await readControlPlaneFile(base)
    expect(lido).toMatchObject({ pid: 4242 })
    expect(lido?.instanceId).toBeUndefined()
  })

  it('o processo ANTIGO nao apaga o registro da instancia NOVA', async () => {
    const base = await runtimeDir()
    // Quem esta no disco e a instancia nova; ela ate reaproveitou pid e porta do anterior.
    await writeControlPlaneFile(base, {
      host: '127.0.0.1',
      port: 4317,
      pid: 4242,
      instanceId: 'inst-nova',
    })

    expect(await removeControlPlaneFile(base, { instanceId: 'inst-velha' })).toBe(false)
    expect(await readControlPlaneFile(base)).toMatchObject({ instanceId: 'inst-nova' })
  })

  it('remove quando a identidade confere, ainda que pid e porta tenham mudado', async () => {
    const base = await runtimeDir()
    await writeControlPlaneFile(base, {
      host: '127.0.0.1',
      port: 4400,
      pid: 999,
      instanceId: 'inst-a',
    })

    expect(await removeControlPlaneFile(base, { instanceId: 'inst-a' })).toBe(true)
    expect(await readControlPlaneFile(base)).toBeUndefined()
  })

  it('a publicacao e atomica: nenhum leitor ve JSON pela metade', async () => {
    const base = await runtimeDir()
    // Vinte publicacoes seguidas, lidas entre uma e outra: o arquivo aparece inteiro ou nao
    // aparece. A extensao do editor vai ler este arquivo sem coordenacao nenhuma.
    for (let i = 0; i < 20; i += 1) {
      const escrita = writeControlPlaneFile(base, {
        host: '127.0.0.1',
        port: 4300 + i,
        pid: 1000 + i,
        instanceId: `inst-${i}`,
      })
      const texto = await readFile(controlPlaneFilePath(base), 'utf8').catch(() => undefined)
      if (texto !== undefined) expect(() => JSON.parse(texto)).not.toThrow()
      await escrita
    }
    expect(await readControlPlaneFile(base)).toMatchObject({ instanceId: 'inst-19' })
  })

  it('nao deixa arquivo temporario para tras', async () => {
    const base = await runtimeDir()
    await writeControlPlaneFile(base, { host: '127.0.0.1', port: 4317, instanceId: 'inst-a' })

    const restos = (await readdir(base)).filter((nome) => nome.endsWith('.tmp'))
    expect(restos).toEqual([])
  })

  it('a limpeza de registro morto so remove o registro que foi lido', async () => {
    const base = await runtimeDir()
    await writeControlPlaneFile(base, {
      host: '127.0.0.1',
      port: 4317,
      pid: 4242,
      instanceId: 'inst-morta',
    })

    // A sonda diz que o pid morreu; e EXATAMENTE nesse intervalo — entre ler o registro e
    // limpa-lo — um control plane NOVO publica o dele. A escrita e sincrona para que a
    // ordem seja a do teste, e nao a do agendador.
    const encontrado = await discoverControlPlane(base, {
      alive: () => {
        writeFileSync(
          controlPlaneFilePath(base),
          JSON.stringify({
            host: '127.0.0.1',
            port: 4500,
            pid: 7777,
            url: 'http://127.0.0.1:4500',
            instanceId: 'inst-viva',
          }),
          'utf8',
        )
        return false
      },
    })

    expect(encontrado).toBeUndefined()
    // O registro vivo sobrevive: apagar sem condicao deixaria o dono novo invisivel.
    expect(await readControlPlaneFile(base)).toMatchObject({ instanceId: 'inst-viva' })
  })
})
