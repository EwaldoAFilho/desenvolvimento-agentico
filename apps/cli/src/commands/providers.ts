import { toProviderHealthDto } from '@agentic/orchestrator'
import type { ProviderHealthDto } from '@agentic/schemas'
import { loadProjectContext } from '../context.js'
import type { CommandDeps } from '../deps.js'
import { createOutput, table, tristate } from '../output.js'
import { type CommandResult, ok } from '../result.js'

export interface ProvidersArgs {
  readonly project?: string
  readonly json?: boolean
}

export function providerRows(health: readonly ProviderHealthDto[]): string[][] {
  return health.map((provider) => [
    provider.providerId,
    tristate(provider.installed),
    tristate(provider.ready),
    provider.version,
    String(provider.running),
    provider.capacity === null ? 'sem teto' : String(provider.capacity),
  ])
}

/**
 * `providers`: instalado / pronto / versao / em execucao / capacidade.
 *
 * `unknown` sai como `unknown`. Uma CLI que respondeu `--version` NAO prova autenticacao,
 * e o produto nao pinta de verde por otimismo (DASHBOARD 5.1, R5).
 */
export async function providersCommand(
  args: ProvidersArgs,
  deps: CommandDeps,
): Promise<CommandResult> {
  const out = createOutput(deps, args.json === true)
  const context = await loadProjectContext(deps, args)
  const registry = deps.registry(context.project)
  const health = (await registry.health()).map(toProviderHealthDto)

  out.lines(
    table(
      ['FORNECEDOR', 'INSTALADO', 'PRONTO', 'VERSAO', 'EM USO', 'CAPACIDADE'],
      providerRows(health),
    ),
  )
  out.line()
  for (const provider of health) {
    if (provider.detail.length > 0) out.line(`${provider.providerId}: ${provider.detail}`)
  }
  out.line()
  out.line('`unknown` significa que nao foi possivel apurar — nao significa pronto.')
  return ok('providers', health)
}
