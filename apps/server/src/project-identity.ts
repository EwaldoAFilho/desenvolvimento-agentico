import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { canonicalIfPresent, RUNTIME_DIR_NAME, runtimeDirOf } from '@agentic/persistence'

/**
 * UMA conta de identidade do projeto, para TODOS os entrypoints (I14).
 *
 * O defeito que este arquivo fecha nao estava no lock: estava em cada comando derivar a
 * propria chave. Com `project.repoRoot: .` — o caso comum — `<dir do project.yaml>/.agentic`
 * e `<repoRoot>/.agentic` sao o mesmo diretorio, e a divergencia ficava invisivel. Com
 * `repoRoot` apontando para fora, `agentic serve` disputava um diretorio e
 * `agentic mission start` disputava outro: dois donos reais para um projeto so, medido.
 *
 * A regra, agora com um lugar so:
 *
 * - **`projectDir`** ancora a CONFIGURACAO. E o diretorio que contem `.agentic/project.yaml`,
 *   e e contra ele que todo caminho relativo escrito no `project.yaml` se resolve — inclusive
 *   `repoRoot` e `gates.file`. Resolver configuracao contra o repositorio faria o arquivo
 *   apontar para si mesmo por um caminho diferente do que o humano escreveu.
 * - **`repoRoot`** e o repositorio alvo, canonicalizado. E ele que da NOME ao projeto: dois
 *   diretorios de configuracao apontando para o mesmo repositorio sao o mesmo projeto e
 *   disputam a mesma posse.
 * - **`runtimeDir`** e `<repoRoot>/.agentic`: lock de posse, `state.db`, `control-plane.json`,
 *   `runs/` e `worktrees/`. O estado acompanha o REPOSITORIO porque e o repositorio que as
 *   worktrees e os branches modificam — e `execution.worktreeRoot` ja se resolvia assim.
 *
 * Canonicalizacao com `realpath`: `/repo` e `/atalho-para-repo` sao um projeto so. Um
 * caminho que ainda nao existe (projeto novo, antes do primeiro boot) fica no resolvido —
 * quem fecha a porta contra alias e a canonicalizacao feita na hora de POSSUIR, sobre o
 * diretorio ja criado.
 */
/**
 * A regra de "onde mora o estado" mora em `@agentic/persistence`, junto do lock que a cobra,
 * e daqui e so REEXPORTADA.
 *
 * Ter a definicao aqui funcionava enquanto os unicos interessados eram a CLI e o servidor.
 * Nao funcionava para `createControlPlane`, que abre o banco de dentro de `@agentic/
 * orchestrator` e nao pode importar um app — e foi por nao alcanca-la que a composicao
 * passou a aceitar um `baseDir` do chamador, ou seja, uma segunda identidade de projeto.
 * Duas contas para a mesma pergunta e como I14 se perde.
 */
export { RUNTIME_DIR_NAME, runtimeDirOf }

/**
 * Cabecalho em que o CLIENTE declara por qual projeto ele acha que esta falando.
 *
 * Sondar o `/api/health` antes e depois mandar o comando deixa uma janela: entre a sonda e
 * o POST, o dono pode encerrar e outro control plane — de OUTRO repositorio — reaproveitar a
 * porta. O comando chegaria a um servidor legitimo e mutaria o run errado. Com a declaracao
 * viajando NA MESMA requisicao, quem confere e o servidor, sobre o projeto que ele possui,
 * sem janela nenhuma.
 *
 * Nao e autenticacao e nao pretende ser (o bind e loopback por desenho, ADR-0003): e a
 * amarracao minima entre o comando e o projeto a que ele se destina.
 */
export const PROJECT_HEADER = 'x-agentic-repo-root'

/** Codigo devolvido quando o cabecalho aponta para um projeto que este servidor nao possui. */
export const PROJECT_MISMATCH = 'PROJECT_MISMATCH'

export interface ProjectIdentity {
  /** Diretorio que contem `.agentic/project.yaml`. Ancora da CONFIGURACAO. */
  readonly projectDir: string
  /** Repositorio alvo, canonico. Ancora da IDENTIDADE (I14). */
  readonly repoRoot: string
  /** `<repoRoot>/.agentic`. Ancora do ESTADO: posse, banco, descoberta, worktrees. */
  readonly runtimeDir: string
}

/**
 * De onde a configuracao e ancorada, dado o caminho do `project.yaml`.
 *
 * O arquivo mora em `<projectDir>/.agentic/project.yaml`; um caminho fora dessa convencao
 * ancora no proprio diretorio do arquivo, que e a leitura literal e previsivel.
 */
export function projectDirOf(projectFilePath: string): string {
  const dir = dirname(resolve(projectFilePath))
  const anchor = basename(dir) === RUNTIME_DIR_NAME ? dirname(dir) : dir
  return canonicalIfPresent(anchor)
}

export interface ProjectIdentityInput {
  /** Caminho do `project.yaml` — absoluto ou relativo ao diretorio de trabalho. */
  readonly projectFile: string
  /** `project.project.repoRoot`, como escrito no arquivo. */
  readonly declaredRepoRoot: string
}

/** A conta unica. Nenhum entrypoint mutavel pode derivar a sua propria versao disto. */
export function projectIdentityOf(input: ProjectIdentityInput): ProjectIdentity {
  const projectDir = projectDirOf(input.projectFile)
  const repoRoot = canonicalIfPresent(resolve(projectDir, input.declaredRepoRoot))
  return { projectDir, repoRoot, runtimeDir: runtimeDirOf(repoRoot) }
}

/** Caminho declarado no `project.yaml`, resolvido contra a ancora de CONFIGURACAO. */
export function configPathOf(projectDir: string, declared: string): string {
  return isAbsolute(declared) ? declared : resolve(projectDir, declared)
}
