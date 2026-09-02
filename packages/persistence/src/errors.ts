/** Erro base do adaptador. Nenhum erro daqui vaza tipo do driver. */
export class PersistenceError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
    this.code = code
  }
}

export class MigrationError extends PersistenceError {
  readonly version: number

  constructor(version: number, name: string, cause: unknown) {
    super('MIGRATION_FAILED', `migracao ${version} (${name}) falhou: ${describe(cause)}`, { cause })
    this.version = version
  }
}

export class SchemaVersionError extends PersistenceError {
  readonly found: number
  readonly expected: number

  constructor(found: number, expected: number) {
    super(
      'SCHEMA_VERSION',
      `banco na versao ${found}, esperada ${expected}: abra em modo readwrite para migrar`,
    )
    this.found = found
    this.expected = expected
  }
}

/**
 * O banco operacional ainda nao existe, e ABRI-LO seria inicializar o projeto.
 *
 * Criar `state.db` e migrar sao ESCRITAS, e escrita pertence a quem possui o projeto (I14).
 * Um comando de leitura — `status`, `report`, `doctor` — que abrisse o banco em `readwrite`
 * inicializaria um projeto de terceiro so por ter sido chamado ali, e num diretorio que pode
 * nem ser o certo. Recusar com um tipo proprio deixa a CLI dizer a frase util ("rode `agentic
 * mission start`") em vez de vazar `SQLITE_CANTOPEN`.
 */
export class DatabaseNotInitializedError extends PersistenceError {
  readonly path: string

  constructor(path: string) {
    super(
      'DATABASE_NOT_INITIALIZED',
      `projeto ainda nao inicializado: ${path} nao existe. Leitura nao cria banco — quem ` +
        'inicializa e o dono do projeto (I14)',
    )
    this.path = path
  }
}

/**
 * Fechar com escrita de artefato em voo seria devolver o projeto com efeito vivo (I15).
 *
 * A escrita ja passou pela guarda e esta entre o `mkdir` e o `writeFile`: cancelar nao e
 * possivel, e fechar o banco por baixo dela deixaria um arquivo sem linha. Quem fecha
 * espera `settle()` antes; quem nao esperou recebe esta recusa — e o lease, ao ve-la,
 * NAO solta o lock do arquivo.
 */
export class WritesInFlightError extends PersistenceError {
  readonly pending: number

  constructor(pending: number) {
    super(
      'WRITES_IN_FLIGHT',
      `${pending} escrita(s) de artefato ainda em voo: fechar agora deixaria efeito vivo ` +
        'depois da posse (I15); espere settle() antes de fechar',
    )
    this.pending = pending
  }
}

export class ReadOnlyDatabaseError extends PersistenceError {
  constructor(operation: string) {
    super('READ_ONLY', `operacao de escrita "${operation}" em conexao readonly (I7)`)
  }
}

/**
 * I1: quem altera estado sem emitir evento quebra o invariante. A unidade de trabalho recusa
 * o commit antes de tocar o banco — falha barulhenta, nunca divergencia silenciosa.
 */
export class StateWithoutEventError extends PersistenceError {
  readonly writes: readonly string[]

  constructor(writes: readonly string[]) {
    super(
      'STATE_WITHOUT_EVENT',
      `I1: transacao gravou estado (${writes.join(', ')}) sem nenhum evento; ` +
        'use putStateWithoutEvent(motivo) se for migracao ou recovery',
    )
    this.writes = writes
  }
}

export class ArtifactPathError extends PersistenceError {
  readonly requested: string

  constructor(requested: string, rule: string) {
    super('ARTIFACT_PATH', `caminho de artefato invalido (${rule}): ${requested}`)
    this.requested = requested
  }
}

export class ArtifactNotFoundError extends PersistenceError {
  constructor(reference: string) {
    super('ARTIFACT_NOT_FOUND', `artefato nao encontrado: ${reference}`)
  }
}

export class RowDecodeError extends PersistenceError {
  constructor(table: string, detail: string) {
    super('ROW_DECODE', `linha invalida em ${table}: ${detail}`)
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
