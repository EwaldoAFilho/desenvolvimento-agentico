import { mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireControlPlaneOwnership,
  CONTROL_PLANE_LOCK_FILE,
  type ControlPlaneLease,
  canonicalDir,
  controlPlaneLockPath,
  newInstanceId,
  OWNERSHIP_ALREADY_HELD,
  OwnershipPathError,
} from './control-plane-lock.js'

const descartar: string[] = []
const soltar: ControlPlaneLease[] = []

function projeto(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentic-lock-')))
  descartar.push(root)
  return join(root, '.agentic')
}

/** Toda posse adquirida no teste e solta no fim: um lease vazado travaria o proximo caso. */
function possuir(baseDir: string, instanceId?: string): ControlPlaneLease {
  const outcome = acquireControlPlaneOwnership({
    baseDir,
    ...(instanceId === undefined ? {} : { instanceId }),
  })
  if (!outcome.ok) throw new Error(`esperava posse, veio ${outcome.code}: ${outcome.detail}`)
  soltar.push(outcome.lease)
  return outcome.lease
}

afterEach(() => {
  for (const lease of soltar.splice(0)) lease.release()
  for (const root of descartar.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('posse do projeto', () => {
  it('a primeira aquisicao ganha e a segunda e recusada com motivo', () => {
    const baseDir = projeto()
    const dono = possuir(baseDir)
    expect(dono.held).toBe(true)

    const segundo = acquireControlPlaneOwnership({ baseDir })
    expect(segundo.ok).toBe(false)
    if (segundo.ok) throw new Error('inalcancavel')
    expect(segundo.code).toBe(OWNERSHIP_ALREADY_HELD)
    // A recusa precisa dizer o que foi recusado: sem isso a CLI nao tem o que contar.
    expect(segundo.lockPath).toBe(controlPlaneLockPath(canonicalDir(baseDir)))
    expect(segundo.detail).toContain(canonicalDir(baseDir))
  })

  it('soltar a posse devolve o projeto ao proximo', () => {
    const baseDir = projeto()
    const dono = possuir(baseDir)
    dono.release()
    expect(dono.held).toBe(false)

    const proximo = possuir(baseDir)
    expect(proximo.held).toBe(true)
  })

  it('release e idempotente: chamar duas vezes nao explode nem retoma a posse', () => {
    const baseDir = projeto()
    const dono = possuir(baseDir)
    dono.release()
    expect(() => {
      dono.release()
    }).not.toThrow()
    expect(dono.held).toBe(false)
  })

  it('a identidade nao vem do PID: dois leases nunca compartilham instanceId', () => {
    const um = possuir(projeto())
    const outro = possuir(projeto())
    expect(um.instanceId).not.toBe(outro.instanceId)
    expect(newInstanceId()).not.toBe(newInstanceId())
  })

  it('projetos diferentes tem donos independentes', () => {
    const a = possuir(projeto())
    const b = possuir(projeto())
    expect(a.held).toBe(true)
    expect(b.held).toBe(true)
    expect(a.lockPath).not.toBe(b.lockPath)
  })

  it('link simbolico para o mesmo projeto disputa a MESMA posse', () => {
    const baseDir = projeto()
    possuir(baseDir)

    const atalho = join(realpathSync(mkdtempSync(join(tmpdir(), 'agentic-link-'))), 'atalho')
    descartar.push(atalho)
    symlinkSync(baseDir, atalho, 'dir')

    // Comparar caminho como texto daria dois donos para um projeto so.
    const pelaLink = acquireControlPlaneOwnership({ baseDir: atalho })
    expect(pelaLink.ok).toBe(false)
    if (pelaLink.ok) throw new Error('inalcancavel')
    expect(pelaLink.code).toBe(OWNERSHIP_ALREADY_HELD)
    expect(pelaLink.ownedDir).toBe(canonicalDir(baseDir))
  })

  it('cria o diretorio do projeto quando ele ainda nao existe', () => {
    const baseDir = projeto()
    const dono = possuir(baseDir)
    expect(dono.lockPath.endsWith(CONTROL_PLANE_LOCK_FILE)).toBe(true)
    expect(statSync(dono.lockPath).isFile()).toBe(true)
  })

  it('o banco de posse nao guarda nada: fica com zero byte', () => {
    const baseDir = projeto()
    const dono = possuir(baseDir)
    // Nenhuma tabela, nenhuma linha, nenhuma migracao — so o lock de arquivo importa.
    expect(statSync(dono.lockPath).size).toBe(0)
  })

  it('caminho que nao pode ser canonicalizado RECUSA em vez de inventar uma chave', () => {
    // Cair para o caminho textual manteria o boot de pe e permitiria que dois aliases do
    // mesmo projeto virassem dois donos — trocar a invariante por disponibilidade e
    // exatamente o que esta funcao nao pode fazer.
    const inexistente = join(projeto(), 'nao-existe', 'nem-o-pai')
    expect(() => canonicalDir(inexistente)).toThrow(OwnershipPathError)
  })

  it('release que nao conseguiu fechar pode ser tentado de novo', () => {
    const baseDir = projeto()
    const dono = possuir(baseDir)
    dono.release()
    expect(dono.held).toBe(false)

    // Segunda chamada sobre conexao ja fechada nao explode e nao reabre nada.
    expect(() => {
      dono.release()
    }).not.toThrow()
    // E o projeto esta mesmo livre: quem chega depois assume.
    const proximo = possuir(baseDir)
    expect(proximo.held).toBe(true)
  })
})
