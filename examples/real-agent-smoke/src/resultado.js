/**
 * Convencao de retorno deste projeto. Modulo base: existe antes da missao comecar.
 *
 * Nenhuma funcao publica lanca por causa da ENTRADA. O que pode falhar devolve um
 * `Resultado` e quem chama decide o que fazer:
 *
 *   { ok: true,  valor }
 *   { ok: false, codigo, mensagem }
 *
 * `codigo` e a parte estavel — a suite compara codigo, nunca mensagem. Codigo fora de
 * `CODIGOS` e erro de PROGRAMACAO, nao de entrada, e por isso `falha` lanca nesse caso.
 */

export const CODIGOS = Object.freeze({
  /** Entrada ausente, nao textual ou apenas espacos. */
  VAZIO: 'VAZIO',
  /** Ha texto, mas a forma nao e a esperada. */
  FORMATO: 'FORMATO',
  /** A forma esta certa e o numero esta fora da faixa permitida. */
  FAIXA: 'FAIXA',
  /** Os valores sao validos isoladamente e a ordem entre eles nao e. */
  ORDEM: 'ORDEM',
})

export function ok(valor) {
  return { ok: true, valor }
}

export function falha(codigo, mensagem) {
  if (!Object.hasOwn(CODIGOS, codigo)) {
    throw new TypeError(`codigo de falha desconhecido: ${String(codigo)}`)
  }
  return { ok: false, codigo, mensagem }
}

/**
 * Repassa a falha recebida PRESERVANDO o codigo e acrescentando contexto a mensagem.
 * Quem compoe duas analises usa isto: o codigo que o chamador ve e o da causa raiz.
 */
export function propagar(resultado, contexto) {
  return falha(resultado.codigo, `${contexto}: ${resultado.mensagem}`)
}
