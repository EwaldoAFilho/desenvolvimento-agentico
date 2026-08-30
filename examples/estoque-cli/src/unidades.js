/** Conversao entre caixas e unidades. Modulo base: existe antes da missao comecar. */

export const UNIDADES_POR_CAIXA = 12

export function caixasParaUnidades(caixas) {
  if (!Number.isInteger(caixas) || caixas < 0) {
    throw new TypeError('caixas deve ser inteiro nao negativo')
  }
  return caixas * UNIDADES_POR_CAIXA
}
