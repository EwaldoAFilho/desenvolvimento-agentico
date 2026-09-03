import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Gates DETECTADOS, nunca presumidos.
 *
 * O template antigo escrevia `npm run lint`, `npm run test` e `npm run verify` fixos num
 * produto que se anuncia agnostico de linguagem: num projeto sem esses scripts — a maioria
 * — o primeiro gate falhava com "Missing script", e a configuracao que o proprio produto
 * gerou era a culpada. Aqui so entra comando que existe no projeto.
 */
export interface DiscoveredCommand {
  /** Chave canonica do comando, para montar os perfis. */
  readonly id: GateCommandId
  /** Linha exata que o control plane vai executar. */
  readonly run: string
}

export const GATE_COMMAND_IDS = ['lint', 'typecheck', 'test', 'build', 'verify'] as const
export type GateCommandId = (typeof GATE_COMMAND_IDS)[number]

export interface GateDiscovery {
  /** Como os comandos foram apurados. `none` = nenhuma stack reconhecida. */
  readonly source: 'package.json' | 'none'
  readonly commands: readonly DiscoveredCommand[]
}

interface PackageJson {
  readonly scripts?: Readonly<Record<string, unknown>>
}

async function readPackageScripts(root: string): Promise<readonly string[] | undefined> {
  let raw: string
  try {
    raw = await readFile(join(root, 'package.json'), 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // `package.json` ilegivel nao vira erro de `init`: vira ausencia de deteccao. Inventar
    // comando a partir de um arquivo que nem parseia seria exatamente o defeito que este
    // item conserta.
    return undefined
  }
  const scripts = (parsed as PackageJson | null)?.scripts
  if (typeof scripts !== 'object' || scripts === null) return []
  return Object.entries(scripts)
    .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
    .map(([name]) => name)
}

/**
 * Le `scripts` do `package.json` e reconhece os cinco nomes que o produto sabe usar. Nao
 * ha adivinhacao: script ausente simplesmente nao vira gate.
 */
export async function discoverGateCommands(root: string): Promise<GateDiscovery> {
  const scripts = await readPackageScripts(root)
  if (scripts === undefined) return { source: 'none', commands: [] }
  const present = new Set(scripts)
  const commands = GATE_COMMAND_IDS.filter((id) => present.has(id)).map((id) => ({
    id,
    run: `npm run ${id}`,
  }))
  return { source: 'package.json', commands }
}
