import { toProviderHealthDto } from '@agentic/orchestrator'
import type { ProjectDto, ProjectHomeDto, ProviderHealthDto } from '@agentic/schemas'
import type { FastifyInstance } from 'fastify'
import type { ServerDeps } from '../deps.js'
import { listRunSummaries, missionSummaries, repoRelativePath } from '../missions.js'
import { optionalInt } from '../query.js'
import { applyPersistedRunning, persistedRunning } from '../running.js'

export interface ProjectHomeOptions {
  /** Corta apenas a lista de execucoes; o ultimo run de cada missao continua completo. */
  readonly limit?: number
}

/**
 * `unknown` atravessa como `unknown` e `running` sai do estado persistido — o painel da Home
 * mostra o MESMO numero que `/api/providers` e que o doctor, nao o livro-caixa em memoria de
 * quem respondeu (DASHBOARD 5.1).
 */
async function providersOf(deps: ServerDeps): Promise<ProviderHealthDto[]> {
  const health = await deps.plane.registry.health()
  const tally = await persistedRunning(deps.plane.persistence)
  return applyPersistedRunning(health.map(toProviderHealthDto), tally)
}

/** Identidade e ambiente do projeto. Responde SEM nenhum run criado — e o que separa
 * "projeto novo" de "carregando para sempre". */
export async function projectOf(deps: ServerDeps): Promise<ProjectDto> {
  return {
    name: deps.project.project.name,
    // Hoje o servidor recusa subir sem `project.yaml` legivel, entao na pratica isto e
    // sempre `true` — e o fato medido, nao otimismo. O campo existe para a Home mostrar
    // onboarding em vez de erro se um dia o control plane subir sem projeto configurado.
    configured: deps.projectText.trim().length > 0,
    missionsDir: repoRelativePath(deps, deps.missionsDir),
    defaultProvider: deps.project.providers.default,
    gates: [...deps.plane.gates.ids],
    providers: await providersOf(deps),
    // Vazio ENQUANTO nao ha registro de planejadores no control plane. O contrato preve
    // vazio como resposta legitima, e preferimos isso a apresentar um provider de execucao
    // como se soubesse planejar: planejar e outra porta (ADR-0013).
    planners: [],
  }
}

/**
 * Uma leitura previsivel: a Home nao encadeia tres chamadas para desenhar a primeira tela.
 * Projeto, missoes com estado suficiente e execucoes saem da MESMA apuracao de runs.
 */
export async function projectHome(
  deps: ServerDeps,
  options: ProjectHomeOptions = {},
): Promise<ProjectHomeDto> {
  const runs = await listRunSummaries(deps)
  return {
    project: await projectOf(deps),
    missions: await missionSummaries(deps, runs),
    runs: options.limit === undefined ? runs : runs.slice(0, options.limit),
  }
}

export function registerProjectRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get('/api/project', async (request): Promise<ProjectHomeDto> => {
    const query = request.query as Record<string, unknown>
    const limit = optionalInt(query.limit, 'limit')
    return projectHome(deps, { ...(limit === undefined ? {} : { limit }) })
  })
}
