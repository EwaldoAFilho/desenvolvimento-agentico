import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { RunId } from '@agentic/domain'
import type { DatabaseHandle } from './database.js'
import type { SqliteDatabase } from './driver.js'
import { ArtifactNotFoundError, ArtifactPathError, ReadOnlyDatabaseError } from './errors.js'
import type { ArtifactRow } from './rows.js'
import { prepareCached, SQL } from './statements.js'

export interface ArtifactWrite {
  readonly runId: RunId
  readonly kind: string
  /** Relativo a `<base>/runs/<runId>/`. Sem `..`, sem caminho absoluto. */
  readonly relativePath: string
  readonly content: string | Uint8Array
  readonly createdAt?: Date
}

export interface ArtifactRecord {
  readonly id: string
  readonly runId: RunId
  readonly kind: string
  /** Relativo ao diretorio base — e o que vai para a coluna `artifacts.path`. */
  readonly path: string
  readonly absolutePath: string
  readonly digest: string
  readonly bytes: number
  readonly createdAt: Date
}

export const RUNS_DIRECTORY = 'runs'

/**
 * Primitivos de sistema de arquivos que o store usa. Injetaveis para o teste segurar uma
 * escrita num ponto controlado — e so para isso: o default e o `node:fs/promises` real.
 */
export interface ArtifactStoreDeps {
  readonly mkdir?: (path: string, options: { readonly recursive: true }) => Promise<unknown>
  readonly writeFile?: (path: string, data: Uint8Array) => Promise<void>
}

/**
 * Unico lugar do pacote que grava conteudo em disco (ADR-0003): blob volumoso fica em
 * arquivo, o banco guarda caminho + digest.
 */
export class FileArtifactStore {
  readonly #handle: DatabaseHandle
  readonly #baseDir: string
  readonly #mkdir: NonNullable<ArtifactStoreDeps['mkdir']>
  readonly #writeFile: NonNullable<ArtifactStoreDeps['writeFile']>

  constructor(handle: DatabaseHandle, baseDir: string, deps: ArtifactStoreDeps = {}) {
    this.#handle = handle
    this.#baseDir = resolve(baseDir)
    this.#mkdir = deps.mkdir ?? mkdir
    this.#writeFile = deps.writeFile ?? writeFile
  }

  get baseDir(): string {
    return this.#baseDir
  }

  get db(): SqliteDatabase {
    return this.#handle.db
  }

  runDirectory(runId: RunId): string {
    return join(this.#baseDir, RUNS_DIRECTORY, runId)
  }

  /** Resolve e prova a contencao: nada escapa de `<base>/runs/<runId>/`. */
  resolvePath(runId: RunId, relativePath: string): string {
    if (relativePath.trim().length === 0) throw new ArtifactPathError(relativePath, 'caminho vazio')
    if (isAbsolute(relativePath)) throw new ArtifactPathError(relativePath, 'caminho absoluto')
    const root = this.runDirectory(runId)
    const absolute = resolve(root, relativePath)
    if (absolute !== root && !absolute.startsWith(root + sep)) {
      throw new ArtifactPathError(relativePath, 'sai do diretorio do run')
    }
    if (absolute === root) throw new ArtifactPathError(relativePath, 'aponta para o proprio run')
    return absolute
  }

  async write(input: ArtifactWrite): Promise<ArtifactRecord> {
    /**
     * A pergunta e `writable`, nao `mode`, e a diferenca custa um arquivo.
     *
     * Este e o unico caminho de escrita do pacote que produz efeito FORA do banco: `mkdir` e
     * `writeFile` acontecem primeiro, e o `INSERT` so depois. Perguntando pelo `mode` — que
     * nao muda quando a conexao fecha — uma referencia capturada antes de `lease.release()`
     * criava ou SOBRESCREVIA o arquivo e so entao falhava no banco. Artefato e evidencia:
     * sobrescrever um arquivo ja referenciado deixa digest e metadados mentindo sobre o
     * conteudo, que e pior que a escrita recusada.
     */
    if (!this.#handle.writable) throw new ReadOnlyDatabaseError('artifact.write')
    const absolute = this.resolvePath(input.runId, input.relativePath)
    const bytes =
      typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : input.content
    const digest = createHash('sha256').update(bytes).digest('hex')
    const createdAt = input.createdAt ?? new Date()
    const relative = `${RUNS_DIRECTORY}/${input.runId}/${normalizeSeparators(input.relativePath)}`

    await this.#mkdir(dirname(absolute), { recursive: true })
    await this.#writeFile(absolute, bytes)

    const row: ArtifactRow = {
      id: randomUUID(),
      run_id: input.runId,
      kind: input.kind,
      path: relative,
      digest,
      bytes: bytes.byteLength,
      created_at: createdAt.toISOString(),
    }
    prepareCached(this.db, SQL.upsertArtifact).run(row)

    const stored = this.getByPath(input.runId, relative)
    return toRecord(stored ?? row, absolute)
  }

  async read(runId: RunId, relativePath: string): Promise<Buffer> {
    const absolute = this.resolvePath(runId, stripRunPrefix(runId, relativePath))
    try {
      return await readFile(absolute)
    } catch (cause) {
      throw new ArtifactNotFoundError(`${runId}:${relativePath} (${describe(cause)})`)
    }
  }

  async readText(runId: RunId, relativePath: string): Promise<string> {
    return (await this.read(runId, relativePath)).toString('utf8')
  }

  async readById(id: string): Promise<Buffer> {
    const row = this.get(id)
    if (row === undefined) throw new ArtifactNotFoundError(id)
    return this.read(row.run_id as RunId, row.path)
  }

  get(id: string): ArtifactRow | undefined {
    return prepareCached(this.db, 'SELECT * FROM artifacts WHERE id = ?').get(id) as
      | ArtifactRow
      | undefined
  }

  getByPath(runId: RunId, path: string): ArtifactRow | undefined {
    return prepareCached(this.db, 'SELECT * FROM artifacts WHERE run_id = ? AND path = ?').get(
      runId,
      path,
    ) as ArtifactRow | undefined
  }

  list(runId: RunId): ArtifactRow[] {
    return prepareCached(this.db, 'SELECT * FROM artifacts WHERE run_id = ? ORDER BY path').all(
      runId,
    ) as ArtifactRow[]
  }

  toRecord(row: ArtifactRow): ArtifactRecord {
    return toRecord(row, join(this.#baseDir, ...row.path.split('/')))
  }
}

function toRecord(row: ArtifactRow, absolutePath: string): ArtifactRecord {
  return {
    id: row.id,
    runId: row.run_id as RunId,
    kind: row.kind,
    path: row.path,
    absolutePath,
    digest: row.digest,
    bytes: row.bytes,
    createdAt: new Date(row.created_at),
  }
}

function normalizeSeparators(value: string): string {
  return value.split(sep).join('/').replace(/^\.\//, '')
}

/** Aceita tanto `attempts/x.log` quanto o caminho ja registrado `runs/<id>/attempts/x.log`. */
function stripRunPrefix(runId: RunId, path: string): string {
  const prefix = `${RUNS_DIRECTORY}/${runId}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function createArtifactStore(
  handle: DatabaseHandle,
  baseDir: string,
  deps?: ArtifactStoreDeps,
): FileArtifactStore {
  return new FileArtifactStore(handle, baseDir, deps)
}
