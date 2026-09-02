export const PACKAGE_NAME = '@agentic/process'

export { buildEnv } from './env.js'
export { redactSecrets } from './redact.js'
export {
  isProcessGroupAliveError,
  ProcessGroupAliveError,
  runCaptured,
  spawnStreaming,
} from './runtime.js'
export type {
  CapturedRun,
  ChildProcessLike,
  ExitStatus,
  RunningProcess,
  RunSpec,
  RuntimeDeps,
  SpawnFailure,
  SpawnFn,
  SpawnRequest,
} from './types.js'
export {
  DEFAULT_CLOSE_GRACE_MS,
  DEFAULT_GROUP_GRACE_MS,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_LINE_CHARS,
  DEFAULT_MAX_OUTPUT_BYTES,
} from './types.js'
