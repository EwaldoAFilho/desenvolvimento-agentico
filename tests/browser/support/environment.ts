import { execFile } from 'node:child_process'
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import nodeProcess from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createControlPlane } from '@agentic/orchestrator'
import { acquireControlPlaneOwnership } from '@agentic/persistence'
import { parseProjectFile } from '@agentic/schemas'
import type { RunningServer } from '@agentic/server'
import { attachServer, loadProjectSources } from '@agentic/server'
import { scriptedFactory } from '../../e2e/support/agents.js'
import { browserStep } from './agents.js'
import { waitForHealth } from './control-plane.js'
import { LARGE_MISSION_FILE, LARGE_MISSION_ID, largeMissionYaml } from './large-mission.js'

const exec = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))

export const REPO_ROOT = resolve(here, '../../..')
/** Projeto-alvo versionado: arquivos reais e executaveis, os mesmos do E2E. */
export const FIXTURE_ROOT = join(REPO_ROOT, 'examples/estoque-cli')
export const WEB_DIST = join(REPO_ROOT, 'apps/web/dist')
export const WEB_INDEX = join(WEB_DIST, 'index.html')
export const PROJECT_PATH = '.agentic/project.yaml'
export const MISSIONS_PATH = '.agentic/missions'
export const MISSION_REF = 'EXEMPLO-001'
export const LARGE_MISSION_REF = LARGE_MISSION_ID

/**
 * Ids que esta suite substitui por agente roteirizado. Nenhum outro pode existir no
 * registry: a substituicao e por id, e um id fora desta lista chegaria a uma CLI de verdade.
 */
export const SCRIPTED_PROVIDER_IDS = ['mock', 'mock-reviewer'] as const

/**
 * Dois fornecedores roteirizados no lugar dos dois da CLI. A substituicao acontece no
 * `providerFactories` (ver `openControlPlane`), exatamente como no E2E: nenhum adapter de
 * CLI real chega a ser construido, nenhuma quota e consumida.
 *
 * Sao DOIS porque a missao tem uma task de risco alto com `cross-provider-required` — com
 * um so, a missao nem compilaria.
 *
 * E sao `local-cli`, e nao `inprocess`, de proposito: `inprocess` e a marca de ENSAIO, e
 * agente de ensaio nao revisa tentativa real (dominio, `selectReviewer`). Declarar aqui o
 * que o produto declara — fornecedor de CLI local — mantem esta suite exercitando a mesma
 * configuracao do usuario; o que a torna barata e o roteiro, nao a mentira no arquivo.
 */
const MOCK_PROVIDERS = `providers:
  default: ${SCRIPTED_PROVIDER_IDS[0]}
  registry:
    ${SCRIPTED_PROVIDER_IDS[0]}:
      kind: local-cli
      command: agente-roteirizado
      maxConcurrent: 3
      roles: [executor, reviewer]
    ${SCRIPTED_PROVIDER_IDS[1]}:
      kind: local-cli
      command: agente-roteirizado-revisor
      maxConcurrent: 2
      roles: [executor, reviewer]
`

/** Troca o bloco `providers:` inteiro, preservando o resto do arquivo do fixture. */
export function withMockProviders(projectText: string): string {
  const lines = projectText.split('\n')
  const start = lines.findIndex((line) => line.trimEnd() === 'providers:')
  if (start === -1) {
    throw new Error(`fixture: ${PROJECT_PATH} nao tem bloco \`providers:\``)
  }
  let end = start + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line === undefined) break
    if (line.trim().length > 0 && !line.startsWith(' ') && !line.startsWith('#')) break
    end += 1
  }
  return [...lines.slice(0, start), ...MOCK_PROVIDERS.split('\n'), ...lines.slice(end)].join('\n')
}

/**
 * Guarda de quota: todo id do registry precisa ser um dos que esta suite SUBSTITUI. Um id
 * que sobrasse da reescrita — `claude-code`, por exemplo — chegaria ao adapter de verdade e
 * a suite falaria com uma CLI real. A suite recusa subir nesse estado.
 */
export function assertZeroQuota(projectText: string): void {
  const parsed = parseProjectFile(projectText)
  if (!parsed.ok) {
    throw new Error(
      `fixture: ${PROJECT_PATH} invalido apos a reescrita: ${JSON.stringify(parsed.issues)}`,
    )
  }
  const substituidos = new Set<string>(SCRIPTED_PROVIDER_IDS)
  const estranhos = Object.keys(parsed.value.providers.registry).filter(
    (id) => !substituidos.has(id),
  )
  if (estranhos.length > 0) {
    throw new Error(`fixture: provider nao roteirizado apos a reescrita: ${estranhos.join(', ')}`)
  }
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

async function newestSourceMtime(): Promise<number> {
  const files = [
    join(REPO_ROOT, 'apps/web/index.html'),
    join(REPO_ROOT, 'apps/web/vite.config.ts'),
    join(REPO_ROOT, 'apps/web/package.json'),
    ...(await filesUnder(join(REPO_ROOT, 'apps/web/src'))),
    ...(await filesUnder(join(REPO_ROOT, 'packages/schemas/src'))),
  ]
  let newest = 0
  for (const file of files) {
    const info = await stat(file).catch(() => undefined)
    if (info !== undefined) newest = Math.max(newest, info.mtimeMs)
  }
  return newest
}

/**
 * O navegador precisa do BUILD do dashboard, nao do dev server: e o mesmo artefato que o
 * control plane serve em uso real. Reconstroi so quando o `dist` esta ausente ou velho.
 */
export async function ensureDashboardBuild(): Promise<void> {
  if (nodeProcess.env.AGENTIC_BROWSER_SKIP_BUILD === '1') return
  const built = await stat(WEB_INDEX).catch(() => undefined)
  if (built !== undefined && built.mtimeMs >= (await newestSourceMtime())) return
  const motivo = built === undefined ? 'ausente' : 'desatualizado'
  console.log(`[browser] build do dashboard ${motivo}: npm run build -w @agentic/web`)
  try {
    await exec('npm', ['run', 'build', '-w', '@agentic/web'], {
      cwd: REPO_ROOT,
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch (cause) {
    // `tsc` reporta diagnostico no STDOUT, e so o STDERR entra na mensagem do execFile. Sem
    // anexar a saida, o usuario le apenas `npm error command failed` e precisa rodar o build
    // de novo na mao para descobrir o que quebrou.
    const stdout = (cause as { readonly stdout?: unknown }).stdout
    const diagnostico =
      typeof stdout === 'string' && stdout.trim().length > 0 ? `\n${stdout.trim()}` : ''
    throw new Error(`falhou \`npm run build -w @agentic/web\`: ${String(cause)}${diagnostico}`)
  }
}

/** Copia o projeto-alvo para um diretorio descartavel e inicializa git de verdade nele. */
export async function materializeProject(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentic-browser-project-')))
  await cp(FIXTURE_ROOT, root, { recursive: true })

  const projectFile = join(root, PROJECT_PATH)
  const rewritten = withMockProviders(await readFile(projectFile, 'utf8'))
  assertZeroQuota(rewritten)
  await writeFile(projectFile, rewritten, 'utf8')

  // A missao GRANDE mora SO no projeto temporario: 28 tasks de mentira nao tem por que
  // entrar em `examples/`, que e documentacao viva do produto.
  const missionsDir = join(root, MISSIONS_PATH)
  await mkdir(missionsDir, { recursive: true })
  await writeFile(join(missionsDir, LARGE_MISSION_FILE), largeMissionYaml(), 'utf8')

  const git = async (...args: string[]): Promise<void> => {
    await exec('git', args, { cwd: root, encoding: 'utf8' })
  }
  await git('init', '-q', '-b', 'main')
  await git('config', 'user.name', 'Fixture Browser')
  await git('config', 'user.email', 'browser@example.invalid')
  await git('config', 'commit.gpgsign', 'false')
  await git('add', '-A')
  await git('commit', '--no-verify', '-q', '-m', 'estoque-cli: estado inicial')
  return root
}

export interface BrowserEnvironment {
  readonly baseURL: string
  readonly missionRef: string
  /** Missao gerada de 28 nos, so para o teste de legibilidade do canvas. */
  readonly largeMissionRef: string
  readonly projectRoot: string | undefined
  readonly managed: boolean
  close(): Promise<void>
}

/** Porta EFEMERA: a suite nunca disputa a 4317 com o control plane do proprio usuario. */
function portOf(server: RunningServer): number {
  const address = server.app.server.address()
  if (address === null || typeof address === 'string') {
    throw new Error(`servidor sem porta TCP: ${String(address)}`)
  }
  return address.port
}

let current: BrowserEnvironment | undefined

/**
 * Control plane REAL (banco, SSE, scheduler, worktrees, gates) com UMA substituicao: o
 * provider. `createControlPlane` + `attachServer` no lugar de `startServer` existe so por
 * isso — `startServer` monta o registry a partir do `project.yaml` e nao aceita roteiro, e
 * o mock sem roteiro nao entrega arquivo nenhum: toda task falharia por NO_CHANGES e o
 * dashboard nunca mostraria uma task DONE destravando a proxima, que e o que esta suite
 * precisa observar.
 */
async function openControlPlane(projectRoot: string): Promise<RunningServer> {
  const sources = await loadProjectSources({ repoRoot: projectRoot })
  const factory = scriptedFactory(browserStep)
  /**
   * A posse do projeto vem PRIMEIRO, como em `startServer` (I14).
   *
   * Trocar o registry nao dispensa ser dono: um plane sem lease recusa aprovar missao,
   * iniciar run e abrir orquestrador — que e exatamente o que estas specs fazem pela tela.
   * O projeto e temporario e descartavel, entao a disputa e sempre ganha; o que importa e
   * que este ambiente percorra o mesmo caminho do produto em vez de um atalho.
   */
  const posse = acquireControlPlaneOwnership({ baseDir: sources.runtimeDir })
  if (!posse.ok) {
    throw new Error(`ambiente de navegador: projeto ja possuido (${posse.detail})`)
  }
  const lease = posse.lease
  const plane = createControlPlane({
    project: sources.project,
    gatesFile: sources.gatesFile,
    repoRoot: sources.repoRoot,
    lease,
    // A substituicao e por id e cobre o registry inteiro — `assertZeroQuota` ja provou, no
    // texto do arquivo, que todo id aqui e um dos roteirizados.
    providerFactories: Object.fromEntries(
      Object.keys(sources.project.providers.registry).map((id) => [id, factory]),
    ),
  })
  try {
    const running = await attachServer({
      plane,
      instanceId: lease.instanceId,
      project: sources.project,
      projectText: sources.projectText,
      gatesText: sources.gatesText,
      repoRoot: sources.repoRoot,
      webDist: WEB_DIST,
      heartbeatMs: 5_000,
      host: '127.0.0.1',
      port: 0,
    })
    return {
      ...running,
      close: async (): Promise<void> => {
        await running.close()
        await plane.close()
        // A posse sai por ultimo: enquanto houver plane aberto, o projeto tem dono.
        lease.release()
      },
    }
  } catch (cause) {
    await plane.close().catch(() => undefined)
    lease.release()
    throw cause
  }
}

/**
 * Ambiente completo e descartavel: projeto temporario com git, control plane REAL
 * (servidor, banco, SSE e orquestrador) numa porta efemera, servindo o build de
 * `apps/web`. `AGENTIC_BROWSER_BASE_URL` conecta a suite a um control plane que ja esta no
 * ar em vez de subir um.
 */
/**
 * Guarda da valvula de escape.
 *
 * `AGENTIC_BROWSER_BASE_URL` nasceu em P02 para um smoke somente-leitura. As specs de P03
 * INICIAM MISSOES: apontar a variavel para um control plane com fornecedor real queimaria
 * assinatura de verdade. O ambiente gerenciado passa por `assertZeroQuota`; este caminho
 * nao passava por nada.
 *
 * Aqui nao da para reescrever o project.yaml alheio, entao a guarda pergunta ao proprio
 * control plane quem sao os fornecedores dele. Se algum nao for reconhecivel como
 * in-process, a suite RECUSA rodar — e recusa tambem quando nao consegue apurar, em vez de
 * assumir que esta tudo bem.
 */
async function assertExternalIsQuotaFree(baseURL: string): Promise<void> {
  const alvo = `${baseURL}/api/providers`
  let saude: ReadonlyArray<{ providerId?: string; version?: string }>
  try {
    const resposta = await fetch(alvo)
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`)
    saude = (await resposta.json()) as ReadonlyArray<{ providerId?: string; version?: string }>
  } catch (cause) {
    throw new Error(
      `AGENTIC_BROWSER_BASE_URL aponta para ${baseURL}, mas nao foi possivel apurar os ` +
        `fornecedores em ${alvo} (${String(cause)}). A suite escreve — inicia missoes — ` +
        'entao recusa rodar sem confirmar que nenhuma assinatura sera consumida.',
    )
  }

  const suspeitos = saude
    .filter((provider) => !ehInProcess(provider))
    .map((provider) => provider.providerId ?? '(sem id)')

  if (suspeitos.length > 0) {
    throw new Error(
      `AGENTIC_BROWSER_BASE_URL aponta para um control plane com fornecedor que pode ` +
        `consumir assinatura: ${suspeitos.join(', ')}. Esta suite inicia missoes de ` +
        'verdade. Use o ambiente gerenciado (sem a variavel) ou aponte para um control ' +
        'plane cujos fornecedores sejam todos in-process.',
    )
  }
}

/** Reconhece o provider in-process pelo que ele publica; na duvida, devolve false. */
function ehInProcess(provider: { providerId?: string; version?: string }): boolean {
  const versao = provider.version ?? ''
  return versao.endsWith('-mock')
}

export async function startBrowserEnvironment(): Promise<BrowserEnvironment> {
  if (current !== undefined) return current

  const external = nodeProcess.env.AGENTIC_BROWSER_BASE_URL
  if (external !== undefined && external.trim().length > 0) {
    const baseURL = external.trim().replace(/\/+$/, '')
    await assertExternalIsQuotaFree(baseURL)
    current = {
      baseURL,
      missionRef: MISSION_REF,
      largeMissionRef: LARGE_MISSION_REF,
      projectRoot: undefined,
      managed: false,
      close: async (): Promise<void> => undefined,
    }
    return current
  }

  await ensureDashboardBuild()
  const projectRoot = await materializeProject()
  const discard = async (): Promise<void> => {
    await rm(projectRoot, { recursive: true, force: true })
  }

  let server: RunningServer
  try {
    server = await openControlPlane(projectRoot)
  } catch (cause) {
    await discard()
    throw cause
  }

  const baseURL = `http://127.0.0.1:${portOf(server)}`
  try {
    await waitForHealth(baseURL)
  } catch (cause) {
    await server.close().catch(() => undefined)
    await discard()
    throw cause
  }

  current = {
    baseURL,
    missionRef: MISSION_REF,
    largeMissionRef: LARGE_MISSION_REF,
    projectRoot,
    managed: true,
    close: async (): Promise<void> => {
      await server.close()
      await discard()
    },
  }
  return current
}

/** Idempotente: teardown que roda duas vezes nao pode explodir nem deixar sujeira. */
export async function stopBrowserEnvironment(): Promise<void> {
  const environment = current
  current = undefined
  if (environment === undefined) return
  await environment.close()
}
