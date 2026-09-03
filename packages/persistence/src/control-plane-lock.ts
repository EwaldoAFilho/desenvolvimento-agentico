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
  /**
   * Amarra o tempo de vida de um ESCRITOR ao tempo de vida da posse.
   *
   * Este e o mecanismo que fecha o blocker mais duro da 003B: uma funcao capturada enquanto
   * havia posse continuava escrevendo depois do `release`. Toda tentativa de resolver isso
   * ESCONDENDO a funcao — Proxy, allowlist, trap de propriedade — perde por construcao,
   * porque o chamador ja tem a referencia na mao; nao ha o que esconder. O que funciona e
   * tirar o BANCO de baixo dela.
   *
   * Quem abre uma conexao mutavel sobre este projeto registra aqui como fecha-la. `release`
   * chama os ganchos ANTES de soltar o lock do arquivo, entao no instante em que outro
   * processo pode virar dono, o escritor deste ja esta fechado — nunca dois escritores.
   *
   * Devolve o cancelamento, para um plane que fecha sozinho nao deixar gancho acumulado
   * numa posse que atravessa varios planes (o `reopen` do harness e o caso real).
   */
  onRelease(hook: () => void): () => void
  /**
   * Devolve o projeto. `true` = o lock do arquivo foi solto e outro processo pode assumir.
   * `false` = algum escritor recusou fechar (efeito em voo, I15) e o lock CONTINUA com este
   * processo — chame de novo quando o efeito terminar. Idempotente: depois de `true`, sempre
   * `true`. Falhar aqui nao tranca o projeto: o SO solta o lock no fim do processo.
   */
  release(): boolean
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

/** O caminho nao pode ser canonicalizado — e sem isso nao ha como garantir I14. */
export class OwnershipPathError extends Error {
  readonly path: string

  constructor(path: string, cause: unknown) {
    super(
      `nao foi possivel resolver o caminho real de ${path}: sem isso, dois caminhos para o ` +
        'mesmo projeto poderiam virar dois donos (I14)',
    )
    this.name = 'OwnershipPathError'
    this.path = path
    this.cause = cause
  }
}

/**
 * Caminho REAL do diretorio, resolvendo links simbolicos.
 *
 * `/repo` e `/atalho-para-repo` sao o mesmo projeto e precisam disputar a mesma posse —
 * comparar texto de caminho daria dois donos para um projeto so. `realpathSync.native`
 * tambem normaliza a letra do drive no Windows.
 *
 * Falhar aqui LANCA, e essa escolha e o oposto da obvia. Cair para `resolve` manteria o boot
 * de pe ao custo de uma chave que nao unifica aliases — ou seja, trocaria a invariante por
 * disponibilidade, exatamente na funcao que existe para sustentar a invariante. Como o
 * diretorio ja foi criado antes desta chamada, o unico jeito de chegar aqui e um problema
 * real de ambiente (permissao, ciclo de links), e para esse caso recusar e a resposta certa.
 */
export function canonicalDir(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync.native(absolute)
  } catch {
    try {
      return realpathSync(absolute)
    } catch (cause) {
      throw new OwnershipPathError(absolute, cause)
    }
  }
}

/**
 * Caminho canonico quando o diretorio ja existe; o caminho resolvido quando ele ainda nao
 * existe.
 *
 * `canonicalDir` recusa o que nao consegue resolver, e essa recusa e certa NA HORA DE
 * POSSUIR: ali o diretorio ja foi criado, e falhar significa ambiente quebrado. Mas a
 * IDENTIDADE do projeto e calculada antes disso — no boot, na CLI, num comando de leitura —
 * e nesse momento `<repoRoot>/.agentic` pode legitimamente ainda nao existir (projeto novo,
 * primeiro comando). Derrubar o comando por isso seria trocar diagnostico por acidente.
 *
 * A diferenca entre os dois nao enfraquece I14: o que unifica aliases e a canonicalizacao
 * feita por `acquireControlPlaneOwnership` sobre o diretorio JA criado. Esta funcao serve
 * para que todos os entrypoints CHEGUEM ao mesmo caminho logico antes disso.
 */
export function canonicalIfPresent(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync.native(absolute)
  } catch {
    /* pode nao existir ainda: segue para a tentativa portavel */
  }
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
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
  // Gerado ANTES de tomar o lock: nada que possa lancar pode ficar entre adquirir a posse e
  // devolver o lease, ou o processo sairia segurando um lock que ninguem sabe soltar.
  const instanceId = options.instanceId ?? newInstanceId()

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
    // Fechar nao pode roubar o motivo: uma falha ao devolver a conexao viraria um erro
    // sem relacao nenhuma com "o projeto ja tem dono", que e o que o chamador precisa ler.
    try {
      db.close()
    } catch {
      /* a conexao morre com o processo; o motivo abaixo e que importa */
    }
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
  const ganchos = new Set<() => void>()
  return {
    ok: true,
    lease: {
      instanceId,
      ownedDir,
      lockPath,
      get held(): boolean {
        return held
      },
      onRelease: (hook: () => void): (() => void) => {
        // Registrar depois de soltar seria prometer uma revogacao que nunca vem: o gancho
        // roda na hora, e o escritor que chegou tarde morre imediatamente.
        if (!held) {
          hook()
          return () => undefined
        }
        ganchos.add(hook)
        return () => {
          ganchos.delete(hook)
        }
      },
      /**
       * `held` e `db.open` sao coisas diferentes, e confundi-las custa caro.
       *
       * `held` vira `false` na primeira chamada e nunca mais volta: dali em diante este
       * control plane nao pode agir, tenha o arquivo sido solto ou nao. Ja a CONEXAO so
       * para de ser tentada quando fecha de verdade — se `close` falhar, a proxima chamada
       * tenta outra vez em vez de virar no-op sobre um lock ainda segurado.
       *
       * A ORDEM dos tres passos e a garantia, e nao ha outra que sirva:
       *
       * 1. `held = false` primeiro, para nenhuma chamada nova comecar durante a saida.
       * 2. Fechar os escritores, para que a capacidade morra JUNTO com a posse — e nao
       *    depois dela, que e a janela onde o dono seguinte encontra dois escritores.
       * 3. Soltar o lock do arquivo por ultimo, quando ja nao ha o que escrever.
       *
       * Um gancho que falha nao pode impedir os outros nem segurar o lock: o que ele
       * protege e o banco DESTE processo, e o processo inteiro esta indo embora.
       */
      release: (): boolean => {
        held = false
        /**
         * Escritor que NAO fechou impede a entrega do projeto. E o ponto todo.
         *
         * Engolir a falha e soltar o lock em seguida seria o pior desfecho possivel: a
         * conexao mutavel continuaria aberta — e `writable` continuaria verdadeiro, porque
         * ele pergunta ao driver — enquanto outro processo ja poderia assumir. Dois
         * escritores sobre o mesmo `state.db`, que e exatamente o dano de D4.
         *
         * Segurar o lock e o mal MENOR e ja era o modelo declarado (ADR-0013): um projeto
         * que continua possuido por um processo defeituoso apenas ATRASA o takeover, e a
         * posse morre com o processo de qualquer jeito. O gancho que falhou fica registrado
         * para um `release` seguinte tentar de novo, em vez de virar no-op sobre um escritor
         * ainda vivo.
         */
        let algumFalhou = false
        for (const hook of [...ganchos]) {
          try {
            hook()
            ganchos.delete(hook)
          } catch {
            algumFalhou = true
          }
        }
        if (algumFalhou) return false
        if (!db.open) return true
        // Fechar ja desfaz a transacao; o ROLLBACK explicito so torna a intencao legivel.
        try {
          db.prepare('ROLLBACK').run()
        } catch {
          /* transacao ja desfeita: o que importa e soltar o arquivo, e `close` solta */
        }
        try {
          db.close()
        } catch {
          /* o SO solta o lock no fim do processo; a proxima chamada tenta de novo */
          return false
        }
        return true
      },
    },
  }
}
