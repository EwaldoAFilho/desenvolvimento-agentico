import type { Clock, IdGenerator, ProviderRegistry, Run, RunId, TaskRun } from '@agentic/domain'
import {
  type ArtifactWriter,
  COMPILE_REPORT_ARTIFACT,
  type EventReader,
  MISSION_ARTIFACT,
  MISSION_GATE_ARTIFACT,
  type OrchestratorStore,
} from '../engine/index.js'

export interface ApplicationStore extends OrchestratorStore {
  createRun(run: Run, taskRuns: readonly TaskRun[]): Promise<void>
}

export interface ArtifactReader {
  readText(runId: RunId, relativePath: string): Promise<string>
}

/**
 * Dependencias dos casos de uso. Sao as mesmas portas do engine: a camada de aplicacao nao
 * abre banco, nao fala git e nao conhece provider concreto.
 */
export interface ApplicationDeps {
  readonly store: ApplicationStore
  readonly artifacts: ArtifactWriter & ArtifactReader
  readonly events: EventReader
  readonly registry: ProviderRegistry
  readonly clock: Clock
  readonly ids: IdGenerator
}

export { COMPILE_REPORT_ARTIFACT, MISSION_ARTIFACT, MISSION_GATE_ARTIFACT }
