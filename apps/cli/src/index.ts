export const PACKAGE_NAME = '@agentic/cli'

export {
  type CheckStatus,
  capacityCheck,
  type DoctorArgs,
  type DoctorCheck,
  type DoctorData,
  doctorCommand,
  MIN_NODE_MAJOR,
  providerCheck,
  workspaceCheck,
} from './commands/doctor.js'
export { type EventsTailArgs, eventsTailCommand, renderEvent } from './commands/events-tail.js'
export { type InitArgs, type InitData, initCommand } from './commands/init.js'
export {
  type ApproveArgs,
  type ApproveData,
  missionApproveCommand,
} from './commands/mission-approve.js'
export {
  type CompileData,
  type CompiledDagDto,
  missionCompileCommand,
  toDagDto,
} from './commands/mission-compile.js'
export { missionStartCommand, type StartArgs, type StartData } from './commands/mission-start.js'
export {
  missionStatusCommand,
  type RunTargetArgs,
  renderSnapshot,
} from './commands/mission-status.js'
export { type MissionFileArgs, missionValidateCommand } from './commands/mission-validate.js'
export {
  type MutationData,
  pauseCommand,
  type RunCommandArgs,
  resumeCommand,
  stopCommand,
  type TaskCommandArgs,
  taskRetryCommand,
  taskSkipCommand,
  taskUnblockCommand,
} from './commands/mutations.js'
export {
  capacityLabel,
  PROVIDER_STATES,
  type ProviderState,
  type ProviderView,
  type ProviderViewInput,
  providerStateOf,
  providerViewOf,
  renderProviderView,
} from './commands/provider-view.js'
export { type ProvidersArgs, providerRows, providersCommand } from './commands/providers.js'
export { type RunReportArgs, runReportCommand } from './commands/run-report.js'
export { SERVER_COMMAND, type ServeArgs, type ServeData, serveCommand } from './commands/serve.js'
export {
  AGENT_ARTIFACT_PREFIX,
  type AgentLogRef,
  agentLogsOf,
  type TaskInspectArgs,
  type TaskInspectData,
  taskInspectCommand,
} from './commands/task-inspect.js'
export {
  WAIT_REASONS,
  type WaitExplanation,
  type WaitReason,
  waitExplanationOf,
} from './commands/task-waiting.js'
export {
  AGENTIC_DIR,
  compileInputOf,
  describeIssues,
  findProjectDir,
  GATES_FILE,
  loadProjectContext,
  MISSIONS_DIR,
  type MissionSource,
  PROJECT_FILE,
  type ProjectContext,
  type ProjectOptions,
  readMissionFile,
} from './context.js'
export {
  type BootedServer,
  type CommandDeps,
  defaultDeps,
  type GitProbe,
  type ServePlaneInput,
} from './deps.js'
export { renderDiagnostic, renderDiagnostics, summaryOf } from './diagnostics.js'
export {
  type DiscoveryOptions,
  describeEndpoint,
  discoverRuntime,
  type EndpointSource,
  type ResolvedEndpoint,
  resolveEndpoint,
  runtimeDirsOf,
} from './discovery.js'
export {
  DEFAULT_PAUSE_POLL_MS,
  type ForegroundOptions,
  type ForegroundOutcome,
  superviseForeground,
} from './foreground.js'
export {
  type ControlPlaneLink,
  connectHttp,
  endpointOf,
  httpLink,
  LinkError,
  type LinkRequest,
  type LinkResponse,
} from './link.js'
export {
  createOutput,
  duration,
  emit,
  envelopeOf,
  type JsonEnvelope,
  type Output,
  pad,
  table,
  tristate,
} from './output.js'
export {
  findMissionRun,
  NO_CONTROL_PLANE_HEADER,
  noControlPlaneMessage,
  openPlane,
  parseRunId,
  parseTaskId,
  requireLink,
  resolveRunId,
  withPlane,
} from './plane.js'
export { buildProgram, execute, main, VERSION } from './program.js'
export { MASK, sanitize } from './redact.js'
export {
  CliError,
  type CommandError,
  type CommandResult,
  codeOf,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_USAGE,
  type ExitCode,
  failure,
  messageOf,
  ok,
  usage,
  usageError,
} from './result.js'
export {
  PERSISTED_SOURCE,
  persistenceOf,
  type RunningReading,
  readPersistedRunning,
  snapshotWithPersistedRunning,
} from './running.js'
export {
  EXAMPLE_MISSION_ID,
  GATES_TEMPLATE,
  MISSION_TEMPLATE,
  PROJECT_TEMPLATE,
} from './templates.js'
