import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { gitRepoObserver } from './control-plane.js'

const exec = promisify(execFile)
let raiz: string | undefined

afterEach(async () => {
  if (raiz !== undefined) await rm(raiz, { recursive: true, force: true })
  raiz = undefined
})

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentic-fp-'))
  const git = (...args: string[]) => exec('git', args, { cwd: dir })
  await git('init', '-q', '-b', 'main')
  await git('config', 'user.email', 't@t.invalid')
  await git('config', 'user.name', 'Teste')
  await writeFile(join(dir, 'a.ts'), 'export const a = 1\n', 'utf8')
  await git('add', '-A')
  await git('commit', '--no-verify', '-m', 'base')
  return dir
}

/**
 * Regressao do achado que bloqueou U06: `git status` diz NOME e ESTADO, nunca conteudo.
 * Reescrever um arquivo que ja estava sujo mantem a mesma linha de status, entao uma
 * impressao digital feita so de HEAD + status nao detectaria a alteracao — e a garantia de
 * que planejar nao mexeu no repositorio valeria zero exatamente onde ha trabalho em curso.
 */
describe('impressao digital do repositorio', () => {
  it('muda quando arquivo JA modificado e reescrito, apesar do status identico', async () => {
    raiz = await repo()
    await writeFile(join(raiz, 'a.ts'), 'export const a = 2\n', 'utf8')
    const observer = gitRepoObserver(raiz)
    const antes = await observer.fingerprint()

    await writeFile(join(raiz, 'a.ts'), 'export const a = 999\n', 'utf8')
    const depois = await observer.fingerprint()

    expect(antes).toBeDefined()
    expect(depois).not.toBe(antes)
  })

  it('muda quando arquivo NAO rastreado e reescrito, apesar do status identico', async () => {
    raiz = await repo()
    await writeFile(join(raiz, 'novo.ts'), 'export const n = 1\n', 'utf8')
    const observer = gitRepoObserver(raiz)
    const antes = await observer.fingerprint()

    await writeFile(join(raiz, 'novo.ts'), 'export const n = 2\n', 'utf8')
    const depois = await observer.fingerprint()

    expect(depois).not.toBe(antes)
  })

  it('nao muda quando nada e tocado', async () => {
    raiz = await repo()
    await writeFile(join(raiz, 'sujo.ts'), 'x\n', 'utf8')
    const observer = gitRepoObserver(raiz)
    expect(await observer.fingerprint()).toBe(await observer.fingerprint())
  })

  it('muitos arquivos nao rastreados nao estouram a linha de comando', async () => {
    raiz = await repo()
    const total = 900
    await Promise.all(
      Array.from({ length: total }, (_unused, i) =>
        writeFile(join(raiz as string, `f${i}.txt`), `conteudo ${i}\n`, 'utf8'),
      ),
    )
    const observer = gitRepoObserver(raiz)
    const antes = await observer.fingerprint()
    // ARG_MAX nao pode transformar repositorio valido em "nao observado".
    expect(antes).toBeDefined()

    await writeFile(join(raiz, 'f500.txt'), 'reescrito\n', 'utf8')
    expect(await observer.fingerprint()).not.toBe(antes)
  })

  it('caminhos LONGOS tambem sao loteados: o teto de argv e de bytes, nao de contagem', async () => {
    raiz = await repo()
    const nome = 'n'.repeat(180)
    await Promise.all(
      Array.from({ length: 400 }, (_unused, i) =>
        writeFile(join(raiz as string, `${nome}-${i}.txt`), `c${i}\n`, 'utf8'),
      ),
    )
    const observer = gitRepoObserver(raiz)
    const antes = await observer.fingerprint()
    expect(antes).toBeDefined()

    await writeFile(join(raiz, `${nome}-200.txt`), 'reescrito\n', 'utf8')
    expect(await observer.fingerprint()).not.toBe(antes)
  })

  it('nome que --stdin-paths leria como outro caminho faz a observacao RECUSAR', async () => {
    raiz = await repo()
    // Linha iniciada por aspas e lida como C-quoted; o git hashearia outro arquivo e ainda
    // sairia 0 com a contagem certa. Recusar e o unico resultado honesto.
    await writeFile(join(raiz, '"aspas.txt'), 'x\n', 'utf8')
    expect(await gitRepoObserver(raiz).fingerprint()).toBeUndefined()
  })

  it('nome POSIX com bytes invalidos faz RECUSAR mesmo SEM colisao', async () => {
    raiz = await repo()
    const so = Buffer.concat([
      Buffer.from(`${raiz as string}/`, 'utf8'),
      Buffer.from([0x7a, 0xff, 0x2e, 0x74, 0x78, 0x74]),
    ])
    await writeFile(so, 'z\n')
    // Nao ha arquivo U+FFFD para colidir; ainda assim a string nao representa o disco.
    expect(await gitRepoObserver(raiz).fingerprint()).toBeUndefined()
  })

  it('nome POSIX com bytes invalidos que colide apos decodificar faz RECUSAR', async () => {
    raiz = await repo()
    // O primeiro nome tem byte 0xFF, invalido em UTF-8: o wrapper o decodifica como U+FFFD,
    // exatamente o nome do segundo. Sem a deteccao de colisao, o git hashearia o segundo
    // duas vezes e uma alteracao no primeiro ficaria invisivel.
    // `join` exige string; o caminho com byte invalido e montado como Buffer.
    const invalido = Buffer.concat([
      Buffer.from(`${raiz as string}/`, 'utf8'),
      Buffer.from([0x62, 0xff, 0x2e, 0x74, 0x78, 0x74]),
    ])
    await writeFile(invalido, 'a\n')
    await writeFile(join(raiz, 'b\uFFFD.txt'), 'b\n', 'utf8')
    expect(await gitRepoObserver(raiz).fingerprint()).toBeUndefined()
  })

  it('observar nao altera o que observa: o indice fica intacto', async () => {
    raiz = await repo()
    await writeFile(join(raiz, 'novo.ts'), 'x\n', 'utf8')
    await gitRepoObserver(raiz).fingerprint()
    const { stdout } = await exec('git', ['status', '--porcelain'], { cwd: raiz })
    expect(stdout).toContain('?? novo.ts')
  })
})

/**
 * Contra-prova de um achado da revisao. A alegacao era que arquivo RASTREADO e limpo escapa
 * da guarda de U+FFFD e deixa alteracao invisivel. Nao escapa: conteudo rastreado entra pelo
 * patch de `git diff HEAD`, e arquivo limpo nao tem alteracao para esconder.
 */
describe('arquivo rastreado com nome estranho', () => {
  it('alteracao em arquivo rastreado de nome invalido MUDA a impressao digital', async () => {
    raiz = await repo()
    const caminho = Buffer.concat([
      Buffer.from(`${raiz as string}/`, 'utf8'),
      Buffer.from([0x74, 0xff, 0x2e, 0x74, 0x78, 0x74]),
    ])
    await writeFile(caminho, 'antes\n')
    await exec('git', ['add', '-A'], { cwd: raiz })
    await exec('git', ['commit', '--no-verify', '-m', 'nome estranho rastreado'], { cwd: raiz })

    const observer = gitRepoObserver(raiz)
    const antes = await observer.fingerprint()
    // Rastreado e limpo: a observacao e possivel, nao ha nada a esconder.
    expect(antes).toBeDefined()

    await writeFile(caminho, 'depois\n')
    const depois = await observer.fingerprint()
    expect(depois).not.toBe(antes)
  })
})

/**
 * Cenario trazido pelo revisor: `assume-unchanged` faz o git ignorar alteracao no arquivo,
 * esvaziando status e diff. Sem observar os bits do indice, a alteracao ficaria invisivel.
 */
describe('bits do indice que escondem alteracao', () => {
  it('ligar assume-unchanged e alterar o arquivo MUDA a impressao digital', async () => {
    raiz = await repo()
    const observer = gitRepoObserver(raiz)
    const antes = await observer.fingerprint()

    await exec('git', ['update-index', '--assume-unchanged', 'a.ts'], { cwd: raiz })
    await writeFile(join(raiz, 'a.ts'), 'export const a = 42\n', 'utf8')

    const { stdout } = await exec('git', ['status', '--porcelain'], { cwd: raiz })
    // Prova de que o cenario e real: para o git, nada mudou.
    expect(stdout.trim()).toBe('')
    expect(await observer.fingerprint()).not.toBe(antes)
  })

  it('bit ligado ANTES da primeira leitura faz a observacao RECUSAR', async () => {
    // Incluir o bit na digital nao basta: se ele ja estava ligado, as duas leituras nascem
    // iguais e a alteracao no meio fica invisivel. Com o bit ligado nao ha o que observar.
    raiz = await repo()
    await exec('git', ['update-index', '--assume-unchanged', 'a.ts'], { cwd: raiz })
    const observer = gitRepoObserver(raiz)
    expect(await observer.fingerprint()).toBeUndefined()

    await writeFile(join(raiz, 'a.ts'), 'export const a = 7\n', 'utf8')
    expect(await observer.fingerprint()).toBeUndefined()
  })
})
