import { randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type SqliteDatabase, sqliteDriver } from './driver.js'

/**
 * Posse do projeto (I14): no maximo UM control plane owner por `repoRoot` canonico.
 *
 * O mecanismo e um banco SQLite DEDICADO — `.agentic/control-plane.lock.db` — sobre o qual
 * o dono mantem uma transacao `BEGIN EXCLUSIVE` aberta pela vida do processo. Ele nao guarda
 * NADA: sem tabela, sem linha, sem migracao. O arquivo fica com zero byte para sempre. O que
 * vale nao e o conteudo, e o LOCK DE ARQUIVO que o SQLite pede ao sistema operacional
 * (`fcntl` em Linux/macOS/WSL, `LockFileEx` em Windows) para sustentar a transacao.
 *
 * Duas propriedades vem de graca disso, e sao as duas mais dificeis desta fatia:
 *
 * 1. **Exclusividade atomica.** Quem chega depois recebe `SQLITE_BUSY`. Nao ha janela entre
 *    "ver se ha dono" e "virar dono": e um ato so, arbitrado pelo kernel. Medido com oito
 *    processos concorrentes: exatamente um vencedor, em todas as rodadas.
 * 2. **Liberacao sem cleanup.** O lock morre com o processo — `SIGKILL`, OOM, queda de
 *    energia, reboot. Nao ha arquivo stale para interpretar, nao ha heurustica de vivacidade,
 *    e `release()` que falhe nao deixa o projeto trancado. Medido: depois de um `SIGKILL`, o
 *    proximo processo assume em ~1ms.
 *
 * Por isso o PID nao participa da autoridade. Ele e informacao para o humano ler; quem decide
 * e o lock. PID reutilizado por outro programa nao muda nada aqui.
 *
 * O que o lock NAO faz: dizer QUEM e o dono. Guardar a identidade dentro do proprio banco
 * exigiria commitar uma linha, e commitar solta a transacao que sustenta a posse — a janela
 * entre soltar e retomar seria exatamente a corrida que este arquivo existe para eliminar.
 * A identidade mora em `control-plane.json` (descoberta), publicada pelo dono DEPOIS de
 * adquirir a posse, e as duas se ligam pelo `instanceId`.
 *
 * Limite declarado (threat model): o lock impede duas instancias LEGITIMAS do produto de
 * operar o mesmo projeto. Ele nao e barreira contra alguem com acesso ao disco — apagar o
 * arquivo enquanto o dono vive derruba a exclusividade, e nenhum mecanismo de arquivo
 * resolveria isso. Locks POSIX tambem nao sao confiaveis em sistema de arquivos de rede
 * (NFS/SMB); `.agentic/` e local por desenho (ADR-0003).
 */
export const CONTROL_PLANE_LOCK_FILE = 'control-plane.lock.db'

/**
 * Espera antes de concluir que ha um dono. Nao e para esperar o dono sair — o dono nao sai —
 * e para atravessar o instante em que dois processos CRIAM o arquivo ao mesmo tempo.
 *
 * Com `0`, essa disputa de criacao vira recusa: medido em 8 processos x 12 rodadas, uma
 * rodada terminou com ZERO vencedores — ninguem subiria, e o projeto pareceria possuido por
 * um dono que nao existe. Com 250ms, doze rodadas em doze com exatamente um vencedor. O
 * perdedor legitimo continua sabendo em ~250ms, que ninguem percebe.
 */
export const DEFAULT_LOCK_BUSY_TIMEOUT_MS = 250

/** Posse viva. Enquanto este objeto existir, nenhum outro processo adquire o mesmo projeto. */
export interface ControlPlaneLease {
  /** Identidade do processo dono. Estavel, unica, e NAO derivada do PID. */
  readonly instanceId: string
  /** Diretorio canonico que a posse protege — o mesmo que guarda `state.db`. */
  readonly ownedDir: string
  readonly lockPath: string
  readonly held: boolean
  /** Idempotente. Falhar aqui nao tranca o projeto: o SO solta o lock no fim do processo. */
  release(): void
}

export const OWNERSHIP_ALREADY_HELD = 'OWNERSHIP_ALREADY_HELD'

export interface OwnershipRefused {
  readonly ok: false
  readonly code: typeof OWNERSHIP_ALREADY_HELD
  readonly lockPath: string
  readonly ownedDir: string
  readonly detail: string
}

export type OwnershipOutcome =
  | { readonly ok: true; readonly lease: ControlPlaneLease }
  | OwnershipRefused

export interface AcquireOwnershipOptions {
  /** Diretorio `.agentic` do projeto. E ele que a posse protege, nao o endereco HTTP. */
  readonly baseDir: string
  /** Injetavel para o teste; por padrao um UUID novo a cada processo. */
  readonly instanceId?: string
  readonly busyTimeoutMs?: number
}

/** Identidade do processo dono. UUID v4: unico, sem coordenacao, nunca reaproveitado. */
export function newInstanceId(): string {
  return randomUUID()
}

/**
 * Caminho REAL do diretorio, resolvendo links simbolicos.
 *
 * `/repo` e `/atalho-para-repo` sao o mesmo projeto e precisam disputar a mesma posse —
 * comparar texto de caminho daria dois donos para um projeto so. `realpathSync.native`
 * tambem normaliza a letra do drive no Windows. Se o caminho nao existir (ou o SO recusar),
 * cai para `resolve`: melhor uma chave menos canonica do que recusar o boot.
 */
export function canonicalDir(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync.native(absolute)
  } catch {
    try {
      return realpathSync(absolute)
    } catch {
      return absolute
    }
  }
}

export function controlPlaneLockPath(baseDir: string): string {
  return join(resolve(baseDir), CONTROL_PLANE_LOCK_FILE)
}

function isBusy(error: unknown): boolean {
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' && code.startsWith('SQLITE_BUSY')
}

/**
 * Tenta virar o dono do projeto. Sincrona de proposito: entre "perguntar" e "possuir" nao
 * pode existir um `await` — e nesse intervalo que dois processos viram dois donos.
 *
 * Devolve a posse ou a recusa com motivo. Nunca apaga nada, nunca sobrescreve nada e nunca
 * decide por PID: quem recusa e o lock.
 */
export function acquireControlPlaneOwnership(options: AcquireOwnershipOptions): OwnershipOutcome {
  const requested = resolve(options.baseDir)
  // O diretorio precisa existir antes de ser canonicalizado — e ele e o mesmo que
  // `openPersistence` criaria em seguida para o `state.db`.
  mkdirSync(requested, { recursive: true })
  const ownedDir = canonicalDir(requested)
  const lockPath = controlPlaneLockPath(ownedDir)
  const timeout = options.busyTimeoutMs ?? DEFAULT_LOCK_BUSY_TIMEOUT_MS

  const Driver = sqliteDriver()
  let db: SqliteDatabase
  try {
    db = new Driver(lockPath, { timeout })
  } catch (error) {
    if (!isBusy(error)) throw error
    return {
      ok: false,
      code: OWNERSHIP_ALREADY_HELD,
      lockPath,
      ownedDir,
      detail: 'o arquivo de posse ja esta em uso por outro control plane',
    }
  }

  try {
    // Sem PRAGMA e sem schema: nada e escrito no banco, nunca. O journal padrao ja da o
    // lock exclusivo de arquivo, e ligar WAL aqui seria uma escrita a mais para disputar
    // exatamente no instante em que dois processos comecam juntos.
    db.prepare('BEGIN EXCLUSIVE').run()
  } catch (error) {
    db.close()
    if (!isBusy(error)) throw error
    return {
      ok: false,
      code: OWNERSHIP_ALREADY_HELD,
      lockPath,
      ownedDir,
      detail: `outro control plane ja possui ${ownedDir}`,
    }
  }

  let held = true
  const instanceId = options.instanceId ?? newInstanceId()
  return {
    ok: true,
    lease: {
      instanceId,
      ownedDir,
      lockPath,
      get held(): boolean {
        return held
      },
      release: (): void => {
        if (!held) return
        held = false
        // Fechar ja desfaz a transacao; o ROLLBACK explicito so torna a intencao legivel.
        try {
          db.prepare('ROLLBACK').run()
        } catch {
          /* transacao ja desfeita: o que importa e soltar o arquivo, e `close` solta */
        }
        try {
          db.close()
        } catch {
          /* o SO solta o lock no fim do processo de qualquer forma */
        }
      },
    },
  }
}
