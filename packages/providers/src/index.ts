export const PACKAGE_NAME = '@agentic/providers'

export type { AssignmentPrompt, PromptSection } from './assignment-prompt.js'
export {
  assignmentHeading,
  assignmentPromptText,
  assignmentSections,
  buildAssignmentPrompt,
  renderSections,
} from './assignment-prompt.js'
export type { CapacityBookLike, CapacityLimits } from './capacity.js'
export { CapacityBook, slotFor } from './capacity.js'
export {
  CLAUDE_CODE_DEFAULT_COMMAND,
  CLAUDE_CODE_DESCRIPTOR,
  CLAUDE_CODE_PROVIDER_ID,
  CLAUDE_CODE_READINESS_ARGS,
  CLAUDE_CODE_RUN_ARGS,
  ClaudeCodeCliProvider,
} from './claude-code.js'
export {
  CODEX_DEFAULT_COMMAND,
  CODEX_DESCRIPTOR,
  CODEX_PROVIDER_ID,
  CODEX_READINESS_ARGS,
  CODEX_RUN_ARGS,
  CodexCliProvider,
} from './codex.js'
export {
  describeUnknownError,
  InvalidProviderDescriptorError,
  ProviderAtCapacityError,
  UnknownProviderError,
} from './errors.js'
export type {
  LocalCliDescriptor,
  LocalCliProviderOptions,
  LocalCliRuntime,
} from './local-cli.js'
export { LocalCliAgentProvider } from './local-cli.js'
export { AgentLogRecorder, pumpInto } from './logs.js'
export type {
  MockAgentProviderOptions,
  MockScript,
  MockScriptStep,
  MockStartFailure,
  PlannedWrite,
} from './mock.js'
export {
  MOCK_CWD_TOKEN,
  MOCK_DEFAULT_KEY,
  MOCK_FALLBACK_STEP,
  MOCK_PROVIDER_ID,
  MOCK_VERSION,
  MockAgentProvider,
  planWrites,
} from './mock.js'
export {
  cancelReasonOf,
  claimsFromOutput,
  logsRefFor,
  MAX_CLAIM_DETAIL_CHARS,
  MAX_CLAIM_SUMMARY_CHARS,
  outcomeStatusFromExit,
  runStatusFor,
  spawnErrorOf,
} from './outcome.js'
export type {
  LocalCliMissionPlannerOptions,
  LocalCliPlannerDescriptor,
  MissionPlannerRegistryOptions,
  PlanAccepted,
  PlannerScriptStep,
  PlanReading,
  PlanRejected,
  ScriptedMissionPlannerOptions,
} from './planner.js'
export {
  assertReadOnlyPlanArgs,
  BUILT_IN_PLANNER_DESCRIPTORS,
  CLAUDE_CODE_PLAN_ARGS,
  CLAUDE_CODE_PLANNER_DESCRIPTOR,
  CODEX_PLAN_ARGS,
  CODEX_PLANNER_DESCRIPTOR,
  canonicalOf,
  createMissionPlannerRegistry,
  DEFAULT_MAX_PLANNER_OUTPUT_CHARS,
  DefaultMissionPlannerRegistry,
  LocalCliMissionPlanner,
  MAX_REVISION_PREVIOUS_CHARS,
  PLAN_BLOCK_BEGIN,
  PLAN_BLOCK_END,
  PLANNER_ENV_ALLOW,
  PLANNING_HEADING,
  plannerDescriptorFrom,
  plannerEnv,
  plannerLogsRef,
  planningPromptText,
  planningResultFrom,
  planningSections,
  readMissionProposal,
  SCRIPTED_PLANNER_ID,
  ScriptedMissionPlanner,
  WRITE_GRANTING_ARGS,
  withoutCredentials,
} from './planner.js'
export type { HealthCheckedAgentProvider } from './provider.js'
export type {
  ProviderFactory,
  ProviderFactoryInput,
  ProviderRegistryOptions,
} from './registry.js'
export {
  BUILT_IN_PROVIDER_FACTORIES,
  createProviderRegistry,
  createProviderRegistryFromProject,
  DefaultProviderRegistry,
  defaultProviderFactory,
  descriptorFromConfig,
} from './registry.js'
