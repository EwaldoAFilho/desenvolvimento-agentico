import type { ControlPlane } from '@agentic/orchestrator'
import type { Persistence } from '@agentic/persistence'
import type { RunSnapshot } from '@agentic/schemas'
import {
  applyPersistedRunning,
  EMPTY_TALLY,
  persistedRunning,
  type RunningTally,
} from '@agentic/server'
import type { ProjectContext } from './context.js'
import type { CommandDeps } from './deps.js'
import { withPlane } from './plane.js'
import { codeOf, messageOf } from './result.js'

export const PERSISTED_SOURCE = 'estado persistido'

/**
 * Projeto que ainda nao tem `state.db`. E uma leitura VALIDA, e o numero e ZERO.
 *
 * "Nao inicializado" e "nao consegui apurar" parecem o mesmo caso e nao sao. Um projeto sem
 * banco nao tem run nenhum — dizer `unknown` ali seria esconder um fato conhecido atras de
 * uma duvida, e pior: deixaria a interface exibir a contabilidade EM MEMORIA do processo,
 * que e exatamente o numero errado que a 003 removeu do doctor.
 *
 * Antes desta fatia a distincao nao existia porque a pergunta CRIAVA o banco. Ler nao pode
 * inicializar projeto (I14), entao a distincao passou a ser necessaria — e ela e barata.
 */
export const NOT_INITIALIZED_SOURCE = 'projeto ainda nao inicializado (nenhum run)'
const NOT_INITIALIZED_CODE = 'DATABASE_NOT_INITIALIZED'

/**
 * De onde saiu o `running` exibido. `derived: false` significa que NAO foi possivel abrir
 * o estado persistido — e ai a interface diz `unknown` em vez de repetir a contabilidade
 * em memoria de um processo que nao despachou nada.
 */
export interface RunningReading {
  readonly derived: boolean
  readonly tally: RunningTally
  readonly source: string
}

/** Nenhum banco aberto, nada a derivar: nao inventamos numero (mesma regra do `unknown`). */
function undeterminedReading(detail: string): RunningReading {
  return { derived: false, tally: EMPTY_TALLY, source: `nao apurado: ${detail}` }
}

/**
 * Abre o estado persistido so para contar agentes em voo, e fecha. Falhar em abrir nao
 * derruba o comando: vira uma leitura `unknown`, visivel na saida.
 */
export async function readPersistedRunning(
  deps: CommandDeps,
  context: ProjectContext,
): Promise<RunningReading> {
  try {
    const tally = await withPlane(deps, context, (plane) => persistedRunning(plane.persistence))
    return { derived: true, tally, source: PERSISTED_SOURCE }
  } catch (error) {
    if (codeOf(error) === NOT_INITIALIZED_CODE) {
      return { derived: true, tally: EMPTY_TALLY, source: NOT_INITIALIZED_SOURCE }
    }
    return undeterminedReading(messageOf(error))
  }
}

/**
 * Banco aberto deste control plane, ou `undefined` quando nao ha um. Nem todo plane que
 * chega a um comando de leitura carrega persistencia; sem ela nao ha o que derivar.
 */
export function persistenceOf(plane: ControlPlane): Persistence | undefined {
  const persistence = plane.persistence as Persistence | undefined
  return persistence?.queries === undefined ? undefined : persistence
}

/**
 * Mesmo retrato, `running` corrigido pelo banco. Sem persistencia aberta o snapshot volta
 * intacto — a leitura nao piora o que ja veio.
 */
export async function snapshotWithPersistedRunning(
  plane: ControlPlane,
  snapshot: RunSnapshot,
): Promise<RunSnapshot> {
  const persistence = persistenceOf(plane)
  if (persistence === undefined) return snapshot
  const tally = await persistedRunning(persistence)
  return { ...snapshot, providers: applyPersistedRunning(snapshot.providers, tally) }
}
