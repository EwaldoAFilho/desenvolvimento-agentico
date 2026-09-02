import { execFile } from 'node:child_process'
import { join } from 'node:path'
import * as vscode from 'vscode'

/**
 * Diff nativo do editor sobre refs do git: `git show <ref>:<path>` de cada lado, e
 * `vscode.diff` desenha. Nenhum editor proprio; nenhuma escrita — o provider so le.
 *
 * URI: `agentic-git:/<caminho relativo>?ref=<ref>&root=<repoRoot>`.
 */
export const GIT_SCHEME = 'agentic-git'

export function gitUri(repoRoot: string, ref: string, path: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: GIT_SCHEME,
    path: `/${path.replace(/^\/+/, '')}`,
    query: new URLSearchParams({ ref, root: repoRoot }).toString(),
  })
}

function gitShow(repoRoot: string, ref: string, path: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['show', `${ref}:${path}`],
      { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        // Arquivo ausente naquele ref (criado/removido): lado vazio, o diff mostra tudo.
        resolve(error === null ? String(stdout) : '')
      },
    )
  })
}

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query)
    const ref = params.get('ref')
    const root = params.get('root')
    if (ref === null || root === null) return Promise.resolve('')
    return gitShow(root, ref, uri.path.replace(/^\/+/, ''))
  }
}

export interface OpenDiffArgs {
  readonly repoRoot: string
  readonly path: string
  readonly base: string
  readonly head: string
}

export async function openDiff(args: OpenDiffArgs): Promise<void> {
  const left = gitUri(args.repoRoot, args.base, args.path)
  const right = gitUri(args.repoRoot, args.head, args.path)
  const title = `${args.path} (${short(args.base)} ↔ ${short(args.head)})`
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true })
}

function short(ref: string): string {
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 8) : ref
}

/** Abre um arquivo do projeto (ou revela uma pasta) no editor. */
export async function openPath(repoRoot: string, path: string): Promise<void> {
  const absolute =
    path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? path : join(repoRoot, path)
  const uri = vscode.Uri.file(absolute)
  try {
    const stat = await vscode.workspace.fs.stat(uri)
    if (stat.type === vscode.FileType.Directory) {
      await vscode.commands.executeCommand('revealInExplorer', uri)
      return
    }
    await vscode.window.showTextDocument(uri, { preview: true })
  } catch {
    void vscode.window.showWarningMessage(`Agentic: caminho não encontrado: ${absolute}`)
  }
}
