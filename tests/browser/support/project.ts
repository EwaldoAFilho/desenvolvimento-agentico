import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** Branch inicial do projeto-alvo temporario, criada por `materializeProject`. */
const BASE_BRANCH = 'main'

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: root, encoding: 'utf8' })
  return stdout
}

/**
 * Devolve o projeto-alvo ao estado inicial entre cenarios: worktrees de tentativa apagadas,
 * registro do git podado e toda branch de missao/task removida.
 *
 * POR QUE ISTO EXISTE — e o que ele NAO e:
 *
 * Nao e limpeza cosmetica. Sem ele, o SEGUNDO run da mesma missao no mesmo repositorio
 * nunca sai do lugar: as branches de tentativa sao nomeadas por
 * `task/<missionId>/<taskId>/<attemptId>` (sem o id do run, que so entra no CAMINHO da
 * worktree), entao `git worktree add -b task/EXEMPLO-001/T01/a1 ...` falha com exit 255
 * porque a branch ja existe da vez anterior. O orquestrador reage repetindo o despacho
 * indefinidamente — `policy.invalid_transition` com
 * `GUARD_FAILED:workspace-acquired` a cada 2s, sem escalonar, sem BLOCKED e sem falhar —
 * e o dashboard fica em RUNNING para sempre, sem dizer por que.
 *
 * Isso e defeito do produto, nao desta suite, e esta relatado como tal. Aqui ele so nao
 * pode contaminar os oito cenarios: cada um precisa de um run proprio da missao de
 * exemplo, e cada um comeca com o repositorio-alvo limpo — como o de um usuario que ainda
 * nao rodou nada.
 */
export async function resetTargetProject(root: string | undefined): Promise<void> {
  if (root === undefined) return
  await rm(join(root, '.agentic/worktrees'), { recursive: true, force: true })
  await git(root, 'worktree', 'prune')
  const branches = (await git(root, 'branch', '--format=%(refname:short)'))
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => name.length > 0 && name !== BASE_BRANCH)
  if (branches.length === 0) return
  await git(root, 'checkout', '-f', BASE_BRANCH)
  await git(root, 'branch', '-D', ...branches)
}
