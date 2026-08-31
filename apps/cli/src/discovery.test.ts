import { execFile } from 'node:child_process'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import { promisify } from 'node:util'
import { readControlPlaneFile, writeControlPlaneFile } from '@agentic/server'
import { afterEach, describe, expect, it } from 'vitest'
import { captureDeps, createWorkspace, type Workspace } from './__fixtures__/harness.js'
import { missionApproveCommand } from './commands/mission-approve.js'
import { loadProjectContext, type ProjectContext } from './context.js'
import { describeEndpoint, resolveEndpoint, runtimeDirsOf } from './discovery.js'
import { requireLink } from './plane.js'

const exec = promisify(execFile)

let workspace: Workspace | undefined

afterEach(async () => {
  await workspace?.cleanup()
  workspace = undefined
})

async function contextOf(dir: string): Promise<ProjectContext> {
  return loadProjectContext(captureDeps({ cwd: dir }).deps)
}

/** Pid de um processo que ja encerrou — o caso do control plane morto sem limpar nada. */
async function deadPid(): Promise<number> {
  const { stdout } = await exec(nodeProcess.execPath, [
    '-e',
    'process.stdout.write(String(process.pid))',
  ])
  return Number.parseInt(stdout, 10)
}

async function publish(dir: string, port: number, pid = nodeProcess.pid): Promise<void> {
  await writeControlPlaneFile(join(dir, '.agentic'), { host: '127.0.0.1', port, pid })
}

describe('descoberta do control plane pela CLI', () => {
  it('sem registro, vale o endereco declarado no project.yaml', async () => {
    workspace = await createWorkspace({ port: 4317 })
    const resolved = await resolveEndpoint(await contextOf(workspace.dir))

    expect(resolved).toMatchObject({ endpoint: 'http://127.0.0.1:4317', source: 'project' })
  })

  it('registro de processo VIVO vence o project.yaml — inclusive em outra porta', async () => {
    workspace = await createWorkspace({ port: 4317 })
    await publish(workspace.dir, 4999)

    const resolved = await resolveEndpoint(await contextOf(workspace.dir))
    expect(resolved).toMatchObject({ endpoint: 'http://127.0.0.1:4999', source: 'runtime' })
    expect(resolved.pid).toBe(nodeProcess.pid)
  })

  it('registro de processo MORTO nao vale nada: volta ao project.yaml', async () => {
    workspace = await createWorkspace({ port: 4317 })
    await publish(workspace.dir, 4999, await deadPid())

    const resolved = await resolveEndpoint(await contextOf(workspace.dir))
    expect(resolved).toMatchObject({ endpoint: 'http://127.0.0.1:4317', source: 'project' })
  })

  it('registro de processo MORTO e apagado do disco', async () => {
    workspace = await createWorkspace()
    await publish(workspace.dir, 4999, await deadPid())
    const runtimeDir = join(workspace.dir, '.agentic')
    expect(await readControlPlaneFile(runtimeDir)).toBeDefined()

    await resolveEndpoint(await contextOf(workspace.dir))

    expect(await readControlPlaneFile(runtimeDir)).toBeUndefined()
  })

  it('`--port` explicito vence ate um registro vivo', async () => {
    workspace = await createWorkspace({ port: 4317 })
    await publish(workspace.dir, 4999)

    const resolved = await resolveEndpoint(await contextOf(workspace.dir), { port: 4001 })
    expect(resolved).toMatchObject({ endpoint: 'http://127.0.0.1:4001', source: 'flag' })
  })

  it('a sonda de processo vivo e injetavel e recebe o pid do registro', async () => {
    workspace = await createWorkspace()
    await publish(workspace.dir, 4999, 12_345)
    const asked: number[] = []

    const resolved = await resolveEndpoint(await contextOf(workspace.dir), {
      alive: (pid) => {
        asked.push(pid)
        return true
      },
    })
    expect(asked).toEqual([12_345])
    expect(resolved.source).toBe('runtime')
  })

  it('procura no `.agentic` do projeto (e sem repetir diretorio)', async () => {
    workspace = await createWorkspace()
    const context = await contextOf(workspace.dir)

    expect(runtimeDirsOf(context)).toContain(join(workspace.dir, '.agentic'))
    expect(new Set(runtimeDirsOf(context)).size).toBe(runtimeDirsOf(context).length)
  })

  it('a origem do endereco fica visivel para o humano', () => {
    expect(describeEndpoint({ endpoint: 'http://h:1', source: 'flag' })).toContain('--port')
    expect(describeEndpoint({ endpoint: 'http://h:1', source: 'runtime', pid: 77 })).toContain(
      'control-plane.json, pid 77',
    )
    expect(describeEndpoint({ endpoint: 'http://h:1', source: 'project' })).toContain(
      'project.yaml',
    )
  })
})

describe('a ligacao usa o endereco descoberto', () => {
  it('`requireLink` fala com a porta do registro, nao com a do project.yaml', async () => {
    workspace = await createWorkspace({ port: 4317 })
    await publish(workspace.dir, 4999)
    const tried: string[] = []
    const captured = captureDeps({
      cwd: workspace.dir,
      connect: (endpoint) => {
        tried.push(endpoint)
        return Promise.resolve({ endpoint, send: () => Promise.reject(new Error('nao usado')) })
      },
    })

    const link = await requireLink(captured.deps, await contextOf(workspace.dir))
    expect(tried).toEqual(['http://127.0.0.1:4999'])
    expect(link.endpoint).toBe('http://127.0.0.1:4999')
  })

  it('`mission approve` tambem entrega no endereco descoberto, nao no do project.yaml', async () => {
    // Aprovar com o control plane no ar em outra porta nao pode abrir um segundo escritor
    // do banco (I7): o ato humano vai para o processo que existe agora.
    workspace = await createWorkspace({ port: 4317 })
    await publish(workspace.dir, 4999)
    const tried: string[] = []
    const captured = captureDeps({
      cwd: workspace.dir,
      connect: (endpoint) => {
        tried.push(endpoint)
        return Promise.resolve({
          endpoint,
          send: () => Promise.resolve({ status: 202, body: { accepted: true } }),
        })
      },
    })

    const result = await missionApproveCommand(
      { file: workspace.missionPath, actor: 'ewaldo' },
      captured.deps,
    )

    expect(result.exitCode).toBe(0)
    expect(tried).toEqual(['http://127.0.0.1:4999'])
  })

  it('registro morto: tenta o project.yaml e diz de onde veio o endereco', async () => {
    workspace = await createWorkspace({ port: 4317 })
    await publish(workspace.dir, 4999, await deadPid())
    const captured = captureDeps({ cwd: workspace.dir, connect: () => Promise.resolve(undefined) })

    await expect(requireLink(captured.deps, await contextOf(workspace.dir))).rejects.toThrow(
      /http:\/\/127\.0\.0\.1:4317 \(server do project\.yaml\)/,
    )
  })
})
