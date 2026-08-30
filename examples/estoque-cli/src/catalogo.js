/** Catalogo de produtos. Modulo base: existe antes da missao comecar. */

export const CATALOGO = [
  { sku: 'CAF-500', nome: 'Cafe torrado 500g', caixas: 4, precoUnidade: 21.5 },
  { sku: 'ARR-1KG', nome: 'Arroz agulhinha 1kg', caixas: 9, precoUnidade: 7.9 },
  { sku: 'ACU-1KG', nome: 'Acucar refinado 1kg', caixas: 2, precoUnidade: 4.4 },
]

export function buscarPorSku(sku) {
  return CATALOGO.find((item) => item.sku === sku)
}
