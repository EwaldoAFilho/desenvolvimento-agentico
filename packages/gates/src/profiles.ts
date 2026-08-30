import type { Gate, GateCommand, GateId } from '@agentic/domain'
import { gateId } from '@agentic/domain'
import type { GateCommandConfig, GatesFile } from '@agentic/schemas'
import { GatesFileSchema } from '@agentic/schemas'
import { GateError } from './errors.js'

/**
 * Perfis carregados do arquivo versionado. Unica origem possivel de um `Gate`: nao ha
 * construtor publico que aceite string de comando livre, nem no runner nem aqui — agente
 * nunca define a propria regra de qualidade (P09, ARCHITECTURE 9).
 */
export interface GateProfiles {
  readonly ids: readonly GateId[]
  /** `env.allow` do arquivo. Teto da allowlist de qualquer execucao. */
  readonly envAllow: readonly string[]
  has(id: string): boolean
  get(id: string): Gate | undefined
  require(id: string): Gate
}

/**
 * Aceita SOMENTE o objeto ja validado por `GatesFileSchema`. A revalidacao aqui nao e
 * paranoia decorativa: e o que impede um objeto montado em runtime (por um agente, por um
 * payload de API) de virar gate — sem `apiVersion`, `kind: Gates` e perfis bem formados,
 * nada carrega.
 */
export function loadGateProfiles(gatesFile: GatesFile): GateProfiles {
  const parsed = GatesFileSchema.safeParse(gatesFile)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`)
      .join('; ')
    throw new GateError(
      'GATE_CONFIG_INVALID',
      'gates.yaml invalido: perfis so vem do arquivo versionado',
      detail,
    )
  }

  const file = parsed.data
  const envAllow: readonly string[] = Object.freeze([...file.env.allow])
  const gates = new Map<string, Gate>()

  for (const [rawId, profile] of Object.entries(file.profiles)) {
    const id = gateId(rawId)
    gates.set(id, {
      id,
      commands: Object.freeze(profile.commands.map(toGateCommand)),
      env: envAllow,
    })
  }

  const ids: readonly GateId[] = Object.freeze([...gates.keys()].map((raw) => gateId(raw)))

  return {
    ids,
    envAllow,
    has: (id: string): boolean => gates.has(id),
    get: (id: string): Gate | undefined => gates.get(id),
    require: (id: string): Gate => {
      const gate = gates.get(id)
      if (gate === undefined) {
        throw new GateError(
          'GATE_CONFIG_INVALID',
          `perfil de gate inexistente: ${id}`,
          `perfis: ${ids.join(', ')}`,
        )
      }
      return gate
    },
  }
}

function toGateCommand(command: GateCommandConfig): GateCommand {
  return {
    run: command.run,
    cwd: command.cwd,
    timeoutMs: command.timeoutMs,
    required: command.required,
  }
}
