/**
 * O que a extensao sabe sobre o control plane: SOMENTE o contrato publicado.
 *
 * Todos os imports aqui sao de TIPO. `verbatimModuleSyntax` garante que nada disso chega ao
 * bundle: a extensao e cliente do control plane, nunca o contem. Os DTOs vem dos mesmos
 * schemas que o dashboard consome, entao a tela do editor e a tela do navegador leem o
 * mesmo fato.
 */
export type {
  CompileReportDto,
  CompileStatsDto,
  DiagnosticDto,
  ProviderHealthDto,
  RunHeaderDto,
  RunSnapshot,
  TaskDetail,
  TaskSnapshotDto,
} from '@agentic/schemas'
export type { ControlPlaneRuntime, HealthBody, MissionListItem } from '@agentic/server'

/** Identidade que o `/api/health` devolve. Porta ocupada por outro programa nao e control plane. */
export const CONTROL_PLANE_SERVICE = '@agentic/server'
/** Header que amarra cada requisicao ao projeto a que ela se destina (guarda do servidor). */
export const PROJECT_HEADER = 'x-agentic-repo-root'
/** Diretorio de estado do projeto: posse, `state.db`, `control-plane.json`. */
export const RUNTIME_DIR_NAME = '.agentic'
export const PROJECT_FILE_NAME = 'project.yaml'
export const CONTROL_PLANE_FILE_NAME = 'control-plane.json'
export const MISSIONS_DIR_NAME = 'missions'
