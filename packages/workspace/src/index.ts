export type {
  AttemptObservation,
  NameStatusEntry,
  NumstatEntry,
  ObservationInput,
  WorkspaceScope,
} from './diff.js'
export {
  buildObservation,
  EMPTY_SCOPE,
  excludeLinkedPaths,
  mergeDiffEntries,
  parseNameStatusZ,
  parseNumstatZ,
  scopedPaths,
} from './diff.js'
export type { WorkspaceErrorOptions, WorkspaceStage } from './errors.js'
export {
  isWorkspaceBusyError,
  isWorkspaceError,
  toFailureReason,
  WORKSPACE_STAGES,
  WorkspaceBusyError,
  WorkspaceError,
} from './errors.js'
export type { GitOptions, GitResult } from './git.js'
export { DEFAULT_GIT_MAX_BUFFER, DEFAULT_GIT_TIMEOUT_MS, git, gitText, splitNul } from './git.js'
export type {
  GitWorktreeProviderConfig,
  MissionWorkspaceRequest,
} from './git-worktree-provider.js'
export { GitWorktreeWorkspaceProvider } from './git-worktree-provider.js'
export type { GitIntegratorConfig } from './integrator.js'
export { GitIntegrator } from './integrator.js'
export type { BusyPolicy } from './lease.js'
export { Mutex, WriteGate } from './lease.js'
export {
  attemptDirName,
  attemptWorktreePath,
  DEFAULT_MISSION_BRANCH_PREFIX,
  DEFAULT_TASK_BRANCH_PREFIX,
  DEFAULT_WORKTREE_ROOT,
  missionBranchName,
  resolveAttemptNumber,
  slugifyBranch,
  taskBranchName,
} from './naming.js'
export type { AttemptCommit, CommitOptions, ObserveOptions } from './ops.js'
export {
  commitWorkingTree,
  isNoChanges,
  observeWorkingTree,
  resetIndex,
  stageIntent,
} from './ops.js'
export type { WorktreeEntry } from './repo.js'
export {
  branchExists,
  currentBranch,
  ensureBranch,
  fastForwardBranch,
  isAncestor,
  isGitRepo,
  listWorktrees,
  parseWorktreeList,
  removeWorktree,
  revParse,
  tryRevParse,
  unmergedPaths,
  worktreeOnBranch,
} from './repo.js'
export type {
  SetupCommandResult,
  SetupLinkSkip,
  SetupSkipReason,
  WorkspaceSetup,
  WorkspaceSetupCommand,
  WorkspaceSetupResult,
} from './setup.js'
export {
  DEFAULT_WORKSPACE_SETUP_TIMEOUT_MS,
  EMPTY_SETUP_RESULT,
  normalizeSetupCommand,
  runWorkspaceSetup,
} from './setup.js'
export type { SharedProviderConfig } from './shared-provider.js'
export { SharedWorkspaceProvider } from './shared-provider.js'
export type { AttemptLease } from './types.js'
