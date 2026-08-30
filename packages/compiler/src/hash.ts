import type { MissionSpec, TaskSpec } from '@agentic/domain'

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK_64 = 0xffffffffffffffffn

export const SPEC_HASH_ALGORITHM = 'fnv1a64'

/**
 * FNV-1a de 64 bits sobre as unidades UTF-16 do texto. Puro e curto de proposito: o pacote
 * nao pode importar `node:crypto` (fronteira verificada por lint) e o hash aqui serve para
 * identificar plano igual, nao para resistir a adversario.
 */
export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash ^ BigInt(text.charCodeAt(i))) & MASK_64
    hash = (hash * FNV_PRIME) & MASK_64
  }
  return hash.toString(16).padStart(16, '0')
}

/** Espaco em branco nao e conteudo: reindentar um bloco `>` nao muda a missao. */
function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Conjunto ordenado: repetir uma dependencia ou um escopo nao muda o plano. */
function sortedText(values: readonly string[]): string[] {
  return [...new Set(values.map(String))].sort()
}

/**
 * JSON canonico: chaves ordenadas, `undefined` omitido. Ordenar as chaves e o que faz o
 * hash ignorar a ordem em que os campos foram escritos no YAML.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

/**
 * `dependencies` e `touches` sao conjuntos: a ordem em que foram escritos nao muda o plano,
 * entao entram ordenados. A ordem das tasks, ao contrario, e semantica — e o desempate de
 * toda analise deterministica (ADR-0005) — e por isso e preservada.
 */
function canonicalTask(task: TaskSpec): Record<string, unknown> {
  return {
    id: String(task.id),
    phase: String(task.phase),
    title: normalizeText(task.title),
    objective: normalizeText(task.objective),
    description: task.description === undefined ? undefined : normalizeText(task.description),
    dependencies: sortedText(task.dependencies),
    touches: sortedText(task.touches),
    reads: task.reads === undefined ? undefined : sortedText(task.reads),
    validation: task.validation.map(normalizeText),
    gate: task.gate === undefined ? undefined : String(task.gate),
    requireReview: task.requireReview,
    maxAttempts: task.maxAttempts,
    risk: task.risk,
    estimate: task.estimate,
    agentProfile: task.agentProfile === undefined ? undefined : String(task.agentProfile),
    reviewPolicy: task.reviewPolicy,
  }
}

export function canonicalSpec(spec: MissionSpec): Record<string, unknown> {
  return {
    id: String(spec.id),
    title: normalizeText(spec.title),
    objective: normalizeText(spec.objective),
    description: spec.description === undefined ? undefined : normalizeText(spec.description),
    scope: spec.scope.map(normalizeText),
    outOfScope: spec.outOfScope.map(normalizeText),
    constraints: spec.constraints.map(normalizeText),
    acceptanceCriteria: spec.acceptanceCriteria.map(normalizeText),
    defaults: {
      requireReview: spec.defaults.requireReview,
      maxAttempts: spec.defaults.maxAttempts,
      gate: spec.defaults.gate === undefined ? undefined : String(spec.defaults.gate),
      agentProfile:
        spec.defaults.agentProfile === undefined ? undefined : String(spec.defaults.agentProfile),
      reviewPolicy: spec.defaults.reviewPolicy,
    },
    phases: spec.phases.map((phase) => ({
      id: String(phase.id),
      title: normalizeText(phase.title),
      order: phase.order,
    })),
    tasks: spec.tasks.map(canonicalTask),
    missionGate: spec.missionGate === undefined ? undefined : String(spec.missionGate),
  }
}

/** Hash do conteudo normalizado da MissionSpec (DOMAIN-MODEL 2.6). */
export function specHashOf(spec: MissionSpec): string {
  return `${SPEC_HASH_ALGORITHM}:${fnv1a64(canonicalJson(canonicalSpec(spec)))}`
}
