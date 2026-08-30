import { isAbsolute, relative, resolve, sep } from 'node:path'
import { GateError } from './errors.js'

const WINDOWS_DRIVE = /^[A-Za-z]:/

/**
 * O workspace da tentativa (ou o da integracao, no gate de missao). Precisa ser absoluto:
 * caminho relativo seria resolvido contra o cwd do orquestrador — a arvore principal —, e
 * o gate DEVE rodar na tentativa, senao a evidencia deixa de ser atribuivel
 * (ARCHITECTURE 3.4).
 */
export function resolveGateWorkspace(workspace: string): string {
  if (workspace.trim().length === 0) {
    throw new GateError('GATE_CONFIG_INVALID', 'workspace do gate nao pode ser vazio')
  }
  if (!isAbsolute(workspace)) {
    throw new GateError(
      'GATE_CONFIG_INVALID',
      `workspace do gate precisa ser um caminho absoluto: ${workspace}`,
    )
  }
  return resolve(workspace)
}

/**
 * `cwd` declarado no comando e SEMPRE relativo ao workspace. Absoluto ou escapando por
 * `..` e recusado: um gate nao mede a arvore principal nem a tentativa do vizinho.
 *
 * A checagem e lexica de proposito — o diretorio pode nem existir ainda quando o gate e
 * planejado, e `realpath` exigiria que existisse.
 */
export function resolveGateCwd(workspace: string, declared?: string): string {
  const root = resolveGateWorkspace(workspace)
  if (declared === undefined) return root

  const trimmed = declared.trim()
  if (trimmed.length === 0) {
    throw new GateError('GATE_CWD_ESCAPE', 'cwd de comando nao pode ser vazio')
  }
  if (isAbsolute(trimmed) || WINDOWS_DRIVE.test(trimmed)) {
    throw new GateError(
      'GATE_CWD_ESCAPE',
      `cwd de comando precisa ser relativo ao workspace: ${declared}`,
      root,
    )
  }

  const target = resolve(root, trimmed)
  if (!isInside(root, target)) {
    throw new GateError(
      'GATE_CWD_ESCAPE',
      `cwd de comando escapa do workspace: ${declared}`,
      target,
    )
  }
  return target
}

/** Melhor esforco para relatorio: comando que nem rodou ainda precisa exibir um cwd. */
export function displayGateCwd(workspace: string, declared?: string): string {
  try {
    return resolveGateCwd(workspace, declared)
  } catch {
    return resolve(workspace)
  }
}

function isInside(root: string, target: string): boolean {
  if (target === root) return true
  const rel = relative(root, target)
  if (rel.length === 0 || isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}
