import { badRequest } from './errors.js'

/** Parametro numerico da querystring. Valor invalido e recusado, nunca silenciado. */
export function optionalInt(raw: unknown, field: string): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw badRequest('INVALID_QUERY', `${field} deve ser inteiro nao negativo`)
  }
  return value
}
