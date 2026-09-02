import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type LiveCli,
  raceEntrypointsForOwnership,
  runCli,
  spawnCli,
} from './support/cross-process.js'
import { type Fixture, materializeFixture } from './support/fixture.js'

/**
 * I14 pelos ENTRYPOINTS, nao pela primitiva.
 *
 * A fatia 003 provou que o lock funciona quando os dois processos pedem a MESMA chave. Este
 * arquivo mede o que faltava: se `serve`, `mission start` e `mission approve` chegam a essa
 * chave pelo mesmo caminho, e se um comando que NAO tem a posse consegue mutar mesmo assim.
 *
 * Os dois defeitos que ele nasceu vermelho medindo:
 *
 * - **chave divergente:** com `project.repoRoot` apontando para fora, `mission start`
 *   disputava `<dirDoProjectYaml>/.agentic` e `serve` disputava `<repoRoot>/.agentic`. Dois
 *   donos reais para um projeto so.
 * - **mutacao sem posse:** `mission approve` abria o `state.db` e criava run + aprovacao sem
 *   nunca ter disputado a posse.
 *
 * A prova de que um comando NAO mutou por fora e fisica: um segundo `state.db` no diretorio
 * de configuracao e o rastro que o defeito deixa. Se ele existe, houve escritor a mais.
 */

/** Fornecedores in-process: nenhuma CLI real e invocada, nenhuma quota e consumida. */
function comAgentesInProcess(projectText: string): string {
  const inicio = projectText.indexOf('  default: claude-code')
  const fim = projectText.indexOf('\ngates:')
  if (inicio === -1 || fim === -1) throw new Error('fixture: bloco de providers nao encontrado')
  const bloco = [
    '  default: alfa',
    '  registry:',
    '    alfa:',
    '      kind: inprocess',
    '      maxConcurrent: 3',
    '      roles: [executor, reviewer]',
    '    beta:',
    '      kind: inprocess',
    '      maxConcurrent: 2',
    '      roles: [executor, reviewer]',
    '',
  ].join('\n')
  return projectText.slice(0, inicio) + bloco + projectText.slice(fim)
}

interface ProjetoDividido {
  /** Onde mora o `.agentic/project.yaml` — e SO ele. */
  readonly configRoot: string
  /** O repositorio de verdade, para onde `project.repoRoot` aponta. */
  readonly repoRoot: string
  readonly missionPath: string
  readonly fixture: Fixture
  cleanup(): Promise<void>
}

async function existe(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

/**
 * Um projeto cujo `project.yaml` mora FORA do repositorio, com `repoRoot` relativo.
 *
 * O `gates.file` acompanha o repositorio (caminho relativo que resolve igual pelos dois
 * ancoras) de proposito: o que esta sob medicao aqui e a POSSE, e nao a resolucao de
 * arquivos de configuracao.
 */
async function projetoComConfigForaDoRepo(): Promise<ProjetoDividido> {
  const fixture = await materializeFixture({ project: comAgentesInProcess })
  const configRoot = await realpath(await mkdtemp(join(tmpdir(), 'agentic-config-')))
  const paraORepo = relative(configRoot, fixture.root)
  const projectText = fixture.sources.projectText
    .replace('  repoRoot: .', `  repoRoot: ${paraORepo}`)
    .replace('  file: .agentic/gates.yaml', `  file: ${paraORepo}/.agentic/gates.yaml`)
  if (!projectText.includes(`repoRoot: ${paraORepo}`)) {
    throw new Error('fixture: nao consegui apontar o repoRoot para fora')
  }
  await mkdir(join(configRoot, '.agentic'), { recursive: true })
  await writeFile(join(configRoot, '.agentic', 'project.yaml'), projectText, 'utf8')

  return {
    configRoot,
    repoRoot: fixture.root,
    missionPath: join(fixture.root, '.agentic', 'missions', 'EXEMPLO-001.mission.yaml'),
    fixture,
    cleanup: async (): Promise<void> => {
      await rm(configRoot, { recursive: true, force: true })
      await fixture.cleanup().catch(() => undefined)
    },
  }
}

const PRONTO = /control plane no ar em (http:\/\/\S+)/

async function encerrar(vivos: readonly LiveCli[]): Promise<void> {
  for (const vivo of vivos) await vivo.stop().catch(() => undefined)
}

function urlDe(vivo: LiveCli): string {
  const match = PRONTO.exec(vivo.ready)
  const url = match?.[1]
  if (url === undefined) throw new Error(`nao achei o endereco em: ${vivo.ready}`)
  return url
}

describe('I14 nos entrypoints: uma chave de posse so', () => {
  it('A. `mission start` com repoRoot fora do diretorio de config nao vira um segundo dono', async () => {
    const projeto = await projetoComConfigForaDoRepo()
    const vivos: LiveCli[] = []
    try {
      // Dono legitimo, pela porta EFEMERA: nada nesta prova depende de porta ocupada.
      const dono = await spawnCli(projeto.configRoot, ['serve', '--port', '0'], PRONTO)
      vivos.push(dono)

      // O segundo processo pede uma porta DIFERENTE de proposito: com `--port` explicito a
      // CLI nem consulta a descoberta, entao o unico freio possivel e a posse do projeto.
      const segundo = await runCli(projeto.configRoot, [
        'mission',
        'start',
        projeto.missionPath,
        '--port',
        '45971',
        '--json',
      ])

      // O rastro fisico: se ele tivesse ganhado posse, teria aberto um `state.db` proprio
      // no diretorio de configuracao — dois bancos para o mesmo projeto.
      expect(await existe(join(projeto.configRoot, '.agentic', 'state.db'))).toBe(false)

      // O desfecho correto: perder a posse manda o START para o DONO, que responde que a
      // missao ainda nao esta APPROVED. Um `NOT_APPROVED` local seria a assinatura do
      // defeito — so quem abriu o proprio banco sabe dizer isso.
      const envelope = segundo.json()
      expect(envelope.error?.code).toBe('CONTROL_PLANE_REFUSED')
      expect(envelope.error?.message).toContain('APPROVED')
    } finally {
      await encerrar(vivos)
      await projeto.cleanup()
    }
  }, 180_000)

  it('B. `mission approve` sem posse nao cria run nem aprovacao por fora do dono', async () => {
    const projeto = await projetoComConfigForaDoRepo()
    const vivos: LiveCli[] = []
    try {
      const dono = await spawnCli(projeto.configRoot, ['serve', '--port', '0'], PRONTO)
      vivos.push(dono)
      const url = urlDe(dono)

      const segundo = await runCli(projeto.configRoot, [
        'mission',
        'approve',
        projeto.missionPath,
        '--actor',
        'humano@003B',
        '--port',
        '45972',
        '--json',
      ])

      // Nenhum segundo banco: `approve` nao pode abrir `state.db` sem posse.
      expect(await existe(join(projeto.configRoot, '.agentic', 'state.db'))).toBe(false)

      // O ato humano nao se perde por falta de posse: ele e ENTREGUE ao dono e acontece no
      // banco DELE — que e onde `mission start` vai procurar depois.
      const envelope = segundo.json()
      const entregue = (envelope.data as { readonly deliveredTo?: string } | undefined)?.deliveredTo
      expect(entregue).toBe(url)
      const runs = (await (await fetch(`${url}/api/runs`)).json()) as readonly {
        readonly status: string
      }[]
      expect(runs.map((run) => run.status)).toContain('APPROVED')
    } finally {
      await encerrar(vivos)
      await projeto.cleanup()
    }
  }, 180_000)

  it('C. `serve` num segundo processo, com repoRoot fora, reconhece o dono em vez de subir', async () => {
    const projeto = await projetoComConfigForaDoRepo()
    const vivos: LiveCli[] = []
    try {
      const dono = await spawnCli(projeto.configRoot, ['serve', '--port', '0'], PRONTO)
      vivos.push(dono)

      const segundo = await runCli(projeto.configRoot, ['serve', '--port', '45973', '--json'])
      const dados = segundo.json().data as { readonly reused?: boolean; readonly running: boolean }
      expect(dados.running).toBe(true)
      expect(dados.reused).toBe(true)
      expect(await existe(join(projeto.configRoot, '.agentic', 'state.db'))).toBe(false)
    } finally {
      await encerrar(vivos)
      await projeto.cleanup()
    }
  }, 180_000)

  it('D. oito processos por DOIS entrypoints, dez rodadas: um vencedor, um diretorio', async () => {
    const projeto = await projetoComConfigForaDoRepo()
    try {
      // Metade deriva a chave pelo caminho da CLI, metade pelo do servidor, sobre o mesmo
      // projeto com `repoRoot` apontando para fora. Duas falhas possiveis, as duas graves:
      // dois vencedores (as contas divergiram) e zero vencedores (ninguem sobe).
      for (let rodada = 1; rodada <= 10; rodada += 1) {
        const resultado = await raceEntrypointsForOwnership(projeto.configRoot, 8, [
          'cli',
          'server',
        ])
        expect({ rodada, vencedores: resultado.winners.length }).toEqual({
          rodada,
          vencedores: 1,
        })
        expect(resultado.losers).toHaveLength(7)
        // Um diretorio so: "um vencedor em cada diretorio" seria a mesma falha disfarcada.
        expect({ rodada, dirs: resultado.dirs }).toEqual({
          rodada,
          dirs: [join(projeto.repoRoot, '.agentic')],
        })
      }
    } finally {
      await projeto.cleanup()
    }
  }, 300_000)

  it('E. endereco descoberto que pertence a OUTRO projeto nao recebe comando de mutacao', async () => {
    const alheio = await projetoComConfigForaDoRepo()
    const nosso = await projetoComConfigForaDoRepo()
    const vivos: LiveCli[] = []
    try {
      const outro = await spawnCli(alheio.configRoot, ['serve', '--port', '0'], PRONTO)
      vivos.push(outro)
      const urlAlheia = urlDe(outro)

      // O registro de descoberta do NOSSO projeto passa a apontar para o control plane do
      // projeto ALHEIO. Acontece de verdade: `.agentic` copiado junto com o diretorio,
      // porta reaproveitada, registro velho de outro checkout.
      const registroAlheio = JSON.parse(
        await readFile(join(alheio.repoRoot, '.agentic', 'control-plane.json'), 'utf8'),
      ) as Record<string, unknown>
      await mkdir(join(nosso.repoRoot, '.agentic'), { recursive: true })
      await writeFile(
        join(nosso.repoRoot, '.agentic', 'control-plane.json'),
        JSON.stringify(registroAlheio),
        'utf8',
      )

      const aprovado = await runCli(nosso.configRoot, [
        'mission',
        'approve',
        nosso.missionPath,
        '--actor',
        'humano@003B',
        '--json',
      ])

      // O ato NAO foi entregue ao estranho: ele foi feito no proprio projeto, cujo dono
      // este comando disputou e ganhou.
      const envelope = aprovado.json()
      const dados = envelope.data as
        | { readonly deliveredTo?: string; readonly status?: string }
        | undefined
      expect(dados?.deliveredTo).toBeUndefined()
      expect(dados?.status).toBe('APPROVED')

      // E o projeto alheio continua sem run nenhum: ninguem escreveu la.
      const runsAlheios = (await (
        await fetch(`${urlAlheia}/api/runs`)
      ).json()) as readonly unknown[]
      expect(runsAlheios).toHaveLength(0)
    } finally {
      await encerrar(vivos)
      await nosso.cleanup()
      await alheio.cleanup()
    }
  }, 180_000)

  it('F. `mission approve` devolve o projeto: o `serve` seguinte vira dono', async () => {
    const projeto = await projetoComConfigForaDoRepo()
    const vivos: LiveCli[] = []
    try {
      // Sem control plane no ar, `approve` disputa a posse, muta e DEVOLVE. Se a devolucao
      // fosse so uma flag em memoria — o lock do sistema operacional continuando preso —
      // o projeto ficaria sem dono possivel ate o processo do `approve` morrer, e o
      // `serve` abaixo nao subiria.
      const aprovado = await runCli(projeto.configRoot, [
        'mission',
        'approve',
        projeto.missionPath,
        '--actor',
        'humano@003B',
        '--json',
      ])
      expect((aprovado.json().data as { readonly status?: string } | undefined)?.status).toBe(
        'APPROVED',
      )
      // O banco nasceu no diretorio que a posse protege, nao no de configuracao.
      expect(await existe(join(projeto.repoRoot, '.agentic', 'state.db'))).toBe(true)
      expect(await existe(join(projeto.configRoot, '.agentic', 'state.db'))).toBe(false)

      const dono = await spawnCli(projeto.configRoot, ['serve', '--port', '0'], PRONTO)
      vivos.push(dono)
      // E o dono enxerga a aprovacao: um banco so, no lugar certo.
      const runs = (await (await fetch(`${urlDe(dono)}/api/runs`)).json()) as readonly {
        readonly status: string
      }[]
      expect(runs.map((run) => run.status)).toEqual(['APPROVED'])
    } finally {
      await encerrar(vivos)
      await projeto.cleanup()
    }
  }, 180_000)
})
