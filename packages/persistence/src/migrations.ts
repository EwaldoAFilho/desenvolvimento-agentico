import type { SqliteDatabase } from './driver.js'
import { MigrationError } from './errors.js'

export interface Migration {
  readonly version: number
  readonly name: string
  readonly sql: string
}

export interface AppliedMigration {
  readonly version: number
  readonly name: string
  readonly appliedAt: Date
}

const SCHEMA_MIGRATIONS = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`

/** ARCHITECTURE 6.1. Colunas com o nome exato do documento; ver README de concerns. */
const INITIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  spec_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  policies_json TEXT NOT NULL,
  graph_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  integration_branch TEXT,
  mission_gate_id TEXT,
  mission_gate_execution_id TEXT,
  failure_reason TEXT
);

CREATE TABLE IF NOT EXISTS task_runs (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  current_attempt_id TEXT,
  unblocked_by_json TEXT NOT NULL DEFAULT '[]',
  ready_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  outcome TEXT,
  blockage_json TEXT,
  PRIMARY KEY (run_id, task_id)
);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  executor_json TEXT NOT NULL,
  dispatch_reason_json TEXT NOT NULL,
  workspace_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  result TEXT,
  failure_code TEXT,
  failure_detail TEXT,
  claims_json TEXT,
  observation_json TEXT,
  usage_json TEXT,
  UNIQUE (run_id, task_id, attempt_number),
  FOREIGN KEY (run_id, task_id) REFERENCES task_runs(run_id, task_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gate_executions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  gate_id TEXT NOT NULL,
  attempt_id TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  results_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  reviewer_json TEXT NOT NULL,
  verdict TEXT NOT NULL,
  findings_json TEXT NOT NULL DEFAULT '[]',
  rationale TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  input_json TEXT NOT NULL,
  policy TEXT NOT NULL,
  policy_outcome TEXT NOT NULL,
  policy_outcome_reason TEXT
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  task_id TEXT,
  attempt_id TEXT,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS locks (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  path_prefix TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  PRIMARY KEY (run_id, path_prefix)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  digest TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, path)
);

CREATE INDEX IF NOT EXISTS idx_events_run_seq ON events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(run_id, status);
CREATE INDEX IF NOT EXISTS idx_attempts_task ON attempts(run_id, task_id, attempt_number);
CREATE INDEX IF NOT EXISTS idx_gate_executions_attempt ON gate_executions(attempt_id);
CREATE INDEX IF NOT EXISTS idx_reviews_attempt ON reviews(attempt_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_locks_attempt ON locks(attempt_id);
`

/** I5 e P12 viram regra do banco: append-only nao depende da disciplina do chamador. */
const APPEND_ONLY_GUARDS = `
CREATE TRIGGER IF NOT EXISTS attempts_immutable_when_closed
BEFORE UPDATE ON attempts FOR EACH ROW WHEN OLD.finished_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'I5: tentativa encerrada nunca e alterada');
END;

CREATE TRIGGER IF NOT EXISTS attempts_no_delete
BEFORE DELETE ON attempts FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'I5: tentativa nunca e removida');
END;

CREATE TRIGGER IF NOT EXISTS events_no_update
BEFORE UPDATE ON events FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'P12: evento gravado nunca e alterado');
END;

CREATE TRIGGER IF NOT EXISTS events_no_delete
BEFORE DELETE ON events FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'P12: evento gravado nunca e removido');
END;
`

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial_schema', sql: INITIAL_SCHEMA },
  { version: 2, name: 'append_only_guards', sql: APPEND_ONLY_GUARDS },
]

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
)

function ensureMigrationsTable(db: SqliteDatabase): void {
  db.exec(SCHEMA_MIGRATIONS)
}

export function appliedMigrations(db: SqliteDatabase): AppliedMigration[] {
  ensureMigrationsTable(db)
  const rows = db
    .prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version')
    .all() as { version: number; name: string; applied_at: string }[]
  return rows.map((row) => ({
    version: row.version,
    name: row.name,
    appliedAt: new Date(row.applied_at),
  }))
}

export function schemaVersion(db: SqliteDatabase): number {
  ensureMigrationsTable(db)
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
    version: number | null
  }
  return row.version ?? 0
}

/**
 * Idempotente por construcao: a versao ja registrada nao roda de novo, e cada migracao roda
 * dentro de uma transacao junto do seu registro — ou aplica inteira, ou nao aplica.
 */
export function applyMigrations(
  db: SqliteDatabase,
  migrations: readonly Migration[] = MIGRATIONS,
): AppliedMigration[] {
  ensureMigrationsTable(db)
  const known = new Set(
    (db.prepare('SELECT version FROM schema_migrations').pluck().all() as number[]).map(Number),
  )
  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  )
  const applied: AppliedMigration[] = []

  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (known.has(migration.version)) continue
    const appliedAt = new Date()
    try {
      db.transaction(() => {
        db.exec(migration.sql)
        record.run(migration.version, migration.name, appliedAt.toISOString())
      }).immediate()
    } catch (cause) {
      throw new MigrationError(migration.version, migration.name, cause)
    }
    applied.push({ version: migration.version, name: migration.name, appliedAt })
  }

  return applied
}
