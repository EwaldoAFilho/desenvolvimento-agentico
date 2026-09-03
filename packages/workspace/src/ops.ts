import type { CommitRef } from '@agentic/domain'
import {
  type AttemptObservation,
  buildObservation,
  excludeLinkedPaths,
  mergeDiffEntries,
  parseNameStatusZ,
  parseNumstatZ,
  type WorkspaceScope,
} from './diff.js'
import { git, gitText } from './git.js'

/**
 * Resultado de `commit` com o fato que o dominio nao carrega: `changed: false` e o que o
 * chamador mapeia para `NO_CHANGES`.
 */
export interface AttemptCommit extends CommitRef {
  readonly changed: boolean
}

export function isNoChanges(ref: CommitRef): boolean {
  if ('changed' in ref) return ref.changed === false
  return ref.sha.length === 0
}

function excludeSpecs(links: readonly string[]): string[] {
  return links.map((link) => `:(exclude)${link.replace(/\/+$/, '')}`)
}

/** `git add` restrito ao escopo declarado; sem escopo, a arvore inteira. */
function scopeSpecs(scope: WorkspaceScope): string[] {
  return scope.touches.length > 0 ? scope.touches.map((path) => String(path)) : ['.']
}

/**
 * `git add` aborta (exit 128) se QUALQUER pathspec nao casar nada, e escopo que ainda nao
 * existe na arvore e normal — task que cria diretorio novo declara `touches` do que vai
 * nascer. Sem este filtro, um `touches` futuro derrubaria o commit do trabalho legitimo
 * feito nos outros caminhos do escopo.
 */
async function matchingSpecs(cwd: string, specs: readonly string[]): Promise<string[]> {
  const kept: string[] = []
  for (const spec of specs) {
    const result = await git(
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', spec],
      { cwd, allowFailure: true },
    )
    if (result.exitCode === 0 && result.stdout.length > 0) kept.push(spec)
  }
  return kept
}

/**
 * `--intent-to-add` faz o arquivo novo aparecer em `git diff` sem entrar no commit: sem
 * isso, todo arquivo criado pelo agente ficaria invisivel para a verificacao de escopo.
 */
export async function stageIntent(cwd: string, links: readonly string[]): Promise<void> {
  await git(['add', '-A', '--intent-to-add', '--', '.', ...excludeSpecs(links)], {
    cwd,
    stage: 'diff',
  })
}

/** Desfaz o `intent-to-add` (e qualquer stage do agente): o index volta a HEAD, a arvore fica intacta. */
export async function resetIndex(cwd: string): Promise<void> {
  await git(['reset', '--quiet'], { cwd, allowFailure: true })
}

export interface ObserveOptions {
  readonly cwd: string
  readonly baseCommit: string
  readonly scope: WorkspaceScope
  readonly links?: readonly string[]
}

/** Diff da arvore contra o commit base da tentativa — nunca contra a branch, que se move. */
export async function observeWorkingTree(options: ObserveOptions): Promise<AttemptObservation> {
  const { cwd, baseCommit } = options
  const links = options.links ?? []
  await stageIntent(cwd, links)

  const base = ['diff', '-M', '--no-ext-diff', '--no-color', baseCommit]
  const status = await gitText([...base, '--name-status', '-z'], { cwd, stage: 'diff' })
  const numstat = await gitText([...base, '--numstat', '-z'], { cwd, stage: 'diff' })
  const patch = await git([...base, '--'], { cwd, stage: 'diff' })
  const head = await gitText(['rev-parse', 'HEAD'], { cwd, stage: 'diff' })

  await resetIndex(cwd)

  const changes = excludeLinkedPaths(
    mergeDiffEntries(parseNameStatusZ(status), parseNumstatZ(numstat)),
    links,
  )
  return buildObservation({ changes, scope: options.scope, patch: patch.stdout, commit: head })
}

export interface CommitOptions {
  readonly cwd: string
  readonly message: string
  readonly scope: WorkspaceScope
  readonly links?: readonly string[]
  readonly branch?: string
}

/**
 * Hooks do projeto-alvo nao decidem aqui: quem julga qualidade e o gate, e um `pre-commit`
 * pendurado transformaria evidencia em falha de infraestrutura.
 */
export async function commitWorkingTree(options: CommitOptions): Promise<AttemptCommit> {
  const { cwd } = options
  // O index volta a HEAD antes de estagiar: intent-to-add pendente do diff nao pode virar
  // "ha algo para commitar" fora do escopo.
  await resetIndex(cwd)
  const links = options.links ?? []
  // Nenhum caminho do escopo existe ainda: nao ha o que estagiar, e `--` so com
  // `:(exclude)` estagiaria a arvore inteira. O index fica em HEAD => NO_CHANGES.
  const specs = await matchingSpecs(cwd, scopeSpecs(options.scope))
  if (specs.length > 0) {
    // NAO usar `:(exclude)` aqui. Combinado com pathspec explicito, ele zera o staging de
    // ARQUIVO NOVO em silencio (git 2.53): `git add -A -- <novo.ts> :(exclude)node_modules`
    // estagia nada e sai 0, enquanto `git ls-files --others` com os mesmos pathspecs lista
    // o arquivo — que e exatamente o que matchingSpecs consulta para decidir que o escopo
    // casa. O efeito era um commit sem os arquivos criados pela tentativa, com o gate
    // passando na arvore suja: evidencia PASS atribuida a um commit que nao compila.
    // Observado em DA-UX-001/U02, tentativas a1 e a2.
    await git(['add', '-A', '--', ...specs], { cwd, stage: 'commit' })
    // A garantia dos links vira desestagiamento explicito: mesmo efeito, sem depender da
    // interacao de pathspec. Cobre o caso de um `touches` de diretorio que contenha o link.
    if (links.length > 0) {
      await git(['reset', '--quiet', '--', ...links], { cwd, allowFailure: true })
    }
  }
  const staged = await git(['diff', '--cached', '--quiet'], { cwd, allowFailure: true })
  if (staged.exitCode === 0) {
    const head = await gitText(['rev-parse', 'HEAD'], { cwd, stage: 'commit' })
    return { sha: head, branch: options.branch, changed: false }
  }
  await git(['commit', '--no-verify', '-m', options.message], { cwd, stage: 'commit' })
  const sha = await gitText(['rev-parse', 'HEAD'], { cwd, stage: 'commit' })
  return { sha, branch: options.branch, message: options.message, changed: true }
}
