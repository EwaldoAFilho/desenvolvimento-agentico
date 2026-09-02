import { lstat, mkdir, readFile, readlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestRepo, type TestRepo } from './__fixtures__/repo.js'
import { isWorkspaceError, WorkspaceError } from './errors.js'
import { normalizeSetupCommand, runWorkspaceSetup } from './setup.js'

let repo: TestRepo | undefined
const target = async (): Promise<string> => {
  const path = join((repo as TestRepo).root, 'destino')
  await mkdir(path, { recursive: true })
  return path
}

afterEach(async () => {
  await repo?.cleanup()
  repo = undefined
})

describe('runWorkspaceSetup', () => {
  it('sem configuracao nao faz nada', async () => {
    repo = await createTestRepo()
    const result = await runWorkspaceSetup(await target(), repo.root, undefined)
    expect(result).toEqual({ linked: [], skipped: [], commands: [] })
  })

  it('cria symlink do diretorio da raiz do repositorio', async () => {
    repo = await createTestRepo()
    await mkdir(join(repo.root, 'node_modules', 'dep'), { recursive: true })
    await writeFile(join(repo.root, 'node_modules', 'dep', 'index.js'), 'ok\n', 'utf8')
    const destino = await target()

    const result = await runWorkspaceSetup(destino, repo.root, { link: ['node_modules'] })

    expect(result.linked).toEqual(['node_modules'])
    const stats = await lstat(join(destino, 'node_modules'))
    expect(stats.isSymbolicLink()).toBe(true)
    expect(await readlink(join(destino, 'node_modules'))).toBe(join(repo.root, 'node_modules'))
    const conteudo = await readFile(join(destino, 'node_modules', 'dep', 'index.js'), 'utf8')
    expect(conteudo).toBe('ok\n')
  })

  it('pula fonte ausente em vez de plantar link quebrado', async () => {
    repo = await createTestRepo()
    const result = await runWorkspaceSetup(await target(), repo.root, { link: ['.env'] })
    expect(result.linked).toEqual([])
    expect(result.skipped).toEqual([{ name: '.env', reason: 'source-missing' }])
  })

  it('pula link para o proprio caminho (arvore compartilhada)', async () => {
    repo = await createTestRepo()
    await mkdir(join(repo.root, 'node_modules'), { recursive: true })
    const result = await runWorkspaceSetup(repo.root, repo.root, { link: ['node_modules'] })
    expect(result.skipped).toEqual([{ name: 'node_modules', reason: 'same-path' }])
  })

  it('e idempotente quando o link ja aponta para o lugar certo', async () => {
    repo = await createTestRepo()
    await mkdir(join(repo.root, 'node_modules'), { recursive: true })
    const destino = await target()
    await runWorkspaceSetup(destino, repo.root, { link: ['node_modules'] })
    const result = await runWorkspaceSetup(destino, repo.root, { link: ['node_modules'] })
    expect(result.linked).toEqual(['node_modules'])
  })

  it('recusa sobrescrever arquivo real da worktree', async () => {
    repo = await createTestRepo()
    await mkdir(join(repo.root, 'node_modules'), { recursive: true })
    const destino = await target()
    await writeFile(join(destino, 'node_modules'), 'arquivo de verdade', 'utf8')
    await expect(runWorkspaceSetup(destino, repo.root, { link: ['node_modules'] })).rejects.toThrow(
      WorkspaceError,
    )
  })

  it('recusa link que escapa da raiz', async () => {
    repo = await createTestRepo()
    await expect(
      runWorkspaceSetup(await target(), repo.root, { link: ['../fora'] }),
    ).rejects.toThrow(/escapar/)
  })

  it('roda os comandos declarados dentro da arvore', async () => {
    repo = await createTestRepo()
    const destino = await target()
    const result = await runWorkspaceSetup(destino, repo.root, {
      commands: [{ run: 'echo pronto > marca.txt' }],
    })
    expect(result.commands[0]?.exitCode).toBe(0)
    expect(await readFile(join(destino, 'marca.txt'), 'utf8')).toContain('pronto')
  })

  it('comando que falha vira WORKSPACE_ERROR com o comando no detalhe', async () => {
    repo = await createTestRepo()
    const erro = await runWorkspaceSetup(await target(), repo.root, {
      commands: ['exit 42'],
    }).catch((error: unknown) => error)
    expect(isWorkspaceError(erro)).toBe(true)
    const workspaceError = erro as WorkspaceError
    expect(workspaceError.stage).toBe('setup')
    expect(workspaceError.toFailureReason().code).toBe('WORKSPACE_ERROR')
    expect(workspaceError.message).toContain('exit 42')
  })

  it('comando que estoura o tempo vira WORKSPACE_ERROR', async () => {
    repo = await createTestRepo()
    const erro = await runWorkspaceSetup(await target(), repo.root, {
      commands: [{ run: 'sleep 5', timeoutMs: 50 }],
    }).catch((error: unknown) => error)
    expect(isWorkspaceError(erro)).toBe(true)
    expect((erro as WorkspaceError).message).toContain('tempo')
  })

  it('sinal de abort cancela o comando em voo, mata a arvore e vira WORKSPACE_ERROR', async () => {
    repo = await createTestRepo()
    const destino = await target()
    const controller = new AbortController()
    const pidFile = join(destino, 'pid')
    const inicio = Date.now()
    const pending = runWorkspaceSetup(
      destino,
      repo.root,
      {
        commands: [
          `node -e "require('node:fs').writeFileSync('${pidFile}', String(process.pid)); setTimeout(() => {}, 30000)"`,
          'node -e "process.exit(0)"',
        ],
      },
      controller.signal,
    )
    const limite = Date.now() + 10_000
    while (
      !(await lstat(pidFile).then(
        () => true,
        () => false,
      ))
    ) {
      if (Date.now() > limite) throw new Error('o comando de setup nao comecou')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const pid = Number(await readFile(pidFile, 'utf8'))
    controller.abort('encerrando')
    const error = await pending.then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(isWorkspaceError(error)).toBe(true)
    expect((error as WorkspaceError).message).toContain('cancelado')
    expect(Date.now() - inicio).toBeLessThan(10_000)
    // O processo do comando morre com a recusa. `kill(pid, 0)` ainda responde para um zumbi
    // que o kernel nao reaproveitou; a espera curta separa "morto" de "ainda nao colhido".
    const vivo = (): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const fim = Date.now() + 3_000
    while (vivo() && Date.now() < fim) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(vivo()).toBe(false)
  })

  it('sinal ja abortado: nenhum comando chega a rodar', async () => {
    repo = await createTestRepo()
    const destino = await target()
    const controller = new AbortController()
    controller.abort()
    const marca = join(destino, 'rodou')
    await expect(
      runWorkspaceSetup(
        destino,
        repo.root,
        { commands: [`node -e "require('node:fs').writeFileSync(${JSON.stringify(marca)}, 'x')"`] },
        controller.signal,
      ),
    ).rejects.toThrow('cancelado')
    await expect(lstat(marca)).rejects.toThrow()
  })

  it('normaliza comando em string', () => {
    expect(normalizeSetupCommand('npm ci')).toEqual({ run: 'npm ci' })
    expect(normalizeSetupCommand({ run: 'npm ci', cwd: 'app' })).toEqual({
      run: 'npm ci',
      cwd: 'app',
    })
  })
})
