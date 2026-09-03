import { access, chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import { openPersistence, type Persistence } from '@agentic/persistence'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
 *
 * UM dono para o arquivo inteiro, e isso e deliberado. Os arquivos de E2E rodam em paralelo,
 * e cada `serve` extra e carga concorrente que faz os testes SENSIVEIS A TEMPO dos outros
 * arquivos — o probe de paralelismo de `mission-chain` e o caso medido — medirem a maquina
 * em vez do produto. Compartilhar o dono nao custa cobertura nenhuma: as perguntas abaixo
 * sao todas sobre o MESMO control plane vivo.
 */

const PRONTO = /control plane no ar em (http:\/\/\S+)/

/**
 * O fixture registra `claude` e `codex` como `local-cli`, e `doctor`/`providers` num processo
 * FILHO sondam o PATH de verdade — o que fazia estes testes dependerem da maquina do operador:
 * num runner sem as CLIs, `doctor` reporta NOT_INSTALLED e sai 1, e o teste, que quer provar
 * leitura SEM POSSE e sem banco, reprovava por um motivo que nao e o dele. Duas CLIs de mentira
 * na frente do PATH (o mesmo recurso do `git` de mentira em integration-in-flight) tornam a
 * sonda deterministica em qualquer maquina: respondem `--version` e a sonda de sessao com 0.
 * Nenhuma CLI real e invocada — que e o que a suite promete.
 */
let shimDir: string | undefined
let pathOriginal: string | undefined

beforeAll(async () => {
  if (nodeProcess.platform === 'win32') return
  shimDir = await mkdtemp(join(tmpdir(), 'agentic-cli-shim-'))
  for (const nome of ['claude', 'codex']) {
    const script = ['#!/bin/sh', `echo "${nome} 0.0.0-shim"`, 'exit 0', ''].join('\n')
    await writeFile(join(shimDir, nome), script, 'utf8')
    await chmod(join(shimDir, nome), 0o755)
  }
  pathOriginal = nodeProcess.env.PATH
  nodeProcess.env.PATH = `${shimDir}:${pathOriginal ?? ''}`
})

afterAll(async () => {
  if (pathOriginal !== undefined) nodeProcess.env.PATH = pathOriginal
  if (shimDir !== undefined) await rm(shimDir, { recursive: true, force: true })
})

async function existe(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

/** Tudo que o `.agentic` do projeto contem — a prova fisica de "nenhum banco a mais". */
async function conteudoDoRuntime(repoRoot: string): Promise<string[]> {
  return (await readdir(join(repoRoot, '.agentic'))).sort()
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

describe('leitor readonly e dono coexistem (Fases 11, 12 e 16.12)', () => {
  let fixture: Fixture
  let dono: LiveCli
  let runtime: string
  let db: string
  let endereco: string

  beforeAll(async () => {
    fixture = await materializeFixture()
    runtime = join(fixture.root, '.agentic')
    db = join(runtime, 'state.db')
    dono = await spawnCli(fixture.root, ['serve', '--port', '0'], PRONTO)
    const url = PRONTO.exec(dono.ready)?.[1]
    if (url === undefined) throw new Error(`nao achei o endereco em: ${dono.ready}`)
    endereco = url
  })

  afterAll(async () => {
    await dono?.stop().catch(() => undefined)
    await fixture?.cleanup().catch(() => undefined)
  })

  it('le o WAL do dono VIVO, sem posse, e o driver recusa escrever', async () => {
    // Com o dono vivo, `-wal` e `-shm` existem — e o leitor precisa alcancar o `-shm` para
    // achar o snapshot, que e justamente o passo que uma conexao readonly nao sabe criar.
    expect(await existe(db)).toBe(true)
    expect(await existe(`${db}-wal`), 'dono vivo mantem o -wal').toBe(true)
    expect(await existe(`${db}-shm`), 'dono vivo mantem o -shm').toBe(true)

    const leitor = openPersistence({ baseDir: runtime, mode: 'readonly' })
    try {
      expect(leitor.mode).toBe('readonly')
      expect(leitor.database.db.readonly).toBe(true)
      expect(leitor.database.writable, 'conexao readonly nunca e writable').toBe(false)
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
  })

  it('D9: providers, doctor e status respondem pela CLI real, sem deixar rastro', async () => {
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

    // Zero segundo `state.db`, zero arquivo novo: ler nao deixou rastro. E o dono continua
    // dono — um `serve` novo REUSA o endereco em vez de subir.
    expect(await conteudoDoRuntime(fixture.root)).toEqual(antes)
    expect(reusoDoDono(await runCli(fixture.root, ['serve', '--port', '0', '--json']))).toBe(
      endereco,
    )
  })

  it('leitores abertos nao impedem o dono de escrever', async () => {
    const leitores: Persistence[] = []
    try {
      // Tres leitores SEGURADOS durante a escrita. Um leitor que criasse writer, disputasse
      // posse ou travasse o banco apareceria aqui como SQLITE_BUSY no dono — e apareceria
      // exatamente no caminho que o usuario usa, porque `status` e `doctor` sao isto.
      for (let i = 0; i < 3; i += 1) {
        leitores.push(openPersistence({ baseDir: runtime, mode: 'readonly' }))
      }

      // `approve` com dono no ar VIAJA para o dono: quem escreve e o control plane, com os
      // tres leitores pendurados no mesmo `state.db`.
      const aprovacao = await runCli(fixture.root, [
        'mission',
        'approve',
        join(runtime, 'missions', 'EXEMPLO-001.mission.yaml'),
        '--actor',
        'humano@teste',
        '--json',
      ])
      expect(aprovacao.code, `${aprovacao.stdout}${aprovacao.stderr}`).toBe(0)

      // E um leitor novo enxerga o que o dono acabou de gravar: WAL entregando snapshot
      // fresco a quem nunca disputou posse nenhuma.
      const leitor = openPersistence({ baseDir: runtime, mode: 'readonly' })
      try {
        expect(leitor.queries.listRuns({ limit: 10 }).length).toBeGreaterThan(0)
      } finally {
        leitor.close()
      }
    } finally {
      for (const leitor of leitores) leitor.close()
    }
  })

  it('com o dono ENCERRADO, a leitura continua funcionando', async () => {
    await dono.stop()

    /**
     * O teste NAO afirma se o `-wal` sobrou. Medido: um `close()` limpo no mesmo processo
     * checkpointa e apaga os sidecars; um dono encerrado por SIGTERM costuma deixa-los no
     * disco. As duas coisas sao o SQLite decidindo quando checkpointar, e amarrar a suite a
     * essa escolha seria testar a biblioteca em vez do produto. O que e nosso — e o que
     * quebraria o `status` do usuario — e a leitura funcionar dos dois jeitos.
     */
    const frio = openPersistence({ baseDir: runtime, mode: 'readonly' })
    try {
      expect(frio.queries.listRuns({ limit: 10 }).length).toBeGreaterThan(0)
    } finally {
      frio.close()
    }
  })
})

describe('projeto ainda nao inicializado (Fase 10)', () => {
  it('leitura em repo sem state.db recusa com frase util e NAO cria banco', async () => {
    const fixture: Fixture = await materializeFixture()
    try {
      const runtime = join(fixture.root, '.agentic')
      for (const sufixo of ['', '-wal', '-shm']) {
        await rm(join(runtime, `state.db${sufixo}`), { force: true })
      }
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
