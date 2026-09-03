import type { DiscoveredCommand, GateCommandId } from './gate-discovery.js'

/**
 * Modelos escritos por `agentic init`. Sao YAML porque humano le, comenta e revisa o
 * arquivo — e ele e o contrato versionado (MISSION-FORMAT 1).
 *
 * Nada aqui e presumido. Nome do projeto, fornecedores e gates saem do que o `init`
 * OBSERVOU na maquina e no projeto; o que nao foi observado nao vira linha de configuracao.
 */

/** Aspas duplas para qualquer nome de pasta: `meu projeto`, `app.v2`, `1-coisa`. */
function yamlString(value: string): string {
  return JSON.stringify(value)
}

export interface ProviderTemplateEntry {
  readonly id: string
  readonly command: string
  readonly maxConcurrent: number
  readonly versionArgs: readonly string[]
}

/**
 * Fornecedores que o `init` sabe sondar sozinho, na ordem em que sao oferecidos.
 *
 * Ficam AQUI, na interface, e nao no dominio: P18 proibe o dominio citar fornecedor. A
 * ordem e a de declaracao — o primeiro observado pronto vira `providers.default`, e nada
 * alem disso a distingue.
 */
export const PROVIDER_CANDIDATES: readonly ProviderTemplateEntry[] = [
  { id: 'claude-code', command: 'claude', maxConcurrent: 3, versionArgs: ['--version'] },
  { id: 'codex', command: 'codex', maxConcurrent: 2, versionArgs: ['--version'] },
]

/** Provider de ensaio: entra so quando NAO ha CLI real pronta, e nomeado como tal. */
export const REHEARSAL_PROVIDER_ID = 'mock'

export interface ProjectTemplateInput {
  readonly name: string
  /** Vazio = nenhuma CLI real pronta; o modelo cai no provider de ensaio, dizendo isso. */
  readonly providers: readonly ProviderTemplateEntry[]
  /** `undefined` = nenhum gate detectado; `project.gates.missionGate` nem e escrito. */
  readonly missionGate?: string
}

function providerBlock(providers: readonly ProviderTemplateEntry[]): string {
  if (providers.length === 0) {
    return `  # Nenhuma CLI de agente foi observada PRONTA nesta maquina, entao o registry ficou
  # com o agente de ENSAIO. Ele nao escreve codigo e nao revisa: serve para conhecer o
  # formato. Instale e autentique uma CLI (${PROVIDER_CANDIDATES.map((p) => p.command).join(', ')}),
  # rode \`agentic providers\` e troque \`default\` pelo id dela.
  default: ${REHEARSAL_PROVIDER_ID}
  registry:
    ${REHEARSAL_PROVIDER_ID}:
      kind: inprocess
      maxConcurrent: 4
      roles: [executor]`
  }
  const lines = [
    '  # CLIs locais ja instaladas e autenticadas pelo usuario. Nenhuma API key (P17).',
    `  default: ${providers[0]?.id}`,
    '  registry:',
  ]
  for (const provider of providers) {
    lines.push(
      `    ${provider.id}:`,
      '      kind: local-cli',
      `      command: ${provider.command}`,
      `      versionArgs: [${provider.versionArgs.map((arg) => yamlString(arg)).join(', ')}]`,
      `      maxConcurrent: ${provider.maxConcurrent}`,
      '      roles: [executor, reviewer]',
    )
  }
  return lines.join('\n')
}

export function projectTemplate(input: ProjectTemplateInput): string {
  const gates =
    input.missionGate === undefined
      ? `gates:
  file: .agentic/gates.yaml
  # Nenhum gate foi detectado neste projeto: declare os seus em .agentic/gates.yaml e
  # aponte o mission gate aqui.`
      : `gates:
  file: .agentic/gates.yaml
  missionGate: ${input.missionGate}`

  return `apiVersion: agentic/v1
kind: Project

project:
  name: ${yamlString(input.name)}
  repoRoot: .

execution:
  workspace: git-worktree        # git-worktree | shared
  worktreeRoot: .agentic/worktrees
  maxParallelTasks: 2
  maxExecutors: 2
  maxReviewers: 1
  defaultMaxAttempts: 3
  attemptTimeoutMinutes: 30
  retryBackoffSeconds: 15
  # Sem isto a worktree nova nao tem node_modules nem .env e TODO gate falha.
  workspaceSetup:
    link:
      - node_modules
    commands: []
    timeoutMs: 600000

policies:
  enforceTouches: true
  requireReviewByDefault: true
  denyPaths:
    - .agentic/
    - .git/
    - .env
    - "*.pem"
  escalateOn:
    - attemptsExhausted
    - scopeViolationRepeated
    - reviewEscalate
  review:
    default: cross-provider-preferred
    byRisk:
      low: fresh-session
      medium: cross-provider-preferred
      high: cross-provider-required

integration:
  missionBranchPrefix: mission/
  taskBranchPrefix: task/
  strategy: rebase-merge
  autoPush: false

providers:
${providerBlock(input.providers)}

${gates}

server:
  host: 127.0.0.1
  port: 4317
`
}

/** Perfil rapido: o que um humano roda a cada mudanca. `build` e caro demais para isso. */
const FAST_COMMANDS: readonly GateCommandId[] = ['lint', 'typecheck', 'test']
/** Quando o projeto tem um comando guarda-chuva, o mission gate e ele — e so ele. */
const UMBRELLA_COMMAND: GateCommandId = 'verify'

export interface GateProfilePlan {
  readonly id: string
  readonly commands: readonly DiscoveredCommand[]
}

export interface GatesPlan {
  readonly profiles: readonly GateProfilePlan[]
  /** Gate usado pelas tasks; `undefined` quando nada foi detectado. */
  readonly taskGate?: string
  readonly missionGate?: string
}

/**
 * Traduz comandos DETECTADOS em perfis. Sem deteccao nao ha perfil: um `gates.yaml` vazio
 * e a resposta honesta para um projeto cujos comandos nos nao conhecemos.
 */
export function planGates(commands: readonly DiscoveredCommand[]): GatesPlan {
  if (commands.length === 0) return { profiles: [] }
  const umbrella = commands.find((command) => command.id === UMBRELLA_COMMAND)
  const fast = commands.filter((command) => FAST_COMMANDS.includes(command.id))
  const unit = fast.length > 0 ? fast : commands
  const mission = umbrella === undefined ? commands : [umbrella]
  return {
    profiles: [
      { id: 'unit', commands: unit },
      { id: 'mission', commands: mission },
    ],
    taskGate: 'unit',
    missionGate: 'mission',
  }
}

/** Teto por comando: generoso, mas finito — gate sem prazo trava o run em silencio. */
const GATE_TIMEOUT_MS: Readonly<Record<GateCommandId, number>> = {
  lint: 300_000,
  typecheck: 300_000,
  test: 900_000,
  build: 900_000,
  verify: 1_800_000,
}

export function gatesTemplate(plan: GatesPlan): string {
  const header = `apiVersion: agentic/v1
kind: Gates

# Comandos do SEU projeto, em qualquer linguagem. O control plane executa, mede e guarda
# a evidencia — nao tem opiniao sobre eles.
`
  if (plan.profiles.length === 0) {
    return `${header}
# Nenhum comando foi detectado neste projeto. Declare os seus abaixo — por exemplo:
#
# profiles:
#   unit:
#     commands:
#       - run: <o comando de teste do seu projeto>
#         timeoutMs: 900000

profiles: {}

env:
  allow: [PATH, HOME, NODE_ENV, CI, LANG]
`
  }
  const blocks = plan.profiles.map((profile) => {
    const lines = [`  ${profile.id}:`, '    commands:']
    for (const command of profile.commands) {
      lines.push(`      - run: ${command.run}`, `        timeoutMs: ${GATE_TIMEOUT_MS[command.id]}`)
    }
    return lines.join('\n')
  })
  return `${header}
profiles:
${blocks.join('\n\n')}

env:
  allow: [PATH, HOME, NODE_ENV, CI, LANG]
`
}

export const EXAMPLE_MISSION_ID = 'EXEMPLO-001'

export interface MissionTemplateInput {
  readonly taskGate?: string
  readonly missionGate?: string
}

/** `gate:` so aparece quando o gate existe: apontar para um perfil ausente nao compila. */
function gateLine(gate: string | undefined, indent: string): string {
  return gate === undefined ? '' : `\n${indent}gate: ${gate}`
}

export function missionTemplate(input: MissionTemplateInput = {}): string {
  const task = input.taskGate
  const mission = input.missionGate
  const leafGate = mission ?? task
  return `apiVersion: agentic/v1
kind: Mission

id: ${EXAMPLE_MISSION_ID}
title: Exemplo de missao
objective: >
  Entrega de exemplo para conhecer o formato. Substitua por uma entrega real com
  resultado verificavel.

scope:
  - O que esta missao entrega
outOfScope:
  - O que ela deliberadamente nao faz

constraints:
  - Sem nova dependencia de runtime

acceptanceCriteria:
  - O criterio observavel que prova a entrega

defaults:
  requireReview: true
  maxAttempts: 3${gateLine(task, '  ')}

phases:
  - id: foundation
    title: Fundacao
  - id: entrega
    title: Entrega
  - id: qualidade
    title: Qualidade

tasks:
  - id: T01
    phase: foundation
    title: Contrato compartilhado
    objective: Tipos e validacao usados pelo resto da missao, com teste de schema.
    dependencies: []
    touches:
      - src/contratos/
    validation:
      - Schema rejeita entrada invalida${gateLine(task, '    ')}
    risk: low
    estimate: 2

  - id: T02
    phase: entrega
    title: Implementacao do caso de uso
    objective: Caso de uso le e grava usando o contrato compartilhado.
    dependencies: [T01]
    touches:
      - src/aplicacao/
    reads:
      - src/contratos/
    validation:
      - Caso de uso cobre o caminho feliz e o de erro${gateLine(task, '    ')}
    risk: medium
    estimate: 3

  - id: T03
    phase: entrega
    title: Interface do usuario
    objective: Tela consome o caso de uso e mostra o erro sem quebrar.
    dependencies: [T01]
    touches:
      - src/ui/
    reads:
      - src/contratos/
    validation:
      - Tela renderiza estado de erro${gateLine(task, '    ')}
    risk: low
    estimate: 2

  # Folha da missao: usa o mission gate, entao a entrega integrada e verificada.
  - id: T04
    phase: qualidade
    title: Teste de ponta a ponta
    objective: Fluxo completo exercitado sobre a entrega integrada.
    dependencies: [T02, T03]
    touches:
      - tests/integracao/
    validation:
      - Fluxo passa duas vezes seguidas sem intervencao${gateLine(leafGate, '    ')}
    risk: low
    estimate: 2
${mission === undefined ? '' : `\nmissionGate: ${mission}\n`}`
}
