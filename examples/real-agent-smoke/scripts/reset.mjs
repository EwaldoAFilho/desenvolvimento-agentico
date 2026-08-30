/**
 * Devolve o fixture ao estado inicial: `src/` fica com exatamente os tres modulos base.
 *
 *   node scripts/reset.mjs
 *
 * Idempotente e deterministico — rodar duas vezes da o mesmo resultado. Remove o que a
 * missao entrega (`duracao.js`, `intervalo.js`, `agenda.js`) e tambem qualquer arquivo
 * que um agente tenha deixado em `src/`.
 *
 * O estado do control plane (`.agentic/state.db`, `.agentic/runs/`, worktrees) NAO e
 * tocado aqui de proposito: some junto com a copia do projeto (ver README).
 */
import { readdir, rm } from 'node:fs/promises'
import process from 'node:process'

const SRC = new URL('../src/', import.meta.url)

/** Estado inicial de `src/`. Tudo que nao esta aqui e produto de uma missao. */
const BASE = new Set(['resultado.js', 'texto.js', 'horario.js'])

async function main() {
  const nomes = (await readdir(SRC)).sort()
  const removidos = []
  for (const nome of nomes) {
    if (BASE.has(nome)) continue
    await rm(new URL(nome, SRC), { recursive: true, force: true })
    removidos.push(nome)
  }

  const faltando = [...BASE].filter((nome) => !nomes.includes(nome)).sort()
  if (faltando.length > 0) {
    console.error(`modulo base ausente: ${faltando.join(' ')} — restaure pelo git`)
    return 1
  }

  console.log(
    removidos.length === 0
      ? 'reset: nada a remover, o fixture ja esta no estado inicial'
      : `reset: removido(s) ${removidos.map((nome) => `src/${nome}`).join(' ')}`,
  )
  return 0
}

main()
  .then((codigo) => {
    process.exitCode = codigo
  })
  .catch((erro) => {
    console.error(erro instanceof Error ? erro.message : String(erro))
    process.exitCode = 1
  })
