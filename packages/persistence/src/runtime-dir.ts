import { join, resolve } from 'node:path'
import { canonicalIfPresent } from './control-plane-lock.js'

/**
 * UMA regra para "onde mora o estado deste projeto", e ela vive junto do lock que a cobra.
 *
 * A conta ja era unica desde a 003B — `projectIdentityOf`, em `@agentic/server`. O que faltava
 * era ela alcancar quem ABRE O BANCO: `createControlPlane` mora em `@agentic/orchestrator`, que
 * nao pode importar um app (`interfaces ──► application ──► domain ◄── adapters`). Sem um lugar
 * comum, a composicao aceitava um `baseDir` do chamador — e um `baseDir` livre e uma SEGUNDA
 * identidade de projeto, que foi exatamente o blocker C.
 *
 * Descendo a regra para o adaptador de persistencia, `projectIdentityOf` e `createControlPlane`
 * passam a derivar do MESMO `runtimeDirOf`. Nao ha segunda regra para envelhecer sozinha.
 */

/** Diretorio local do projeto; o mesmo que guarda `state.db`, `runs/` e a descoberta. */
export const RUNTIME_DIR_NAME = '.agentic'

/**
 * `<repoRoot>/.agentic`, canonico. A CHAVE DE POSSE do projeto (I14).
 *
 * O estado acompanha o REPOSITORIO porque e o repositorio que worktrees e branches modificam.
 * Canonicalizacao com `realpath`: `/repo` e `/atalho-para-repo` sao um projeto so. Um caminho
 * que ainda nao existe (projeto novo, antes do primeiro boot) fica no resolvido — quem fecha a
 * porta contra alias e a canonicalizacao de `acquireControlPlaneOwnership`, sobre o diretorio
 * ja criado.
 */
export function runtimeDirOf(repoRoot: string): string {
  return canonicalIfPresent(join(resolve(repoRoot), RUNTIME_DIR_NAME))
}
