import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { toProviderHealthDto } from '@agentic/orchestrator'
import { type ProviderHealthDto, parseProjectFile, providerStateOf } from '@agentic/schemas'
import { AGENTIC_DIR, GATES_FILE, MISSIONS_DIR, PROJECT_FILE } from '../context.js'
import type { CommandDeps } from '../deps.js'
import { discoverGateCommands } from '../gate-discovery.js'
import { mergeGitignore } from '../gitignore.js'
import { createOutput } from '../output.js'
import { sanitize } from '../redact.js'
import { type CommandResult, ok } from '../result.js'
import {
  EXAMPLE_MISSION_ID,
  gatesTemplate,
  missionTemplate,
  PROVIDER_CANDIDATES,
  type ProviderTemplateEntry,
  planGates,
  projectTemplate,
} from '../templates.js'

export interface InitArgs {
  readonly dir?: string
  readonly json?: boolean
}

export interface InitProviderReport {
  readonly providerId: string
  readonly state: string
  readonly detail: string
}

export interface InitData {
  readonly baseDir: string
  readonly created: readonly string[]
  readonly skipped: readonly string[]
  /** Padroes acrescentados ao `.gitignore`; vazio quando ja estavam todos la. */
  readonly gitignore: readonly string[]
  /** Comandos que viraram gate, exatamente como serao executados. */
  readonly gates: readonly string[]
  /** O que a sonda observou por fornecedor candidato — inclusive os recusados. */
  readonly providers: readonly InitProviderReport[]
  /** `providers.default` escrito no arquivo. */
  readonly defaultProvider: string
  /** `true` = nenhuma CLI real pronta; o projeto NAO esta executavel como esta. */
  readonly rehearsalOnly: boolean
}

/** `wx` falha se o arquivo existe: nunca sobrescrevemos trabalho humano. */
async function writeIfAbsent(path: string, content: string): Promise<boolean> {
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (error) {
    const code = (error as { readonly code?: string }).code
    if (code === 'EEXIST') return false
    throw error
  }
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Quais CLIs de agente estao PRONTAS nesta maquina, medido — nunca presumido.
 *
 * A sonda e a mesma de `agentic providers`: `--version` prova instalacao e o comando de
 * sessao prova autenticacao. `READY` e o unico estado que autoriza um fornecedor a entrar
 * no registry como executor real; `INSTALLED` (prontidao nao apurada) e `NOT_READY` ficam
 * de fora, mas aparecem no relato com o motivo, que e o que o humano precisa consertar.
 */
async function probeProviders(
  deps: CommandDeps,
): Promise<{ readonly ready: ProviderTemplateEntry[]; readonly report: InitProviderReport[] }> {
  const candidateText = projectTemplate({ name: 'candidatos', providers: PROVIDER_CANDIDATES })
  const parsed = parseProjectFile(candidateText)
  if (!parsed.ok) {
    // O modelo dos candidatos e nosso: se ele nao parseia, o defeito e do produto e nao do
    // usuario. Nao ha adivinhacao possivel aqui — o init segue sem fornecedor observado.
    return { ready: [], report: [] }
  }
  let health: readonly ProviderHealthDto[]
  try {
    health = (await deps.registry(parsed.value).health()).map(toProviderHealthDto)
  } catch {
    return { ready: [], report: [] }
  }
  const byId = new Map(health.map((entry) => [entry.providerId, entry]))
  const ready: ProviderTemplateEntry[] = []
  const report: InitProviderReport[] = []
  for (const candidate of PROVIDER_CANDIDATES) {
    const observed = byId.get(candidate.id)
    if (observed === undefined) continue
    const state = providerStateOf(observed)
    report.push({ providerId: candidate.id, state, detail: sanitize(observed.detail) })
    if (state === 'READY') ready.push(candidate)
  }
  return { ready, report }
}

/**
 * `agentic init`: cria `.agentic/` com projeto, gates e uma missao de exemplo, protege o
 * estado local no `.gitignore` e escreve APENAS o que foi observado.
 *
 * Idempotente por construcao — o que ja existe e listado como preservado, e o `.gitignore`
 * so recebe o padrao que faltava.
 */
export async function initCommand(args: InitArgs, deps: CommandDeps): Promise<CommandResult> {
  const out = createOutput(deps, args.json === true)
  const root = resolve(deps.cwd, args.dir ?? '.')
  const baseDir = join(root, AGENTIC_DIR)
  await mkdir(join(baseDir, MISSIONS_DIR), { recursive: true })

  const discovery = await discoverGateCommands(root)
  const plan = planGates(discovery.commands)
  const probed = await probeProviders(deps)

  const files: readonly (readonly [string, string])[] = [
    [
      join(baseDir, PROJECT_FILE),
      projectTemplate({
        name: basename(root),
        providers: probed.ready,
        ...(plan.missionGate === undefined ? {} : { missionGate: plan.missionGate }),
      }),
    ],
    [join(baseDir, GATES_FILE), gatesTemplate(plan)],
    [
      join(baseDir, MISSIONS_DIR, `${EXAMPLE_MISSION_ID}.mission.yaml`),
      missionTemplate({
        ...(plan.taskGate === undefined ? {} : { taskGate: plan.taskGate }),
        ...(plan.missionGate === undefined ? {} : { missionGate: plan.missionGate }),
      }),
    ],
  ]

  const created: string[] = []
  const skipped: string[] = []
  for (const [path, content] of files) {
    const wrote = await writeIfAbsent(path, content)
    ;(wrote ? created : skipped).push(relative(root, path))
  }

  // O `.gitignore` e do humano: acrescentamos o que falta, no fim, e nunca reescrevemos.
  // Sem isto o observador do repositorio hasheia `state.db-wal` e o planejamento e recusado
  // com "o repositorio mudou durante o planejamento" (V0.3.0-PLAN P2).
  const gitignorePath = join(root, '.gitignore')
  const merged = mergeGitignore(await readIfPresent(gitignorePath))
  if (merged.added.length > 0) await writeFile(gitignorePath, merged.text, 'utf8')

  const rehearsalOnly = probed.ready.length === 0
  const defaultProvider = probed.ready[0]?.id ?? 'mock'

  out.line(`projeto agentico em ${baseDir}`)
  out.line()
  for (const path of created) out.line(`  criado      ${path}`)
  for (const path of skipped) out.line(`  preservado  ${path}`)
  if (merged.added.length > 0) {
    out.line(`  gitignore   ${merged.added.length} padrao(oes) de estado local acrescentado(s)`)
  }
  out.line()

  out.line('gates')
  if (plan.profiles.length === 0) {
    out.line('  nenhum comando detectado; declare os seus em .agentic/gates.yaml')
  } else {
    for (const profile of plan.profiles) {
      out.line(`  ${profile.id}: ${profile.commands.map((command) => command.run).join(', ')}`)
    }
  }
  out.line()

  out.line('fornecedores')
  if (probed.report.length === 0) {
    out.line('  nenhuma sonda concluida')
  } else {
    for (const entry of probed.report) {
      out.line(
        `  ${entry.providerId}: ${entry.state}${entry.detail === '' ? '' : ` — ${entry.detail}`}`,
      )
    }
  }
  out.line()

  if (rehearsalOnly) {
    // PROVIDER_REQUIRED dito com todas as letras: o projeto foi criado, mas nao executa.
    // Fingir o contrario e exatamente o que este lote existe para acabar.
    out.line('ATENCAO: nenhuma CLI de agente esta PRONTA nesta maquina.')
    out.line(
      `  \`providers.default\` ficou em \`mock\` — agente de ENSAIO, que nao escreve codigo e nao revisa.`,
    )
    out.line(
      `  Instale e autentique uma CLI (${PROVIDER_CANDIDATES.map((c) => c.command).join(' ou ')}), rode \`agentic providers\``,
    )
    out.line('  e troque `providers.default` em .agentic/project.yaml pelo id dela.')
  } else {
    out.line(`executor padrao: ${defaultProvider}`)
  }
  out.line()
  out.line(
    'proximo passo: agentic mission validate ' +
      join(AGENTIC_DIR, MISSIONS_DIR, `${EXAMPLE_MISSION_ID}.mission.yaml`),
  )

  const data: InitData = {
    baseDir,
    created,
    skipped,
    gitignore: merged.added,
    gates: plan.profiles.flatMap((profile) => profile.commands.map((command) => command.run)),
    providers: probed.report,
    defaultProvider,
    rehearsalOnly,
  }
  return ok('init', data)
}
