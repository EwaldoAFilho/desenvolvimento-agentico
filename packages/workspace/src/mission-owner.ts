import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * Prova de posse da worktree do gate da missao.
 *
 * Caminho, branch, SHA e ancestralidade dizem onde a arvore esta e de onde ela veio —
 * nenhum deles diz QUEM a criou. Todos podem ser reproduzidos por quem quiser: basta um
 * `git worktree add --detach` no lugar certo. Como a devolucao dessa worktree e uma
 * remocao, inferir posse nao serve: e preciso PROVAR.
 *
 * A prova e um arquivo que o proprio control plane escreve na raiz da worktree no momento
 * em que a cria. Quem nao o escreveu nao o tem, e sem ele nada e removido. Nao ha segredo
 * aqui e nem poderia haver: o marcador nao autentica ninguem contra um adversario com
 * acesso ao disco — ele distingue "arvore que nos criamos" de "arvore que apareceu no
 * caminho que reservamos", que e exatamente a pergunta que a remocao precisa responder.
 */
export const MISSION_OWNER_FILE = '.agentic-owner.json'
export const MISSION_OWNER_KIND = 'mission-gate-worktree'
export const MISSION_OWNER_VERSION = 1

export interface MissionOwnerMarker {
  readonly kind: typeof MISSION_OWNER_KIND
  readonly version: number
  readonly runId: string
  readonly repoRoot: string
}

export function missionOwnerPath(worktree: string): string {
  return join(resolve(worktree), MISSION_OWNER_FILE)
}

export interface MissionOwnerInput {
  readonly runId: string
  readonly repoRoot: string
}

/** Escrito no ato da criacao — depois disso ja e tarde para provar qualquer coisa. */
export async function writeMissionOwner(
  worktree: string,
  input: MissionOwnerInput,
): Promise<MissionOwnerMarker> {
  const marker: MissionOwnerMarker = {
    kind: MISSION_OWNER_KIND,
    version: MISSION_OWNER_VERSION,
    runId: input.runId,
    repoRoot: await canonical(input.repoRoot),
  }
  await writeFile(missionOwnerPath(worktree), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
  return marker
}

export type OwnershipProof =
  | { readonly ok: true; readonly marker: MissionOwnerMarker }
  | { readonly ok: false; readonly reason: string }

/**
 * `realpath` quando o caminho existe; `resolve` quando nao existe mais. Comparar caminho
 * cru daria diferenca puramente textual sob link simbolico — o `/tmp` da suite e o caso
 * obvio — e uma diferenca dessas viraria "outro repositorio" sem que nada tenha mudado.
 */
async function canonical(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path))
}

/**
 * A worktree em `worktree` foi criada por NOS, para este run e este repositorio?
 *
 * Toda resposta negativa vem com motivo: quem chama precisa poder dizer ao humano por que
 * recusou, e "nao removi" sem explicacao e pior que nao ter tentado.
 */
export async function proveMissionOwnership(
  worktree: string,
  expected: MissionOwnerInput,
): Promise<OwnershipProof> {
  let raw: string
  try {
    raw = await readFile(missionOwnerPath(worktree), 'utf8')
  } catch {
    return { ok: false, reason: `sem ${MISSION_OWNER_FILE}: nada prova que esta worktree e nossa` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: `${MISSION_OWNER_FILE} ilegivel: nao e JSON valido` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `${MISSION_OWNER_FILE} nao descreve um marcador` }
  }
  const record = parsed as Record<string, unknown>
  if (record.kind !== MISSION_OWNER_KIND) {
    return { ok: false, reason: `marcador de outro tipo: ${String(record.kind)}` }
  }
  if (record.version !== MISSION_OWNER_VERSION) {
    return { ok: false, reason: `versao de marcador nao suportada: ${String(record.version)}` }
  }
  if (typeof record.runId !== 'string' || record.runId.length === 0) {
    return { ok: false, reason: 'marcador sem runId' }
  }
  if (typeof record.repoRoot !== 'string' || record.repoRoot.length === 0) {
    return { ok: false, reason: 'marcador sem repoRoot' }
  }
  if (record.runId !== expected.runId) {
    return { ok: false, reason: `marcador e do run ${record.runId}, nao de ${expected.runId}` }
  }
  const esperado = await canonical(expected.repoRoot)
  const declarado = await canonical(record.repoRoot)
  if (declarado !== esperado) {
    return { ok: false, reason: `marcador e do repositorio ${declarado}, nao de ${esperado}` }
  }
  return {
    ok: true,
    marker: {
      kind: MISSION_OWNER_KIND,
      version: MISSION_OWNER_VERSION,
      runId: record.runId,
      repoRoot: declarado,
    },
  }
}
