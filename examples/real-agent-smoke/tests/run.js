/**
 * Suite do real-agent-smoke. Sem dependencia externa, sem rede, sem relogio: roda em
 * menos de um segundo e da sempre o mesmo resultado.
 *
 *   node tests/run.js                 modulo ainda nao entregue fica PENDENTE (sai 0)
 *   node tests/run.js --exigir-tudo   pendencia REPROVA (sai 4) — e o gate `mission`
 *
 * Cada arquivo de `tests/specs/` declara `alvo` (o modulo de `src/` que verifica) e
 * `casos(modulo)`. Quem decide se uma tentativa passou e este processo — nunca o relato
 * do agente.
 */
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import process from 'node:process'

const RAIZ = new URL('../', import.meta.url)
const SRC = new URL('src/', RAIZ)
const SPECS = new URL('specs/', import.meta.url)

const EXIT_FALHA = 1
const EXIT_PENDENTE = 4

async function listar(diretorio, sufixo) {
  const nomes = await readdir(diretorio)
  return nomes.filter((nome) => nome.endsWith(sufixo)).sort()
}

/** O projeto e de biblioteca padrao. Dependencia nova reprova antes de qualquer caso. */
async function conferirProjeto() {
  const texto = await readFile(new URL('package.json', RAIZ), 'utf8')
  const pacote = JSON.parse(texto)
  assert.equal(pacote.dependencies, undefined, 'package.json nao pode declarar dependencies')
  assert.equal(pacote.devDependencies, undefined, 'package.json nao pode declarar devDependencies')
}

/** Carrega todo modulo de `src/`: arquivo novo entra na suite sem editar este arquivo. */
async function carregarModulos() {
  const modulos = new Map()
  for (const arquivo of await listar(SRC, '.js')) {
    const modulo = await import(new URL(arquivo, SRC).href)
    assert.ok(Object.keys(modulo).length > 0, `src/${arquivo} nao exporta nada`)
    modulos.set(arquivo, modulo)
  }
  return modulos
}

async function main(argv) {
  const exigirTudo = argv.includes('--exigir-tudo')

  await conferirProjeto()
  const modulos = await carregarModulos()

  let executados = 0
  const pendentes = []

  for (const arquivo of await listar(SPECS, '.spec.js')) {
    const spec = await import(new URL(arquivo, SPECS).href)
    assert.ok(typeof spec.alvo === 'string', `tests/specs/${arquivo} precisa exportar \`alvo\``)
    assert.ok(typeof spec.casos === 'function', `tests/specs/${arquivo} precisa exportar \`casos\``)

    const modulo = modulos.get(spec.alvo)
    if (modulo === undefined) {
      // Modulo BASE ausente nao e pendencia: e o alicerce sumindo. Sem esta linha, apagar
      // src/horario.js deixaria o gate `unit` VERDE — pendencia so vale para o que a missao
      // ainda nao entregou.
      assert.ok(spec.base !== true, `src/${spec.alvo} e modulo base e sumiu de src/`)
      pendentes.push(spec.alvo)
      continue
    }
    for (const caso of spec.casos(modulo)) {
      try {
        await caso.executar()
      } catch (erro) {
        const motivo = erro instanceof Error ? erro.message : String(erro)
        throw new Error(`${spec.alvo} · ${caso.nome}\n  ${motivo}`)
      }
      executados += 1
    }
  }

  const resumo = `${executados} casos em ${modulos.size} modulos`
  if (pendentes.length === 0) {
    console.log(`ok ${resumo}`)
    return 0
  }
  const lista = pendentes.join(' ')
  if (exigirTudo) {
    console.error(`pendente ${pendentes.length} modulo(s) nao entregue(s): ${lista}`)
    return EXIT_PENDENTE
  }
  console.log(`ok ${resumo} · pendente: ${lista}`)
  return 0
}

main(process.argv.slice(2))
  .then((codigo) => {
    process.exitCode = codigo
  })
  .catch((erro) => {
    console.error(`FALHOU ${erro instanceof Error ? erro.message : String(erro)}`)
    process.exitCode = EXIT_FALHA
  })
