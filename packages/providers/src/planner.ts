import nodeProcess from 'node:process'
import { createLocalAgentRuntime, isAgentRuntimeError } from '@agentic/agent-runtime'
import type {
  ExitStatus,
  LocalAgentProcess,
  LocalAgentSpec,
  MissionPlanner,
  MissionPlannerRegistry,
  MissionProposal,
  PathScope,
  PlanningCapabilities,
  PlanningContext,
  PlanningFailure,
  PlanningFailureCode,
  PlanningRefused,
  PlanningRequest,
  PlanningResult,
  PlanProblem,
  PlanRevision,
  ProviderCapabilities,
  ProviderHealth,
  ProviderId,
} from '@agentic/domain'
import {
  isPathInScope,
  MAX_PLAN_REVISIONS,
  MISSION_ID_PATTERN,
  PHASE_ID_PATTERN,
  pathScopeSegments,
  REVIEW_POLICIES,
  RISKS,
  TASK_ID_PATTERN,
  providerId as toProviderId,
  tryPathScope,
} from '@agentic/domain'
import {
  canonicalMissionPlan,
  missionFileFromPlan,
  parseMissionPlan,
  parseYamlDocument,
  planProblemLines,
  planProblemsOf,
  toMissionSpec,
  toPlainValue,
} from '@agentic/schemas'
import type { PromptSection } from './assignment-prompt.js'
import { renderSections } from './assignment-prompt.js'
import { CLAUDE_CODE_DESCRIPTOR } from './claude-code.js'
import { CODEX_DESCRIPTOR } from './codex.js'
import {
  describeUnknownError,
  InvalidProviderDescriptorError,
  UnknownProviderError,
} from './errors.js'
import type { LocalCliDescriptor, LocalCliRuntime } from './local-cli.js'
import { cancelReasonOf, spawnErrorOf } from './outcome.js'

/** Delimitadores do bloco de resposta. Texto fora deles e conversa, nao plano. */
export const PLAN_BLOCK_BEGIN = '<<<AGENTIC-PLAN'
export const PLAN_BLOCK_END = 'AGENTIC-PLAN>>>'

export const PLANNING_HEADING = '# Proposta de missao — planejamento'

/**
 * Teto da saida acumulada. Existe para que um planejador em laco nao consuma a memoria do
 * control plane; passar daqui e falha EXPLICADA, jamais plano cortado — meia missao
 * compila e engana (ADR-0013).
 */
export const DEFAULT_MAX_PLANNER_OUTPUT_CHARS = 4_000_000

/**
 * Espelha DEFAULT_MAX_LINE_CHARS de @agentic/process, que `providers` nao pode importar
 * (fronteira ADR-0001). E o tamanho EXATO em que o runtime corta uma linha longa, e por isso
 * o unico sinal disponivel para distinguir fragmento de quebra real ao remontar a saida.
 */
export const RUNTIME_LINE_FRAGMENT_CHARS = 64 * 1024

/**
 * Quanto da proposta anterior volta no pedido de correcao. O prompt viaja como argumento
 * do processo, e argumento tem teto de sistema operacional: sem este corte, um plano
 * gigante recusado inviabilizaria a propria correcao. O corte aparece no texto.
 */
export const MAX_REVISION_PREVIOUS_CHARS = 60_000

/**
 * Ambiente do processo do planejador: allowlist por NOME, valores vindos do processo pai.
 * Nenhuma credencial e lida, guardada ou injetada — a sessao da CLI e do usuario e mora
 * onde ela ja mora (P17/ADR-0009).
 */
export const PLANNER_ENV_ALLOW: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
]

/** Nome que parece credencial nao passa, nem se alguem o listar por engano. */
const CREDENTIAL_NAME = /KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD/i

/**
 * Argumentos que concedem escrita ou pulam aprovacao nas CLIs que conhecemos. Planejar e
 * leitura: qualquer um destes na configuracao e erro de descritor, nao preferencia.
 */
export const WRITE_GRANTING_ARGS: readonly string[] = [
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--full-auto',
  'acceptedits',
  'bypasspermissions',
  'workspace-write',
  'danger-full-access',
]

/** Referencia de log quando nao houve processo (recusa antes de acionar a CLI). */
const NO_PROCESS_REF = 'sem-processo'

export function plannerLogsRef(id: ProviderId, handle: string): string {
  return `plan-log:${id}/${handle}`
}

export function plannerEnv(
  allow: readonly string[] = PLANNER_ENV_ALLOW,
  source: Readonly<Record<string, string | undefined>> = nodeProcess.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of allow) {
    if (CREDENTIAL_NAME.test(name)) continue
    const value = source[name]
    if (typeof value === 'string') env[name] = value
  }
  return env
}

/** Defesa em profundidade: mesmo ambiente montado por outro codigo perde nome de segredo. */
export function withoutCredentials(env: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (!CREDENTIAL_NAME.test(name)) out[name] = value
  }
  return out
}

/**
 * `--sandbox workspace-write` e `--sandbox=workspace-write` sao o MESMO pedido; comparar o
 * token inteiro por igualdade so pegava o primeiro. Cada argumento e quebrado no `=` e cada
 * metade e conferida, e o valor tambem e procurado como substring — a forma colada
 * (`--permission-mode=acceptEdits`) escapava da lista.
 *
 * Isto e checagem de CONFIGURACAO, nao sandbox: um descritor mal-intencionado ainda pode
 * pedir escrita por um argumento que nao conhecemos. A garantia de que o planejamento nao
 * alterou o repositorio e o diff conferido pelo control plane depois da chamada (ADR-0013),
 * nao esta barreira. Ela existe para que um erro de configuracao falhe cedo e explicado.
 */
function grantsWrite(arg: string): boolean {
  const token = arg.trim().toLowerCase()
  const pieces = token.split('=')
  return WRITE_GRANTING_ARGS.some(
    (banned) => pieces.includes(banned) || (banned.includes('-') && token.includes(banned)),
  )
}

export function assertReadOnlyPlanArgs(id: string, args: readonly string[]): void {
  const granting = args.filter((arg) => grantsWrite(arg))
  if (granting.length === 0) return
  throw new InvalidProviderDescriptorError(
    id,
    `planejar e leitura: argumento que concede escrita nao entra (${granting.join(', ')})`,
  )
}

// --------------------------------------------------------------------------------------
// Prompt
// --------------------------------------------------------------------------------------

const NONE = '(nenhum)'

function bullets(values: readonly string[]): string[] {
  return values.length === 0 ? [NONE] : values.map((value) => `- ${value}`)
}

/**
 * O contrato do plano dito em palavras, derivado dos MESMOS padroes que a validacao usa.
 * Escrever a lista a mao criaria um segundo contrato para envelhecer sozinho.
 */
function formatSection(): PromptSection {
  return {
    title: 'Formato do plano',
    lines: [
      `- id: identificador da missao, casa ${MISSION_ID_PATTERN.source}`,
      '- title e objective sao obrigatorios; description e opcional',
      '- scope, outOfScope e constraints: listas de texto, opcionais',
      '- acceptanceCriteria: lista de texto com ao menos um item',
      '- defaults (opcional): requireReview, maxAttempts, gate, agentProfile, reviewPolicy',
      `- phases: ao menos uma, cada uma { id casando ${PHASE_ID_PATTERN.source}, title, order? }`,
      `- tasks: ao menos uma, cada uma { id casando ${TASK_ID_PATTERN.source}, phase, title,`,
      '  objective, description?, dependencies, touches, reads?, validation, gate?,',
      '  requireReview?, maxAttempts?, risk, estimate, agentProfile?, reviewPolicy? }',
      `- risk: ${RISKS.join(' | ')}`,
      `- reviewPolicy: ${REVIEW_POLICIES.join(' | ')}`,
      '- touches e reads: caminhos POSIX relativos a raiz, sem glob, sem ".." e sem "/" inicial',
      '- NAO declare apiVersion nem kind: a versao do formato e decisao do control plane',
      '- chave desconhecida reprova o plano inteiro; nao invente campo',
    ],
  }
}

function answerSection(): PromptSection {
  return {
    title: 'Como responder',
    lines: [
      '- responda com UM bloco, exatamente nesta forma:',
      `  ${PLAN_BLOCK_BEGIN}`,
      '  {"rationale": "por que este plano", "plan": { conteudo da missao }}',
      `  ${PLAN_BLOCK_END}`,
      '- dentro do bloco, JSON valido e nada mais; o texto fora do bloco e ignorado',
      '- `rationale` e relato seu, nao decide nada; `plan` e o que sera validado',
      '- nao grave arquivo nenhum: quem escreve o arquivo da missao e o control plane',
      '- nao rode comando, nao altere codigo, nao aprove nada: propor e todo o seu papel',
      '- plano fora do contrato vira falha explicada, nunca missao pela metade',
    ],
  }
}

/** Corte declarado: o planejador ve que faltou pedaco, em vez de receber texto mutilado. */
function boundedPrevious(previous: string): string {
  if (previous.length <= MAX_REVISION_PREVIOUS_CHARS) return previous
  const kept = previous.slice(0, MAX_REVISION_PREVIOUS_CHARS)
  return `${kept}\n[... proposta anterior cortada em ${MAX_REVISION_PREVIOUS_CHARS} caracteres ...]`
}

function revisionSection(revision: PlanRevision): PromptSection {
  return {
    title: `Correcao pedida (${revision.attempt} de ${MAX_PLAN_REVISIONS})`,
    lines: [
      'A proposta anterior foi recusada. Corrija os pontos abaixo e devolva o plano INTEIRO.',
      'Repetir a proposta anterior encerra o ciclo sem plano.',
      '',
      'Problemas apontados:',
      ...bullets(planProblemLines(revision.problems)),
      '',
      'Proposta anterior:',
      boundedPrevious(revision.previous),
    ],
  }
}

export function planningSections(request: PlanningRequest): PromptSection[] {
  const context = request.context
  const sections: PromptSection[] = [
    { title: 'Pedido do humano', lines: [request.prompt] },
    {
      title: 'Raiz de leitura',
      lines: [
        `- diretorio: ${context.readRoot}`,
        '- leia o que precisar aqui dentro; o processo roda sem permissao de escrita',
        '- nao existe worktree, task nem tentativa: planejar acontece antes da missao existir',
      ],
    },
    {
      title: 'Ids de missao ja ocupados',
      lines: [...bullets([...context.takenMissionIds]), '- proponha um id que nao esteja aqui'],
    },
    {
      title: 'Gates declarados pelo projeto',
      lines: [
        ...bullets([...context.availableGates]),
        '- so estes existem; referenciar gate fora da lista reprova o plano',
      ],
    },
    { title: 'Restricoes do projeto', lines: bullets([...context.constraints]) },
    {
      title: 'Caminhos proibidos (denyPaths)',
      lines: [
        ...bullets([...context.denyPaths]),
        '- nenhuma task pode declarar touches dentro deles',
      ],
    },
    formatSection(),
  ]
  if (request.revision !== undefined) sections.push(revisionSection(request.revision))
  sections.push(answerSection())
  return sections
}

export function planningPromptText(request: PlanningRequest): string {
  return renderSections(PLANNING_HEADING, planningSections(request))
}

// --------------------------------------------------------------------------------------
// Leitura da saida: candidatos, envelope e contrato
// --------------------------------------------------------------------------------------

/** Blocos entre os marcadores que pedimos. Preferidos a qualquer outro candidato. */
function markerBlocks(text: string): string[] {
  const out: string[] = []
  let from = 0
  for (;;) {
    const begin = text.indexOf(PLAN_BLOCK_BEGIN, from)
    if (begin === -1) return out
    const contentAt = begin + PLAN_BLOCK_BEGIN.length
    const end = text.indexOf(PLAN_BLOCK_END, contentAt)
    if (end === -1) return out
    out.push(text.slice(contentAt, end))
    from = end + PLAN_BLOCK_END.length
  }
}

/** Bloco cercado por crases: a forma que uma CLI conversadora costuma usar sozinha. */
function fencedBlocks(text: string): string[] {
  const out: string[] = []
  const fence = /```[a-zA-Z0-9]*\r?\n([\s\S]*?)```/g
  let match = fence.exec(text)
  while (match !== null) {
    if (match[1] !== undefined) out.push(match[1])
    match = fence.exec(text)
  }
  return out
}

/**
 * Ultimo recurso: objetos de primeiro nivel achados por contagem de chaves, respeitando
 * string e escape. Nao "conserta" JSON — so isola o que pode ser um.
 */
function bracedObjects(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (char === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start !== -1) out.push(text.slice(start, i + 1))
    }
  }
  return out
}

interface Envelope {
  readonly planText: string
  readonly rationale?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function rationaleOf(record: Record<string, unknown>): string | undefined {
  const value = record.rationale
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function encode(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

/**
 * Aceita as tres formas que aparecem na pratica: o envelope que pedimos (`plan` ou
 * `mission` mais `rationale`), e o plano cru com um `rationale` grudado nele. Fora disso o
 * texto segue inteiro para a validacao — a recusa e do contrato, nao de um palpite nosso.
 */
function envelopeOf(payload: string): Envelope | undefined {
  const parsed = parseYamlDocument(payload)
  if (!parsed.ok) return undefined
  const record = asRecord(toPlainValue(parsed.value))
  if (record === undefined) return undefined
  const rationale = rationaleOf(record)
  const inner = asRecord(record.plan) ?? asRecord(record.mission)
  if (inner !== undefined) {
    const planText = encode(inner)
    return planText === undefined ? undefined : { planText, rationale }
  }
  if (rationale === undefined || record.tasks === undefined) return undefined
  const { rationale: _ignored, ...plan } = record
  const planText = encode(plan)
  return planText === undefined ? undefined : { planText, rationale }
}

export interface PlanAccepted {
  readonly ok: true
  readonly proposal: MissionProposal
  /** Forma canonica, para detectar correcao que so repete a proposta anterior. */
  readonly canonical: string
  readonly raw: string
}

export interface PlanRejected {
  readonly ok: false
  readonly code: 'NO_PROPOSAL' | 'CONTRACT_REJECTED'
  readonly problems: readonly PlanProblem[]
  readonly raw?: string
}

export type PlanReading = PlanAccepted | PlanRejected

function readCandidate(payload: string): PlanReading {
  const envelope = envelopeOf(payload)
  const planText = envelope?.planText ?? payload
  const parsed = parseMissionPlan(planText)
  if (!parsed.ok) {
    return {
      ok: false,
      code: 'CONTRACT_REJECTED',
      problems: planProblemsOf(parsed.issues),
      raw: payload,
    }
  }
  const mission = toMissionSpec(missionFileFromPlan(parsed.value))
  const rationale = envelope?.rationale
  const proposal: MissionProposal = rationale === undefined ? { mission } : { mission, rationale }
  return { ok: true, proposal, canonical: canonicalMissionPlan(parsed.value), raw: payload }
}

/**
 * Saida crua -> proposta validada ou recusa explicada. Os grupos de candidatos vao do mais
 * intencional (o bloco que pedimos) ao mais especulativo, e dentro do grupo o ultimo vem
 * primeiro: CLI que ecoa a instrucao antes de responder nao rouba o lugar da resposta.
 */
export function readMissionProposal(text: string): PlanReading {
  const groups: (() => string[])[] = [
    () => markerBlocks(text),
    () => fencedBlocks(text),
    () => bracedObjects(text),
  ]
  let firstRejection: PlanRejected | undefined
  for (const group of groups) {
    const candidates = group()
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const candidate = candidates[i]
      if (candidate === undefined || candidate.trim().length === 0) continue
      const reading = readCandidate(candidate)
      if (reading.ok) return reading
      firstRejection ??= reading
    }
  }
  if (firstRejection !== undefined) return firstRejection
  return { ok: false, code: 'NO_PROPOSAL', problems: [] }
}

/** Forma canonica do que o planejador propos antes, quando ainda da para reconhecer. */
export function canonicalOf(text: string): string | undefined {
  const reading = readMissionProposal(text)
  return reading.ok ? reading.canonical : undefined
}

// --------------------------------------------------------------------------------------
// Resultado
// --------------------------------------------------------------------------------------

interface RefusalInput {
  readonly code: PlanningFailureCode
  readonly message: string
  readonly problems?: readonly PlanProblem[]
  readonly raw?: string
  readonly logsRef: string
}

function refused(input: RefusalInput): PlanningRefused {
  const failure: PlanningFailure = {
    code: input.code,
    message: input.message,
    problems: input.problems ?? [],
    ...(input.raw === undefined || input.raw.length === 0 ? {} : { raw: input.raw }),
  }
  return { outcome: 'refused', failure, logsRef: input.logsRef }
}

function rejectionMessage(reading: PlanRejected): string {
  if (reading.code === 'NO_PROPOSAL') {
    return 'o planejador terminou sem nenhum plano legivel na saida'
  }
  const count = reading.problems.length
  return `a proposta feriu o contrato do plano em ${count} ponto${count === 1 ? '' : 's'}`
}

/**
 * Traducao unica da saida para `PlanningResult`, usada tanto pelo adapter de CLI quanto
 * pelo planejador de roteiro: os dois recusam pelos mesmos motivos e com as mesmas frases.
 */
export function planningResultFrom(
  text: string,
  request: PlanningRequest,
  logsRef: string,
): PlanningResult {
  const reading = readMissionProposal(text)
  if (!reading.ok) {
    return refused({
      code: reading.code,
      message: rejectionMessage(reading),
      problems: reading.problems,
      raw: reading.raw ?? text,
      logsRef,
    })
  }
  const previous =
    request.revision === undefined ? undefined : canonicalOf(request.revision.previous)
  if (previous !== undefined && previous === reading.canonical) {
    return refused({
      code: 'PLAN_UNCHANGED',
      message: 'a correcao repetiu o plano anterior; insistir so gastaria assinatura',
      raw: reading.raw,
      logsRef,
    })
  }
  const offenses = contextProblems(reading.proposal, request.context)
  if (offenses.length > 0) {
    return refused({
      code: 'CONTRACT_REJECTED',
      message: 'a proposta contraria o contexto do projeto',
      problems: offenses,
      raw: reading.raw,
      logsRef,
    })
  }
  return { outcome: 'proposed', proposal: reading.proposal, logsRef }
}

/**
 * Validar a FORMA do plano nao basta: um plano bem-formado ainda pode ocupar um id de missao
 * que ja existe, citar gate que o projeto nao declara, ou pedir escrita dentro de denyPaths.
 * Nada disso e opiniao — `PlanningContext` traz os tres fatos, e aceitar assim mesmo
 * empurraria a recusa para o compilador ou, pior, para a execucao.
 */
const REGEXP_SPECIALS = /[.+^${}()|[\]\\]/g

/**
 * `denyPaths` aceita glob porque e configuracao escrita por humano (DOMAIN-MODEL: "podem
 * conter glob, por isso sao strings cruas"): `*.pem` nega qualquer `.pem`, e `*` nao
 * atravessa `/`. Comparar so por prefixo deixava `certs/server.pem` passar.
 *
 * MESMA semantica de `deniedBy` em packages/compiler/src/paths.ts, reescrita aqui porque a
 * fronteira nao deixa `providers` importar `compiler` (ADR-0001). Duplicacao deliberada e
 * anotada: se a regra mudar la, muda aqui.
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(REGEXP_SPECIALS, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
  return new RegExp(`^${escaped}$`)
}

export function deniedByPattern(touch: string, denyPaths: readonly string[]): string | undefined {
  const scope = tryPathScope(touch)
  if (scope === undefined) return undefined
  const plain = pathScopeSegments(scope).join('/')
  const ultimo =
    plain
      .split('/')
      .filter((part) => part.length > 0)
      .at(-1) ?? plain
  return denyPaths.find((pattern) => {
    const asScope = tryPathScope(String(pattern))
    if (asScope !== undefined) return isPathInScope(plain, asScope)
    const expression = globToRegExp(String(pattern))
    return expression.test(plain) || expression.test(ultimo)
  })
}

export function contextProblems(
  proposal: MissionProposal,
  context: PlanningContext,
): PlanProblem[] {
  const problems: PlanProblem[] = []
  const mission = proposal.mission
  if (context.takenMissionIds.some((taken) => String(taken) === String(mission.id))) {
    problems.push({ path: 'mission.id', message: `id ${String(mission.id)} ja esta ocupado` })
  }

  const gates = new Set(context.availableGates.map((gate) => String(gate)))
  const missionGate = mission.missionGate === undefined ? undefined : String(mission.missionGate)
  if (missionGate !== undefined && !gates.has(missionGate)) {
    problems.push({
      path: 'mission.missionGate',
      message: `gate ${missionGate} nao existe no projeto`,
    })
  }

  // Comparacao textual por prefixo errava nos dois sentidos: `banned.startsWith(alvo)` dava
  // falso positivo e nenhum dos dois respeitava fronteira de segmento. `isPathInAnyScope`
  // compara por SEGMENTO, que e a mesma regra que reprova a tentativa por escopo.
  //
  // denyPath com glob (o projeto declara `*.pem`) nao entra: `pathScope` recusa glob por
  // construcao, entao aqui ele e ignorado — como em todo o resto do produto. Fechar glob
  // seria mudar o modelo de PathScope no dominio, nao remendar este adapter.
  for (const task of mission.tasks) {
    const gate = task.gate === undefined ? undefined : String(task.gate)
    if (gate !== undefined && !gates.has(gate)) {
      problems.push({
        path: `tasks.${String(task.id)}.gate`,
        message: `gate ${gate} nao existe no projeto`,
      })
    }
    for (const touch of task.touches ?? []) {
      const alvo = String(touch)
      const negado = deniedByPattern(alvo, context.denyPaths)
      if (negado !== undefined) {
        problems.push({
          path: `tasks.${String(task.id)}.touches`,
          message: `${alvo} cai em caminho proibido (${negado})`,
        })
      }
    }
  }
  return problems
}

// --------------------------------------------------------------------------------------
// Descritores
// --------------------------------------------------------------------------------------

export interface LocalCliPlannerDescriptor {
  readonly id: string
  readonly command: string
  readonly versionArgs: readonly string[]
  readonly readinessProbe: 'supported' | 'unsupported'
  /** So existe quando `readinessProbe === 'supported'`. */
  readonly readinessArgs?: readonly string[]
  /** Modo nao interativo de LEITURA, antes do texto do pedido. */
  readonly planArgs: readonly string[]
}

/**
 * O descritor de planejamento nasce do descritor de execucao da MESMA CLI: comando,
 * `--version` e sonda de prontidao continuam vindo de um lugar so. O que muda e o modo —
 * e o modo do planejador e leitura.
 */
export function plannerDescriptorFrom(
  descriptor: LocalCliDescriptor,
  planArgs: readonly string[],
): LocalCliPlannerDescriptor {
  const base: LocalCliPlannerDescriptor = {
    id: descriptor.id,
    command: descriptor.command,
    versionArgs: descriptor.versionArgs,
    readinessProbe: descriptor.capabilities.readinessProbe,
    planArgs,
  }
  return descriptor.readinessArgs === undefined
    ? base
    : { ...base, readinessArgs: descriptor.readinessArgs }
}

/**
 * `--permission-mode plan` e o modo cuja finalidade e exatamente esta: propor sem alterar.
 * `acceptEdits`, usado no despacho de tentativa, NAO entra aqui — planejar nao escreve.
 */
export const CLAUDE_CODE_PLAN_ARGS: readonly string[] = [
  '--print',
  '--output-format',
  'text',
  '--permission-mode',
  'plan',
]

/**
 * `read-only` ja e o default do `codex exec`; declaramos assim mesmo para que o modo seja
 * fato do descritor, e nao herança de um default que pode mudar de versao.
 */
export const CODEX_PLAN_ARGS: readonly string[] = ['exec', '--sandbox', 'read-only']

export const CLAUDE_CODE_PLANNER_DESCRIPTOR: LocalCliPlannerDescriptor = plannerDescriptorFrom(
  CLAUDE_CODE_DESCRIPTOR,
  CLAUDE_CODE_PLAN_ARGS,
)

export const CODEX_PLANNER_DESCRIPTOR: LocalCliPlannerDescriptor = plannerDescriptorFrom(
  CODEX_DESCRIPTOR,
  CODEX_PLAN_ARGS,
)

/** Os nomes de CLI seguem confinados a este pacote (P18); o dominio nao os conhece. */
export const BUILT_IN_PLANNER_DESCRIPTORS: Readonly<Record<string, LocalCliPlannerDescriptor>> = {
  [CLAUDE_CODE_PLANNER_DESCRIPTOR.id]: CLAUDE_CODE_PLANNER_DESCRIPTOR,
  [CODEX_PLANNER_DESCRIPTOR.id]: CODEX_PLANNER_DESCRIPTOR,
}

// --------------------------------------------------------------------------------------
// Planejador sobre CLI local
// --------------------------------------------------------------------------------------

export interface LocalCliMissionPlannerOptions {
  readonly id?: ProviderId
  readonly command?: string
  readonly runtime?: LocalCliRuntime
  readonly planArgs?: readonly string[]
  readonly versionArgs?: readonly string[]
  /** Ambiente exato do processo. Ausente: a allowlist `PLANNER_ENV_ALLOW`. */
  readonly env?: Readonly<Record<string, string>>
  readonly envAllow?: readonly string[]
  readonly maxOutputChars?: number
  /** Desliga a sonda de prontidao antes de planejar; a sonda de `health()` continua. */
  readonly probeBeforePlan?: boolean
  readonly now?: () => number
}

/** Saida acumulada com teto declarado. Passar do teto e fato reportado, nao corte mudo. */
export class OutputBudget {
  readonly #limit: number
  readonly #stdout: string[] = []
  readonly #stderr: string[] = []
  #chars = 0
  #exceeded = false

  constructor(limit: number) {
    this.#limit = Math.max(1, limit)
  }

  get exceeded(): boolean {
    return this.#exceeded
  }

  get limit(): number {
    return this.#limit
  }

  push(stream: 'stdout' | 'stderr', line: string): void {
    if (this.#exceeded) return
    const next = this.#chars + line.length + 1
    if (next > this.#limit) {
      this.#exceeded = true
      return
    }
    this.#chars = next
    ;(stream === 'stdout' ? this.#stdout : this.#stderr).push(line)
  }

  text(stream: 'stdout' | 'stderr'): string {
    return (stream === 'stdout' ? this.#stdout : this.#stderr).join('\n')
  }

  /**
   * Acima de RUNTIME_LINE_FRAGMENT_CHARS o runtime CORTA a linha e entrega em pedacos, sem
   * dizer que cortou. Sem esse metadado nao da para remontar com seguranca:
   *
   *   - `join('\n')` inventa quebra que o planejador nao escreveu e corrompe plano de linha
   *     unica volumoso;
   *   - `join('')` apaga quebra real e pode CONSERTAR saida malformada (`tr` + `ue` vira
   *     `true`), fazendo passar um plano que o planejador nao produziu;
   *   - usar o tamanho como prova de fragmento erra numa linha real de exatamente o teto.
   *
   * Adivinhar aqui e escolher entre dois modos de aceitar plano errado. O produto ja tem
   * regra para isso: falha EXPLICADA, jamais plano remendado. Entao a fragmentacao vira
   * recusa, e o prompt pede plano quebrado em linhas.
   */
  fragmented(stream: 'stdout' | 'stderr'): boolean {
    const lines = stream === 'stdout' ? this.#stdout : this.#stderr
    return lines.some((line) => line.length >= RUNTIME_LINE_FRAGMENT_CHARS)
  }

  /** O que o planejador produziu, para diagnostico e para o proximo ciclo de reparo. */
  both(): string {
    return [this.text('stdout'), this.text('stderr')].filter((part) => part.length > 0).join('\n')
  }
}

/** Consome um stream ate o fim mesmo depois do teto: parar de ler travaria o filho. */
async function drain(
  source: AsyncIterable<string>,
  stream: 'stdout' | 'stderr',
  budget: OutputBudget,
): Promise<void> {
  try {
    for await (const line of source) budget.push(stream, line)
  } catch {
    // stream interrompido nao invalida o que ja foi observado
  }
}

/**
 * Adapter da porta `MissionPlanner` (ADR-0013) sobre CLI local ja autenticada por
 * assinatura. O planejador LE o projeto, PROPOE um plano e termina: nao aprova, nao
 * executa, nao altera politica, gate nem codigo — e a porta nao lhe da afordancia para
 * nenhuma dessas coisas.
 *
 * Tres diferencas de proposito em relacao a `AgentProvider`:
 *
 *  - nao ha task, tentativa nem worktree: planejar acontece ANTES da missao existir, entao
 *    I8 e I11 nao se aplicam e o `cwd` e a raiz de LEITURA;
 *  - o processo roda em modo de leitura. Nenhum argumento nosso concede escrita, e
 *    `assertReadOnlyPlanArgs` recusa na construcao quem tentar configurar um. Quem impede a
 *    escrita de fato e a propria CLI no modo que pedimos; nossa parte e nunca conceder mais;
 *  - a saida nao passa por `claims` e nao e truncada em silencio: ou o plano inteiro
 *    atravessa validado, ou sai uma falha explicada (nunca missao pela metade).
 */
export class LocalCliMissionPlanner implements MissionPlanner {
  readonly id: ProviderId
  readonly command: string
  readonly planArgs: readonly string[]
  readonly #versionArgs: readonly string[]
  readonly #readinessArgs: readonly string[] | undefined
  readonly #readinessProbe: 'supported' | 'unsupported'
  readonly #runtime: LocalCliRuntime
  readonly #env: Readonly<Record<string, string>> | undefined
  readonly #envAllow: readonly string[]
  readonly #maxOutputChars: number
  readonly #probeBeforePlan: boolean
  readonly #running = new Set<LocalAgentProcess>()

  constructor(descriptor: LocalCliPlannerDescriptor, options: LocalCliMissionPlannerOptions = {}) {
    this.id = options.id ?? toProviderId(descriptor.id)
    this.command = options.command ?? descriptor.command
    this.planArgs = options.planArgs ?? descriptor.planArgs
    assertReadOnlyPlanArgs(descriptor.id, this.planArgs)
    this.#versionArgs = options.versionArgs ?? descriptor.versionArgs
    this.#readinessProbe = descriptor.readinessProbe
    this.#runtime = options.runtime ?? createLocalAgentRuntime()
    this.#env = options.env === undefined ? undefined : withoutCredentials(options.env)
    this.#envAllow = options.envAllow ?? PLANNER_ENV_ALLOW
    this.#maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_PLANNER_OUTPUT_CHARS
    this.#probeBeforePlan = options.probeBeforePlan ?? true

    if (descriptor.readinessProbe === 'supported') {
      const args = descriptor.readinessArgs
      if (args === undefined || args.length === 0) {
        throw new InvalidProviderDescriptorError(
          descriptor.id,
          "readinessProbe 'supported' exige readinessArgs; declarar suporte inexistente e proibido",
        )
      }
      this.#readinessArgs = args
    } else {
      this.#readinessArgs = undefined
    }
  }

  /**
   * `simulated: false` porque isto aciona a CLI de verdade e gasta a assinatura do usuario
   * — a interface precisa do fato para avisar ANTES (P17).
   */
  capabilities(): PlanningCapabilities {
    return { simulated: false, acceptsRevision: true, reportsUsage: false }
  }

  probeSpec(): LocalAgentSpec {
    const spec: LocalAgentSpec = {
      providerId: this.id,
      executable: this.command,
      args: [],
      versionArgs: this.#versionArgs,
    }
    return this.#readinessArgs === undefined
      ? spec
      : { ...spec, readinessArgs: this.#readinessArgs }
  }

  health(): Promise<ProviderHealth> {
    return this.#runtime.probe(this.probeSpec(), {
      capabilities: this.#probeCapabilities(),
      running: 0,
      capacity: null,
    })
  }

  /**
   * Desistencia do OPERADOR, nao do agente: mata os processos de planejamento em curso e
   * cada `plan()` afetado devolve `PLANNER_CANCELLED`. Nenhuma outra afordancia e criada.
   */
  async cancel(reason: string): Promise<void> {
    const running = [...this.#running]
    await Promise.all(running.map((proc) => proc.cancel(reason).catch(() => undefined)))
  }

  async plan(request: PlanningRequest): Promise<PlanningResult> {
    const revision = request.revision
    if (revision !== undefined && revision.attempt > MAX_PLAN_REVISIONS) {
      // Antes de acionar a CLI: gastar assinatura para uma correcao que ja nao cabe seria
      // cobrar do usuario por uma decisao que ja voltou para ele (P15).
      return refused({
        code: 'REVISIONS_EXHAUSTED',
        message: `o ciclo de reparo permite ${MAX_PLAN_REVISIONS} correcoes; a decisao volta ao humano`,
        logsRef: plannerLogsRef(this.id, NO_PROCESS_REF),
      })
    }

    const unavailable = await this.#environmentRefusal()
    if (unavailable !== undefined) return unavailable

    let proc: LocalAgentProcess
    try {
      proc = await this.#spawn(request)
    } catch (error) {
      return this.#startRefusal(error)
    }

    const logsRef = plannerLogsRef(this.id, proc.handle)
    this.#running.add(proc)
    const budget = new OutputBudget(this.#maxOutputChars)
    let exit: ExitStatus
    try {
      const [status] = await Promise.all([
        proc.exit(),
        drain(proc.stdout, 'stdout', budget),
        drain(proc.stderr, 'stderr', budget),
      ])
      exit = status
    } finally {
      this.#running.delete(proc)
    }
    return this.#settle(exit, budget, request, logsRef)
  }

  #probeCapabilities(): ProviderCapabilities {
    return {
      // Planejar nao ocupa vaga de executor nem de revisor: nao e despacho de tentativa.
      roles: [],
      streaming: true,
      cancellation: true,
      readinessProbe: this.#readinessProbe,
      reportsUsage: false,
    }
  }

  #processEnv(): Record<string, string> {
    return this.#env === undefined ? plannerEnv(this.#envAllow) : { ...this.#env }
  }

  #spawn(request: PlanningRequest): Promise<LocalAgentProcess> {
    const spec: LocalAgentSpec = {
      ...this.probeSpec(),
      args: [...this.planArgs, planningPromptText(request)],
    }
    return this.#runtime.spawn(spec, {
      // Raiz de LEITURA, nao workspace: sem lease, sem branch, sem commit base (ADR-0013).
      cwd: request.context.readRoot,
      env: this.#processEnv(),
      timeoutMs: request.timeoutMs,
    })
  }

  /**
   * CLI ausente ou sem sessao vira recusa explicada ANTES de gastar tempo. Prontidao
   * `unknown` nao recusa nada: indeterminado nao e prova de nao-prontidao (ADR-0010 4).
   */
  async #environmentRefusal(): Promise<PlanningResult | undefined> {
    if (!this.#probeBeforePlan) return undefined
    if (this.#readinessProbe === 'unsupported') return undefined
    let health: ProviderHealth
    try {
      health = await this.health()
    } catch {
      // Sonda que falha e ausencia de observacao, nao veredito: seguimos e o processo conta.
      return undefined
    }
    if (health.installed === false) {
      return refused({
        code: 'PLANNER_UNAVAILABLE',
        message: `planejador ${this.id} nao esta instalado: ${health.detail}`,
        logsRef: plannerLogsRef(this.id, NO_PROCESS_REF),
      })
    }
    if (health.ready === false) {
      return refused({
        code: 'PLANNER_UNAVAILABLE',
        message: `planejador ${this.id} sem sessao utilizavel: ${health.detail}`,
        logsRef: plannerLogsRef(this.id, NO_PROCESS_REF),
      })
    }
    return undefined
  }

  /** Falha ao iniciar tambem e diagnostico: a porta devolve recusa, nunca excecao. */
  #startRefusal(error: unknown): PlanningRefused {
    const logsRef = plannerLogsRef(this.id, NO_PROCESS_REF)
    if (isAgentRuntimeError(error)) {
      const code: PlanningFailureCode =
        error.failureCode === 'PROVIDER_UNAVAILABLE' || error.failureCode === 'PROVIDER_NOT_READY'
          ? 'PLANNER_UNAVAILABLE'
          : 'PLANNER_FAILED'
      return refused({ code, message: error.message, logsRef })
    }
    return refused({
      code: 'PLANNER_FAILED',
      message: `o planejador nao iniciou: ${describeUnknownError(error)}`,
      logsRef,
    })
  }

  /**
   * O planejador nao decide o proprio resultado: quem decide e o que o control plane
   * observou — como o processo terminou e o que o contrato aceitou (P05).
   */
  #settle(
    exit: ExitStatus,
    budget: OutputBudget,
    request: PlanningRequest,
    logsRef: string,
  ): PlanningResult {
    const spawnError = spawnErrorOf(exit)
    if (spawnError !== undefined) {
      return refused({
        code: 'PLANNER_UNAVAILABLE',
        message: `o planejador nao iniciou (${spawnError.code})`,
        logsRef,
      })
    }
    if (exit.cancelled) {
      const reason = cancelReasonOf(exit) ?? 'sem motivo registrado'
      return refused({
        code: 'PLANNER_CANCELLED',
        message: `planejamento cancelado: ${reason}`,
        raw: budget.both(),
        logsRef,
      })
    }
    if (exit.timedOut) {
      return refused({
        code: 'PLANNER_TIMEOUT',
        message: `o planejador passou de ${request.timeoutMs} ms sem concluir`,
        raw: budget.both(),
        logsRef,
      })
    }
    if (exit.code !== 0) {
      return refused({
        code: 'PLANNER_FAILED',
        message: `o planejador saiu com codigo ${exit.code ?? '-'}`,
        raw: budget.both(),
        logsRef,
      })
    }
    if (budget.exceeded) {
      return refused({
        code: 'PLANNER_FAILED',
        message: `a saida do planejador passou de ${budget.limit} caracteres; recusada inteira, sem corte em silencio`,
        raw: budget.both(),
        logsRef,
      })
    }
    if (budget.fragmented('stdout') || budget.fragmented('stderr')) {
      return refused({
        code: 'CONTRACT_REJECTED',
        message:
          'o plano veio numa linha longa demais para ser remontada com seguranca; ' +
          'peca o JSON quebrado em varias linhas',
        raw: budget.both(),
        logsRef,
      })
    }
    return planningResultFrom(budget.text('stdout') || budget.text('stderr'), request, logsRef)
  }
}

// --------------------------------------------------------------------------------------
// Planejador de roteiro
// --------------------------------------------------------------------------------------

export const SCRIPTED_PLANNER_ID = 'planner-roteiro'

/**
 * Um passo do roteiro. `output` e a saida crua que um planejador de verdade teria
 * impresso: o roteiro exercita a MESMA leitura e as mesmas recusas do adapter real.
 */
export interface PlannerScriptStep {
  readonly output?: string
  /** Falha de processo encenada, para exercitar o caminho de diagnostico sem CLI. */
  readonly failWith?: PlanningFailureCode
  readonly failMessage?: string
}

export interface ScriptedMissionPlannerOptions {
  readonly id?: ProviderId
  /** Um passo por chamada: indice 0 e a primeira, os demais sao as correcoes. */
  readonly script: readonly PlannerScriptStep[]
  readonly acceptsRevision?: boolean
}

/**
 * Planejador simulado: sem processo, sem rede, sem quota. `simulated: true` nao e detalhe
 * de teste — e o que impede um simulador de ser oferecido como planejamento de verdade
 * (ADR-0013 4).
 */
export class ScriptedMissionPlanner implements MissionPlanner {
  readonly id: ProviderId
  readonly #script: readonly PlannerScriptStep[]
  readonly #acceptsRevision: boolean

  constructor(options: ScriptedMissionPlannerOptions) {
    this.id = options.id ?? toProviderId(SCRIPTED_PLANNER_ID)
    this.#script = options.script
    this.#acceptsRevision = options.acceptsRevision ?? true
  }

  capabilities(): PlanningCapabilities {
    return { simulated: true, acceptsRevision: this.#acceptsRevision, reportsUsage: false }
  }

  plan(request: PlanningRequest): Promise<PlanningResult> {
    const index = request.revision?.attempt ?? 0
    const logsRef = plannerLogsRef(this.id, `roteiro-${index}`)
    if (request.revision !== undefined && request.revision.attempt > MAX_PLAN_REVISIONS) {
      return Promise.resolve(
        refused({
          code: 'REVISIONS_EXHAUSTED',
          message: `o ciclo de reparo permite ${MAX_PLAN_REVISIONS} correcoes; a decisao volta ao humano`,
          logsRef,
        }),
      )
    }
    const step = this.#script[index] ?? this.#script[this.#script.length - 1]
    if (step === undefined) {
      return Promise.resolve(
        refused({ code: 'NO_PROPOSAL', message: 'roteiro vazio: nada a propor', logsRef }),
      )
    }
    if (step.failWith !== undefined) {
      return Promise.resolve(
        refused({
          code: step.failWith,
          message: step.failMessage ?? `roteiro encenou ${step.failWith}`,
          logsRef,
        }),
      )
    }
    return Promise.resolve(planningResultFrom(step.output ?? '', request, logsRef))
  }
}

// --------------------------------------------------------------------------------------
// Registry
// --------------------------------------------------------------------------------------

export interface MissionPlannerRegistryOptions {
  readonly planners: readonly MissionPlanner[]
  /** Escolha explicita do projeto. Precisa existir na lista. */
  readonly default?: ProviderId
}

/**
 * Registry de planejadores. O padrao nunca cai num simulador quando existe planejador de
 * verdade: apresentar simulacao como planejamento seria a mentira que o produto mais recusa.
 */
export class DefaultMissionPlannerRegistry implements MissionPlannerRegistry {
  readonly #planners = new Map<string, MissionPlanner>()
  readonly #default: ProviderId | undefined

  constructor(options: MissionPlannerRegistryOptions) {
    for (const planner of options.planners) this.#planners.set(planner.id, planner)
    const chosen = options.default
    if (chosen !== undefined && !this.#planners.has(chosen)) {
      throw new UnknownProviderError(chosen, this.list())
    }
    this.#default = chosen ?? this.#preferred()
  }

  get(id: ProviderId): MissionPlanner {
    const planner = this.#planners.get(id)
    if (planner === undefined) throw new UnknownProviderError(id, this.list())
    return planner
  }

  list(): ProviderId[] {
    return [...this.#planners.keys()].sort().map((id) => toProviderId(id))
  }

  default(): ProviderId | undefined {
    return this.#default
  }

  #preferred(): ProviderId | undefined {
    const ids = this.list()
    const real = ids.find((id) => this.#planners.get(id)?.capabilities().simulated === false)
    return real ?? ids[0]
  }
}

export function createMissionPlannerRegistry(
  options: MissionPlannerRegistryOptions,
): DefaultMissionPlannerRegistry {
  return new DefaultMissionPlannerRegistry(options)
}
