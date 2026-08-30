/**
 * Normalizacao de texto livre. Modulo base: existe antes da missao comecar.
 *
 * Estas duas funcoes nao podem falhar, entao nao devolvem `Resultado`: entrada que nao
 * e string vira string vazia. Toda analise deste projeto normaliza a entrada ANTES de
 * olhar a forma — e por isso que `  2H 15M ` e `2h15m` sao a mesma coisa.
 */

export function normalizar(valor) {
  if (typeof valor !== 'string') return ''
  return valor.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** `normalizar` e ainda sem nenhum espaco interno. */
export function semEspacos(valor) {
  return normalizar(valor).replaceAll(' ', '')
}
