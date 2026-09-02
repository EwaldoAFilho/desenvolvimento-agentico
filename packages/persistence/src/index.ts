export const PACKAGE_NAME = '@agentic/persistence'

export {
  type ArtifactRecord,
  type ArtifactStoreDeps,
  type ArtifactWrite,
  createArtifactStore,
  FileArtifactStore,
  RUNS_DIRECTORY,
} from './artifact-store.js'
export {
  type AcquireOwnershipOptions,
  acquireControlPlaneOwnership,
  CONTROL_PLANE_LOCK_FILE,
  type ControlPlaneLease,
  canonicalDir,
  canonicalIfPresent,
  controlPlaneLockPath,
  DEFAULT_LOCK_BUSY_TIMEOUT_MS,
  newInstanceId,
  OWNERSHIP_ALREADY_HELD,
  type OwnershipOutcome,
  OwnershipPathError,
  type OwnershipRefused,
} from './control-plane-lock.js'
export {
  busyTimeout,
  type DatabaseHandle,
  type DatabaseMode,
  DEFAULT_BUSY_TIMEOUT_MS,
  journalMode,
  type OpenDatabaseOptions,
  openDatabase,
} from './database.js'
export type {
  SqliteBindings,
  SqliteDatabase,
  SqliteParam,
  SqliteRunResult,
  SqliteStatement,
  SqliteValue,
} from './driver.js'
export {
  ArtifactNotFoundError,
  ArtifactPathError,
  DatabaseNotInitializedError,
  MigrationError,
  PersistenceError,
  ReadOnlyDatabaseError,
  RowDecodeError,
  SchemaVersionError,
  StateWithoutEventError,
  WritesInFlightError,
} from './errors.js'
export {
  createEventStore,
  DEFAULT_PAGE_SIZE,
  DEFAULT_POLL_INTERVAL_MS,
  type EventStoreOptions,
  SqliteEventStore,
} from './event-store.js'
export {
  type AppliedMigration,
  appliedMigrations,
  applyMigrations,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  type Migration,
  schemaVersion,
} from './migrations.js'
export { ChangeNotifier } from './notifier.js'
export {
  DEFAULT_BASE_DIR,
  DEFAULT_DATABASE_FILE,
  type OpenPersistenceOptions,
  openPersistence,
  type Persistence,
} from './persistence.js'
export {
  createQueries,
  type ListRunsQuery,
  type ReadEventsQuery,
  type RunSnapshotData,
  SqliteQueries,
  type TaskDetailData,
} from './queries.js'
export type {
  ArtifactRow,
  AttemptRow,
  EventRow,
  GateExecutionRow,
  LockRow,
  ReviewRow,
  RunListRow,
  RunRow,
  TaskRunRow,
  TaskStatusCountRow,
} from './rows.js'
export {
  type CommitResult,
  createRunStore,
  type RunStoreOptions,
  SqliteRunStore,
} from './run-store.js'
export { RUNTIME_DIR_NAME, runtimeDirOf } from './runtime-dir.js'
export {
  BufferedUnitOfWork,
  type LockWriter,
  type RecoveryUnitOfWork,
  type TransactionalUnitOfWork,
} from './unit-of-work.js'
