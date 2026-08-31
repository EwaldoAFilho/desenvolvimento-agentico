import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_WEB_DIST, productWebDist } from './config.js'

/**
 * Regressao de um defeito encontrado ao SUBIR a plataforma para uso real, nao por teste.
 *
 * `webDist` era resolvido contra o repoRoot do projeto ORQUESTRADO. Quem roda `agentic` no
 * proprio repositorio — o caso normal de uso diario — recebia a pagina
 * "Dashboard nao compilado. Rode `npm run build -w @agentic/web`", mesmo com o build
 * existindo: a mensagem apontava para uma solucao que nao resolveria nada.
 */
describe('resolucao do dashboard (defeito de uso diario)', () => {
  it('encontra o dashboard da instalacao do produto, independente do alvo', () => {
    const found = productWebDist()
    expect(found).toBeDefined()
    expect(existsSync(join(found as string, 'index.html'))).toBe(true)
  })

  it('o caminho encontrado nao depende do diretorio de trabalho', async () => {
    const antes = productWebDist()
    const outro = await mkdtemp(join(tmpdir(), 'agentic-cwd-'))
    const original = process.cwd()
    try {
      process.chdir(outro)
      expect(productWebDist()).toBe(antes)
    } finally {
      process.chdir(original)
    }
  })

  it('CONTROLE: um projeto alvo qualquer nao tem apps/web/dist proprio', async () => {
    const alvo = await mkdtemp(join(tmpdir(), 'agentic-alvo-'))
    await mkdir(join(alvo, '.agentic'), { recursive: true })
    await writeFile(join(alvo, '.agentic', 'marker'), 'x')
    // E exatamente por isso que resolver contra o alvo quebrava: o caminho nao existe la.
    expect(existsSync(join(alvo, DEFAULT_WEB_DIST, 'index.html'))).toBe(false)
    // ...e mesmo assim o produto sabe onde o seu dashboard esta.
    expect(productWebDist()).toBeDefined()
  })
})
