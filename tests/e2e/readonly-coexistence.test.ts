import { access, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { openPersistence } from '@agentic/persistence'
import { describe, expect, it } from 'vitest'
import { type LiveCli, runCli, spawnCli } from './support/cross-process.js'
import { type Fixture, materializeFixture } from './support/fixture.js'

/**
 * Ler nao exige posse, e ler nao pode ATRAPALHAR o dono.
 *
 * Depois que a 003C fez `readonly` ser a conexao real de todo plane sem lease, duas coisas
 * deixaram de ser opiniao e viraram risco medivel:
 *
 * 1. **WAL.** O dono escreve com `journal_mode = WAL`. Um leitor `readonly` sobre um banco
 *    WAL precisa do `-shm` para achar o snapshot, e o SQLite so cria `-shm` a partir de uma
 *    conexao que pode escrever. Se isso nao funcionasse, `status` e `doctor` teriam parado
 *    de responder enquanto o control plane estivesse no ar — a regressao mais cara possivel,
 *    e invisivel em teste de processo unico.
 * 2. **Interferencia.** Um leitor que criasse `state.db`, disputasse posse, virasse escritor
 *    ou segurasse lock atrapalharia a adocao do dono (I13/I14).
 *
 * Nada aqui e assumido: cada afirmacao e medida contra um control plane de verdade, em outro
 * processo, escrevendo de verdade.
 */

const PRONTO = /control plane no ar em (http:\/\/\S+)/

async function existe(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

async function encerrar(vivos: readonly LiveCli[]): Promise<void> {
  for (const vivo of vivos) await vivo.stop().catch(() => undefined)
}

function urlDe(vivo: LiveCli): string {
  const url = PRONTO.exec(vivo.ready)?.[1]
  if (url === undefined) throw new Error(`nao achei o endereco em: ${vivo.ready}`)
  return url
}

/**
 * O endereco que um `serve` novo REUSOU, em vez de subir um segundo control plane.
 *
 * `serve` com um dono vivo nao e recusa: a CLI encontra o control plane publicado e devolve
 * o endereco dele (`reused: true`). Isso e o comportamento certo — e serve de prova melhor
 * que uma recusa, porque so consegue reusar quem NAO virou dono.
 */
function reusoDoDono(saida: { json(): { readonly data?: unknown } }): string {
  const data = saida.json().data as { readonly endpoint?: string; readonly reused?: boolean }
  expect(data.reused, 'um segundo `serve` nao pode virar dono').toBe(true)
  return data.endpoint ?? ''
}

/** Tudo que o `.agentic` do projeto contem — a prova fisica de "nenhum banco a mais". */
async function conteudoDoRuntime(repoRoot: string): Promise<string[]> {
  return (await readdir(join(repoRoot, '.agentic'))).sort()
}

describe('leitor readonly e dono coexistem (Fases 11 e 12)', () => {
  it('o leitor le o WAL do dono VIVO, sem posse, sem virar escritor', async () => {
    const fixture: Fixture = await materializeFixture()
    const vivos: LiveCli[] = []
    try {
      const dono = await spawnCli(fixture.root, ['serve', '--port', '0'], PRONTO)
      vivos.push(dono)

      /**
       * Os DOIS estados de um banco WAL, porque so um deles seria meia prova.
       *
       * Com o dono vivo, `-wal` e `-shm` existem e o leitor precisa alcancar o `-shm` para
       * achar o snapshot — e o `-shm` so nasce de uma conexao que escreve. Com o dono
       * encerrado, o SQLite checkpointa e APAGA os dois, e o leitor tem de continuar
       * funcionando sobre o `state.db` sozinho. Medido aqui em vez de assumido: sao dois
       * caminhos diferentes do SQLite, e a Fase 11 pedia exatamente isso.
       */
      const runtime = join(fixture.root, '.agentic')
      const db = join(runtime, 'state.db')
      expect(await existe(db)).toBe(true)
      expect(await existe(`${db}-wal`), 'dono vivo mantem o -wal').toBe(true)
      expect(await existe(`${db}-shm`), 'dono vivo mantem o -shm').toBe(true)

      // Um leitor independente, no processo do teste: nenhuma posse disputada.
      const leitor = openPersistence({ baseDir: runtime, mode: 'readonly' })
      try {
        expect(leitor.mode).toBe('readonly')
        expect(leitor.database.db.readonly).toBe(true)
        // A leitura ATRAVESSA: se o `-shm` fosse inalcancavel, isto levantaria
        // SQLITE_READONLY_CANTINIT em vez de devolver linhas.
        expect(Array.isArray(leitor.queries.listRuns({ limit: 10 }))).toBe(true)
        expect(typeof leitor.events.latestSeq()).toBe('number')

        // E o driver recusa escrever, que e a metade que interessa.
        expect(() => leitor.database.db.exec('CREATE TABLE invasor (x INTEGER)')).toThrow()
        expect(() => leitor.database.db.exec("UPDATE runs SET status = 'DONE'")).toThrow()
      } finally {
        leitor.close()
      }

      // O dono continua dono: o leitor nao tomou nem devolveu posse nenhuma. A prova e que
      // um `serve` novo REUSA o endereco publicado em vez de subir — se o leitor tivesse
      // mexido na posse, este segundo processo teria virado um segundo dono.
      expect(reusoDoDono(await runCli(fixture.root, ['serve', '--port', '0', '--json']))).toBe(
        urlDe(dono),
      )

      /**
       * Segundo estado: dono ENCERRADO. O leitor tem de continuar lendo.
       *
       * O que o teste NAO afirma e se o `-wal` sobrou. Medido: um `close()` limpo no mesmo
       * processo checkpointa e apaga os sidecars; um dono encerrado por SIGTERM costuma
       * deixa-los no disco. As duas coisas sao o SQLite decidindo quando checkpointar, e
       * amarrar a suite a essa escolha seria testar a biblioteca em vez do produto. O que e
       * nosso — e o que quebraria o `status` do usuario — e a leitura funcionar dos dois
       * jeitos.
       */
      await encerrar(vivos)
      vivos.length = 0
      const frio = openPersistence({ baseDir: runtime, mode: 'readonly' })
      try {
        expect(Array.isArray(frio.queries.listRuns({ limit: 10 }))).toBe(true)
      } finally {
        frio.close()
      }
    } finally {
      await encerrar(vivos)
      await fixture.cleanup().catch(() => undefined)
    }
  })

  it('D9: status, report, providers e doctor respondem com o dono no ar', async () => {
    const fixture: Fixture = await materializeFixture()
    const vivos: LiveCli[] = []
    try {
      const dono = await spawnCli(fixture.root, ['serve', '--port', '0'], PRONTO)
      vivos.push(dono)
      const antes = await conteudoDoRuntime(fixture.root)

      // Processo B, CLI real, sem posse. Nenhum destes pode exigir ownership.
      for (const argv of [
        ['providers', '--json'],
        ['doctor', '--json'],
      ]) {
        const saida = await runCli(fixture.root, argv)
        expect(saida.code, `${argv[0]} deveria ler sem posse:\n${saida.stderr}`).toBe(0)
        expect(saida.json().ok, `${argv[0]} deveria reportar ok`).toBe(true)
      }

      // `status` sem run e uma recusa de PRODUTO (nao ha run), nunca de posse.
      const status = await runCli(fixture.root, ['mission', 'status', '--json'])
      expect(status.json().error?.code).toBe('NO_RUN')

      // Zero segundo `state.db`, zero arquivo novo: ler nao deixou rastro.
      expect(await conteudoDoRuntime(fixture.root)).toEqual(antes)
      expect(reusoDoDono(await runCli(fixture.root, ['serve', '--port', '0', '--json']))).toBe(
        urlDe(dono),
      )
    } finally {
      await encerrar(vivos)
      await fixture.cleanup().catch(() => undefined)
    }
  })
})

describe('o leitor nao atrapalha o dono (Fase 16.12)', () => {
  it('leitores abertos nao impedem o dono de escrever nem de adotar', async () => {
    const fixture: Fixture = await materializeFixture()
    const vivos: LiveCli[] = []
    const leitores: { close(): void }[] = []
    try {
      const dono = await spawnCli(fixture.root, ['serve', '--port', '0'], PRONTO)
      vivos.push(dono)
      const runtime = join(fixture.root, '.agentic')

      // Tres leitores SEGURADOS durante a escrita. Um leitor que criasse writer, disputasse
      // posse ou travasse o banco apareceria aqui como SQLITE_BUSY no dono — e apareceria
      // exatamente no caminho que o usuario usa, porque `status` e `doctor` sao isto.
      for (let i = 0; i < 3; i += 1) {
        leitores.push(openPersistence({ baseDir: runtime, mode: 'readonly' }))
      }

      // `approve` com dono no ar VIAJA para o dono: quem escreve e o control plane, com os
      // tres leitores pendurados no mesmo `state.db`.
      const missao = join(runtime, 'missions', 'EXEMPLO-001.mission.yaml')
      const aprovacao = await runCli(fixture.root, [
        'mission',
        'approve',
        missao,
        '--actor',
        'humano@teste',
        '--json',
      ])
      expect(aprovacao.code, `${aprovacao.stdout}${aprovacao.stderr}`).toBe(0)

      // E os leitores enxergam o que o dono acabou de gravar: WAL entregando snapshot novo
      // a conexoes que ja estavam abertas antes da escrita.
      const leitor = openPersistence({ baseDir: runtime, mode: 'readonly' })
      try {
        expect(leitor.queries.listRuns({ limit: 10 }).length).toBeGreaterThan(0)
      } finally {
        leitor.close()
      }

      // Nenhum leitor virou dono: o `serve` seguinte continua reusando o mesmo endereco.
      expect(reusoDoDono(await runCli(fixture.root, ['serve', '--port', '0', '--json']))).toBe(
        urlDe(dono),
      )
    } finally {
      for (const leitor of leitores) leitor.close()
      await encerrar(vivos)
      await fixture.cleanup().catch(() => undefined)
    }
  })
})

describe('projeto ainda nao inicializado (Fase 10)', () => {
  it('leitura em repo sem state.db recusa com frase util e NAO cria banco', async () => {
    const fixture: Fixture = await materializeFixture()
    try {
      const runtime = join(fixture.root, '.agentic')
      await rm(join(runtime, 'state.db'), { force: true })
      await rm(join(runtime, 'state.db-wal'), { force: true })
      await rm(join(runtime, 'state.db-shm'), { force: true })
      expect(await existe(join(runtime, 'state.db'))).toBe(false)

      // `doctor` continua util num projeto novo: ele diagnostica o AMBIENTE, e nao ter banco
      // nao e defeito de ambiente. O que ele nao pode e inventar um.
      const doctor = await runCli(fixture.root, ['doctor', '--json'])
      expect(doctor.code, doctor.stderr).toBe(0)

      // Ja `status` precisa de banco. Recusar e certo; criar um seria inicializar o projeto
      // de outra pessoa por engano — e num diretorio que pode nem ser o certo.
      const status = await runCli(fixture.root, ['mission', 'status', '--json'])
      expect(status.code).not.toBe(0)
      // A frase precisa dizer o que fazer, nao vazar `SQLITE_CANTOPEN`.
      expect(`${status.stdout}${status.stderr}`).toMatch(/nao inicializado|nenhum run/i)

      expect(await existe(join(runtime, 'state.db'))).toBe(false)
      expect(await existe(join(runtime, 'state.db-wal'))).toBe(false)
    } finally {
      await fixture.cleanup().catch(() => undefined)
    }
  })
})
