/**
 * Suite do estoque-cli. Sem dependencia externa e sem rede: `node tests/run.js`.
 *
 * E exatamente o comando do gate `unit` declarado em .agentic/gates.yaml. Quem decide se
 * uma tentativa passou e este processo — nunca o relato do agente.
 */
import assert from 'node:assert/strict'
import { readdir, stat } from 'node:fs/promises'
import process from 'node:process'

const SRC = new URL('../src/', import.meta.url)
const CASOS = new URL('./casos.js', import.meta.url)

async function existe(url) {
  try {
    await stat(url)
    return true
  } catch {
    return false
  }
}

/** Carrega todo modulo de src/: arquivo novo entra na suite sem editar este arquivo. */
async function carregarModulos() {
  const arquivos = (await readdir(SRC)).filter((nome) => nome.endsWith('.js')).sort()
  const modulos = new Map()
  for (const arquivo of arquivos) {
    const modulo = await import(new URL(arquivo, SRC).href)
    assert.ok(Object.keys(modulo).length > 0, `src/${arquivo} nao exporta nada`)
    modulos.set(arquivo, modulo)
  }
  return modulos
}

async function main() {
  const modulos = await carregarModulos()
  const verificacoes = []

  const unidades = modulos.get('unidades.js')
  assert.ok(unidades !== undefined, 'src/unidades.js e obrigatorio')
  assert.equal(unidades.caixasParaUnidades(3), 3 * unidades.UNIDADES_POR_CAIXA)
  assert.throws(() => unidades.caixasParaUnidades(-1))
  verificacoes.push('unidades')

  const catalogo = modulos.get('catalogo.js')
  assert.ok(catalogo !== undefined, 'src/catalogo.js e obrigatorio')
  assert.ok(catalogo.CATALOGO.length >= 3, 'o catalogo base tem ao menos tres itens')
  assert.equal(catalogo.buscarPorSku('CAF-500').sku, 'CAF-500')
  assert.equal(catalogo.buscarPorSku('NAO-EXISTE'), undefined)
  verificacoes.push('catalogo')

  if (await existe(CASOS)) {
    const { casos } = await import(CASOS.href)
    assert.ok(Array.isArray(casos), 'tests/casos.js precisa exportar `casos`')
    for (const caso of casos) {
      await caso.executar()
      verificacoes.push(caso.nome)
    }
  }

  console.log(`ok ${verificacoes.length} verificacoes em ${modulos.size} modulos`)
}

main().catch((erro) => {
  console.error(erro instanceof Error ? erro.message : String(erro))
  process.exit(1)
})
