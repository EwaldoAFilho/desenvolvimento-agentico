export const PACKAGE_NAME = '@agentic/gates'

export { displayGateCwd, resolveGateCwd, resolveGateWorkspace } from './cwd.js'
export type { DescribableGate, GateCommandRepro } from './describe.js'
export { describeGate, describeGateScript, shellQuote } from './describe.js'
export type { GateErrorCode } from './errors.js'
export { GATE_ERROR_CODES, GateError, isGateError } from './errors.js'
export type { GateProfiles } from './profiles.js'
export { loadGateProfiles } from './profiles.js'
export {
  DEFAULT_GATE_MAX_OUTPUT_BYTES,
  DEFAULT_GATE_TIMEOUT_MS,
  effectiveEnvAllow,
  GateRunner,
} from './runner.js'
export { tokenizeCommandLine } from './tokenize.js'
export type {
  GateCommandError,
  GateCommandOutput,
  GateCommandRecord,
  GateRunnerDeps,
  GateRunRequest,
  GateRunResult,
  GateSkipReason,
  SkippedGateCommand,
} from './types.js'
