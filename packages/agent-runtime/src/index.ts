export const PACKAGE_NAME = '@agentic/agent-runtime'

export type {
  CapacityAcquired,
  CapacityAcquisition,
  CapacityDenialReason,
  CapacityDenied,
  CapacityRelease,
  CapacityReleased,
  CapacityReleaseRefusalReason,
  CapacityReleaseRefused,
  CapacityUsage,
  ProviderCapacitySnapshot,
} from './capacity.js'
export { CapacityLedger } from './capacity.js'
export {
  AgentRuntimeError,
  isAgentRuntimeError,
  ProviderNotReadyError,
  ProviderUnavailableError,
  WorkspaceCwdError,
} from './errors.js'
export {
  DEFAULT_PROBE_MAX_OUTPUT_BYTES,
  DEFAULT_PROBE_TIMEOUT_MS,
  extractVersion,
  PROBE_ENV_ALLOW,
  probeLocalAgent,
} from './probe.js'
export type {
  ExecutableFound,
  ExecutableNotFound,
  ExecutableResolution,
  ExecutableUnknown,
} from './resolve.js'
export { isDirectory, isExecutableFile, resolveExecutable } from './resolve.js'
export type { LocalProcessHandle } from './runtime.js'
export { createLocalAgentRuntime, NodeLocalAgentRuntime } from './runtime.js'
export type { LocalAgentRuntimeDeps, ProbeContext } from './types.js'
