export const PACKAGE_NAME = '@agentic/cli'

export {
  capacityCheck,
  type DoctorArgs,
  type DoctorCheck,
  type DoctorData,
  doctorCommand,
  MIN_NODE_MAJOR,
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
export { type ProvidersArgs, providerRows, providersCommand } from './commands/providers.js'
export { type RunReportArgs, runReportCommand } from './commands/run-report.js'
export { SERVER_COMMAND, type ServeArgs, type ServeData, serveCommand } from './commands/serve.js'
export { type TaskInspectArgs, taskInspectCommand } from './commands/task-inspect.js'
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
export { type CommandDeps, defaultDeps, type GitProbe } from './deps.js'
export { renderDiagnostic, renderDiagnostics, summaryOf } from './diagnostics.js'
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
  openPlane,
  parseRunId,
  parseTaskId,
  requireLink,
  resolveRunId,
  withPlane,
} from './plane.js'
export { buildProgram, execute, main, VERSION } from './program.js'
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
  EXAMPLE_MISSION_ID,
  GATES_TEMPLATE,
  MISSION_TEMPLATE,
  PROJECT_TEMPLATE,
} from './templates.js'
