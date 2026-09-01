export const PACKAGE_NAME = '@agentic/server'

export type { BindAddress, ProjectSources, ServerConfig } from './config.js'
export {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_HOST,
  DEFAULT_MISSIONS_DIR,
  DEFAULT_PORT,
  DEFAULT_PROJECT_FILE,
  DEFAULT_WEB_DIST,
  LOOPBACK_HOSTS,
  loadProjectSources,
  resolveBind,
  ServerConfigError,
} from './config.js'
export type {
  AliveProbe,
  ControlPlaneRuntime,
  DiscoverOptions,
  RemoveExpectation,
  WriteRuntimeInput,
} from './control-plane-file.js'
export {
  CONTROL_PLANE_FILE,
  controlPlaneFilePath,
  discoverControlPlane,
  parseControlPlaneRuntime,
  processAlive,
  readControlPlaneFile,
  removeControlPlaneFile,
  writeControlPlaneFile,
} from './control-plane-file.js'
export type { RunLauncher, ServerDeps, ServerDepsInput } from './deps.js'
export { defaultLauncher, toServerDeps } from './deps.js'
export { parseRunId, parseTaskId, toRunHeader } from './dto.js'
export type { ApiErrorBody, ApiErrorPayload, ApiIssue } from './errors.js'
export { badRequest, conflict, HttpError, notFound, toApiError, toApiIssues } from './errors.js'
export type { CompiledMission, MissionSource, RunLookup } from './missions.js'
export {
  compileMissionRef,
  compileMissionSource,
  findRun,
  findRuns,
  missionSpecOf,
  readMissionSource,
  refuseOnErrors,
  resolveMissionPath,
  warningsOf,
} from './missions.js'
export type { OwnershipStepInput, ShutdownSteps } from './ownership.js'
export { ControlPlaneBusyError, claimControlPlane, shutdownControlPlane } from './ownership.js'
export type { ProjectIdentity, ProjectIdentityInput } from './project-identity.js'
export {
  configPathOf,
  PROJECT_HEADER,
  PROJECT_MISMATCH,
  projectDirOf,
  projectIdentityOf,
  RUNTIME_DIR_NAME,
  runtimeDirOf,
} from './project-identity.js'
export { optionalInt } from './query.js'
export type { CommandResult, StartRunResult } from './routes/commands.js'
export { DEFAULT_ACTOR, registerCommandRoutes } from './routes/commands.js'
export type { ApproveMissionResult, MissionListItem } from './routes/missions.js'
export { registerMissionRoutes } from './routes/missions.js'
export type { HealthBody } from './routes/read.js'
export { loadRunOr404, registerReadRoutes } from './routes/read.js'
export { registerStreamRoutes } from './routes/stream.js'
export type { AgentSlot, InFlightAgent, RunningTally } from './running.js'
export {
  applyPersistedRunning,
  EMPTY_TALLY,
  IN_FLIGHT_TASK_STATUSES,
  inFlightAgents,
  LIVE_RUN_STATUSES,
  persistedRunning,
  tallyOf,
} from './running.js'
export type { AttachServerInput, CreateServerInput, RunningServer } from './server.js'
export { attachServer, createServer, startServer } from './server.js'
export { HEARTBEAT_FRAME, SSE_HEADERS, SseChannel, sseFrame } from './sse.js'
export { isApiPath, MISSING_BUILD_MESSAGE, pathnameOf, registerStatic, safeJoin } from './static.js'
