import type { MissionSpec, PlanProblem, TaskSpec } from '@agentic/domain'
import type { MissionFile, MissionFileDefaults, MissionFileTask } from '@agentic/schemas'
import { API_VERSION, parseMissionFile, planProblemsOf, toMissionSpec } from '@agentic/schemas'

/**
 * O arquivo da missao e escrito AQUI, pelo control plane, nunca pelo agente (ADR-0016).
 *
 * O planejador propoe CONTEUDO — um `MissionSpec` ja validado pelo contrato. Quem fecha o
 * documento (`apiVersion`, `kind`), escolhe o caminho e serializa e o produto. Por isso os
 * bytes do planejador nunca chegam ao disco: o que vai para o arquivo e a nossa serializacao
 * de uma estrutura que passou pelo schema, e nao o texto que a CLI imprimiu.
 */

const INDENT = 2

/** Chave simples sai crua; qualquer outra coisa vai entre aspas. */
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/

type YamlScalar = string | number | boolean
type YamlValue = YamlScalar | readonly YamlValue[] | YamlObject
interface YamlObject {
  readonly [key: string]: YamlValue | undefined
}

/**
 * Todo texto sai entre aspas duplas. O estilo aspas-duplas do YAML usa as MESMAS sequencias
 * de escape do JSON, entao `JSON.stringify` produz um escalar valido por construcao — sem a
 * tabela de casos (`:` no meio, `#`, `-` inicial, `yes`/`no`, numero que virou string) que
 * um emissor de escalar simples precisaria acertar. Prosa longa fica numa linha so; a troca
 * e deliberada: legibilidade um pouco pior, zero chance de mudar o sentido do plano.
 */
function scalarOf(value: YamlScalar): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

function isYamlObject(value: YamlValue): value is YamlObject {
  return typeof value === 'object' && !Array.isArray(value)
}

function entriesOf(value: YamlObject): [string, YamlValue][] {
  return Object.entries(value).filter(
    (entry): entry is [string, YamlValue] => entry[1] !== undefined,
  )
}

function keyOf(key: string): string {
  return PLAIN_KEY.test(key) ? key : JSON.stringify(key)
}

/** O que cabe na mesma linha da chave; `undefined` quando o valor exige bloco proprio. */
function inlineOf(value: YamlValue): string | undefined {
  if (Array.isArray(value)) return value.length === 0 ? '[]' : undefined
  if (isYamlObject(value)) return entriesOf(value).length === 0 ? '{}' : undefined
  return scalarOf(value as YamlScalar)
}

function renderValue(value: YamlValue, indent: number): string[] {
  return Array.isArray(value)
    ? renderSequence(value, indent)
    : renderObject(value as YamlObject, indent)
}

function renderObject(value: YamlObject, indent: number): string[] {
  const pad = ' '.repeat(indent)
  const lines: string[] = []
  for (const [key, item] of entriesOf(value)) {
    const inline = inlineOf(item)
    if (inline !== undefined) {
      lines.push(`${pad}${keyOf(key)}: ${inline}`)
      continue
    }
    lines.push(`${pad}${keyOf(key)}:`)
    lines.push(...renderValue(item, indent + INDENT))
  }
  return lines
}

/** O `- ` ocupa a indentacao do proprio item: o resto do bloco alinha sob a primeira chave. */
function renderSequence(items: readonly YamlValue[], indent: number): string[] {
  const pad = ' '.repeat(indent)
  const lines: string[] = []
  for (const item of items) {
    const inline = inlineOf(item)
    if (inline !== undefined) {
      lines.push(`${pad}- ${inline}`)
      continue
    }
    const [first, ...rest] = renderValue(item, indent + INDENT)
    if (first === undefined) continue
    lines.push(`${pad}- ${first.slice(indent + INDENT)}`)
    lines.push(...rest)
  }
  return lines
}

export function renderYaml(value: YamlObject, header: readonly string[] = []): string {
  const comments = header.map((line) => (line.length === 0 ? '#' : `# ${line}`))
  const body = renderObject(value, 0)
  return `${[...comments, ...(comments.length === 0 ? [] : ['']), ...body].join('\n')}\n`
}

// --------------------------------------------------------------------------------------
// MissionSpec -> arquivo de missao
// --------------------------------------------------------------------------------------

/**
 * `toMissionSpec` RESOLVE a heranca de `defaults` dentro de cada task, entao o caminho de
 * volta grava o valor ja resolvido no proprio item. O arquivo fica mais explicito e continua
 * significando o mesmo: com o campo declarado na task, o `??` do `defaults` nunca dispara na
 * releitura. `defaults` e gravado assim mesmo porque ele tambem e parte do `MissionSpec`.
 */
function defaultsOf(spec: MissionSpec): MissionFileDefaults | undefined {
  const defaults: MissionFileDefaults = {
    requireReview: spec.defaults.requireReview,
    maxAttempts: spec.defaults.maxAttempts,
    gate: spec.defaults.gate,
    agentProfile: spec.defaults.agentProfile,
    reviewPolicy: spec.defaults.reviewPolicy,
  }
  return Object.values(defaults).every((value) => value === undefined) ? undefined : defaults
}

/** Lista opcional: vazia nao vai para o arquivo — a releitura devolve `[]` do mesmo jeito. */
function listOrOmit(values: readonly string[]): string[] | undefined {
  return values.length === 0 ? undefined : [...values]
}

function taskOf(task: TaskSpec): MissionFileTask {
  return {
    id: task.id,
    phase: task.phase,
    title: task.title,
    objective: task.objective,
    description: task.description,
    dependencies: [...task.dependencies],
    touches: listOrOmit(task.touches),
    reads: task.reads === undefined ? undefined : [...task.reads],
    validation: listOrOmit(task.validation),
    gate: task.gate,
    requireReview: task.requireReview,
    maxAttempts: task.maxAttempts,
    risk: task.risk,
    estimate: task.estimate,
    agentProfile: task.agentProfile,
    reviewPolicy: task.reviewPolicy,
  } as MissionFileTask
}

/**
 * `apiVersion` e `kind` entram AQUI e so aqui. Um planejador que pudesse declara-los
 * escolheria o contrato contra o qual seria julgado (ADR-0016 2).
 */
export function missionFileOf(spec: MissionSpec): MissionFile {
  return {
    apiVersion: API_VERSION,
    kind: 'Mission',
    id: spec.id,
    title: spec.title,
    objective: spec.objective,
    description: spec.description,
    scope: listOrOmit(spec.scope),
    outOfScope: listOrOmit(spec.outOfScope),
    constraints: listOrOmit(spec.constraints),
    acceptanceCriteria: [...spec.acceptanceCriteria],
    defaults: defaultsOf(spec),
    phases: spec.phases.map((phase) => ({ id: phase.id, title: phase.title, order: phase.order })),
    tasks: spec.tasks.map(taskOf),
    missionGate: spec.missionGate,
  } as MissionFile
}

/**
 * Forma canonica de um `MissionSpec`: chaves ordenadas, `undefined` removido. Dois planos
 * com o mesmo conteudo produzem a MESMA string — e o que permite ao control plane reconhecer
 * que uma "correcao" repetiu um plano ja recusado, sem depender de o adapter reconhecer.
 *
 * Ordem de ARRAY continua significativa: trocar a ordem das tasks muda o plano que o humano
 * vai ler, entao nao e a mesma proposta. Mesma regra de `canonicalMissionPlan`, aplicada ao
 * `MissionSpec` — comparar pelo arquivo esconderia justamente um erro de serializacao.
 */
export function canonicalMissionSpec(spec: MissionSpec): string {
  return JSON.stringify(canonical(spec))
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== 'object') return value
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return Object.fromEntries(entries.map(([key, item]) => [key, canonical(item)]))
}

export interface MissionYamlWritten {
  readonly ok: true
  readonly text: string
}

export interface MissionYamlRefused {
  readonly ok: false
  readonly problems: readonly PlanProblem[]
}

export type MissionYamlResult = MissionYamlWritten | MissionYamlRefused

/**
 * Serializa e CONFERE: o texto volta pelo parser do arquivo de missao e o `MissionSpec`
 * resultante e comparado com o proposto. Sem essa volta o produto estaria afirmando que
 * gravou o plano proposto — quando o que ele mediu foi apenas ter escrito bytes.
 *
 * Divergencia vira recusa explicada, jamais arquivo gravado: meia missao compila e engana.
 */
export function missionYamlOf(
  spec: MissionSpec,
  header: readonly string[] = [],
): MissionYamlResult {
  const text = renderYaml(missionFileOf(spec) as YamlObject, header)
  const parsed = parseMissionFile(text)
  if (!parsed.ok) return { ok: false, problems: planProblemsOf(parsed.issues) }
  let reread: MissionSpec
  try {
    reread = toMissionSpec(parsed.value)
  } catch (error) {
    return {
      ok: false,
      problems: [{ path: '', message: `o plano nao vira arquivo de missao: ${describe(error)}` }],
    }
  }
  if (canonicalMissionSpec(reread) !== canonicalMissionSpec(spec)) {
    return {
      ok: false,
      problems: [
        {
          path: '',
          message:
            'o plano proposto nao sobrevive a ida e volta pelo arquivo de missao; ' +
            'nada foi gravado',
        },
      ],
    }
  }
  return { ok: true, text }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
