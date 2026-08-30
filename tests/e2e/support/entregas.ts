/**
 * O que cada agente de mentira ESCREVE na worktree da tentativa.
 *
 * Codigo real: cada arquivo aqui e importado pela suite do fixture (`node tests/run.js`),
 * que e o comando do gate. Nenhuma task e aprovada por dizer que fez — o gate roda o
 * codigo entregue e o control plane mede o diff.
 */

const UNIDADES = `/** Conversao entre caixas e unidades. */

export const UNIDADES_POR_CAIXA = 12

export function caixasParaUnidades(caixas) {
  if (!Number.isInteger(caixas) || caixas < 0) {
    throw new TypeError('caixas deve ser inteiro nao negativo')
  }
  return caixas * UNIDADES_POR_CAIXA
}

export function unidadesParaCaixas(unidades) {
  if (!Number.isInteger(unidades) || unidades < 0) {
    throw new TypeError('unidades deve ser inteiro nao negativo')
  }
  return Math.ceil(unidades / UNIDADES_POR_CAIXA)
}
`

const CATALOGO = `/** Catalogo de produtos. */

export const CATALOGO = [
  { sku: 'CAF-500', nome: 'Cafe torrado 500g', caixas: 4, precoUnidade: 21.5 },
  { sku: 'ARR-1KG', nome: 'Arroz agulhinha 1kg', caixas: 9, precoUnidade: 7.9 },
  { sku: 'ACU-1KG', nome: 'Acucar refinado 1kg', caixas: 2, precoUnidade: 4.4 },
]

export function buscarPorSku(sku) {
  return CATALOGO.find((item) => item.sku === sku)
}

export function skus() {
  return CATALOGO.map((item) => item.sku)
}
`

const INVENTARIO = `import { caixasParaUnidades } from './unidades.js'

export function unidadesDoItem(item) {
  return caixasParaUnidades(item.caixas)
}

export function unidadesEmEstoque(itens) {
  return itens.reduce((total, item) => total + unidadesDoItem(item), 0)
}
`

const PRECOS = `import { buscarPorSku } from './catalogo.js'

export function totalDoPedido(pedido) {
  return pedido.reduce((total, linha) => {
    const item = buscarPorSku(linha.sku)
    if (item === undefined) {
      throw new RangeError('sku desconhecido no pedido: ' + linha.sku)
    }
    return total + item.precoUnidade * linha.quantidade
  }, 0)
}
`

const REPOSICAO = `import { unidadesDoItem } from './inventario.js'

export const PONTO_DE_PEDIDO = 36

export function precisaRepor(item, pontoDePedido = PONTO_DE_PEDIDO) {
  return unidadesDoItem(item) < pontoDePedido
}

export function itensParaRepor(itens, pontoDePedido = PONTO_DE_PEDIDO) {
  return itens.filter((item) => precisaRepor(item, pontoDePedido)).map((item) => item.sku)
}
`

const RELATORIO = `import { CATALOGO } from './catalogo.js'
import { unidadesDoItem } from './inventario.js'
import { totalDoPedido } from './precos.js'

export const CABECALHO = 'sku | unidades | valor'

export function linhaDoItem(item) {
  const unidades = unidadesDoItem(item)
  const valor = totalDoPedido([{ sku: item.sku, quantidade: unidades }])
  return item.sku + ' | ' + unidades + ' | ' + valor.toFixed(2)
}

export function relatorio(itens = CATALOGO) {
  return [CABECALHO, ...itens.map(linhaDoItem)].join('\\n')
}
`

const CLI = `import { CATALOGO } from './catalogo.js'
import { relatorio } from './relatorio.js'
import { itensParaRepor } from './reposicao.js'

export function main(argv, itens = CATALOGO) {
  const comando = argv[0]
  if (comando === 'relatorio') return relatorio(itens)
  if (comando === 'reposicao') return itensParaRepor(itens).join('\\n')
  throw new RangeError('comando desconhecido: ' + String(comando))
}
`

const CASOS = `import assert from 'node:assert/strict'
import { skus } from '../src/catalogo.js'
import { main } from '../src/cli.js'
import { unidadesEmEstoque } from '../src/inventario.js'
import { totalDoPedido } from '../src/precos.js'
import { itensParaRepor } from '../src/reposicao.js'
import { unidadesParaCaixas } from '../src/unidades.js'

const ITENS = [
  { sku: 'CAF-500', caixas: 4 },
  { sku: 'ACU-1KG', caixas: 2 },
]

export const casos = [
  {
    nome: 'unidades para caixas arredonda para cima',
    executar: () => {
      assert.equal(unidadesParaCaixas(13), 2)
      assert.equal(unidadesParaCaixas(0), 0)
    },
  },
  {
    nome: 'catalogo expoe um sku por item',
    executar: () => {
      assert.equal(skus().length, 3)
    },
  },
  {
    nome: 'inventario soma as unidades',
    executar: () => {
      assert.equal(unidadesEmEstoque(ITENS), 72)
      assert.equal(unidadesEmEstoque([]), 0)
    },
  },
  {
    nome: 'preco recusa sku desconhecido',
    executar: () => {
      assert.equal(totalDoPedido([{ sku: 'ACU-1KG', quantidade: 2 }]), 8.8)
      assert.throws(() => totalDoPedido([{ sku: 'XXX', quantidade: 1 }]), RangeError)
    },
  },
  {
    nome: 'reposicao lista o que esta abaixo do ponto de pedido',
    executar: () => {
      assert.deepEqual(itensParaRepor(ITENS), ['ACU-1KG'])
    },
  },
  {
    nome: 'cli atende os dois subcomandos e recusa o resto',
    executar: () => {
      assert.ok(main(['relatorio'], ITENS).startsWith('sku | unidades | valor'))
      assert.equal(main(['reposicao'], ITENS), 'ACU-1KG')
      assert.throws(() => main(['inventar'], ITENS), RangeError)
    },
  },
]
`

const USAGE = `# Uso do estoque-cli

O ponto de entrada e \`main(argv)\` em \`src/cli.js\`. Ele devolve texto e nao imprime nada:
quem decide o que fazer com a saida e quem chama.

## Subcomandos

| Comando | O que devolve |
| --- | --- |
| \`relatorio\` | uma linha por item, com sku, unidades em estoque e valor |
| \`reposicao\` | os skus abaixo do ponto de pedido, um por linha |

Comando desconhecido levanta \`RangeError\`.

## Exemplo

    import { main } from './src/cli.js'

    console.log(main(['relatorio']))
    console.log(main(['reposicao']))
`

/** Arquivos entregues por task, relativos a raiz da worktree. */
export const ENTREGAS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  T01: { 'src/unidades.js': UNIDADES },
  T02: { 'src/catalogo.js': CATALOGO },
  T03: { 'src/inventario.js': INVENTARIO },
  T04: { 'src/precos.js': PRECOS },
  T05: { 'src/reposicao.js': REPOSICAO },
  T06: { 'src/relatorio.js': RELATORIO },
  T07: { 'src/cli.js': CLI },
  T08: { 'docs/USAGE.md': USAGE, 'tests/casos.js': CASOS },
}

export const TASK_IDS: readonly string[] = Object.keys(ENTREGAS)

/** Entrega quebrada: o arquivo existe, nao compila, e o gate reprova de verdade. */
export function entregaQuebrada(taskId: string): Readonly<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const path of Object.keys(ENTREGAS[taskId] ?? {})) {
    files[path] = path.endsWith('.js')
      ? 'export function quebrado( {\n  return 1\n}\n'
      : '# rascunho incompleto\n'
  }
  return files
}
