/**
 * Formato exato de `Date.prototype.toISOString`. O reviver so aceita este formato para nao
 * transformar uma string qualquer do dominio em Date por acidente.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? null)
}

export function parseJson<T>(text: string): T {
  return JSON.parse(text) as T
}

/**
 * Usado apenas nas colunas que carregam Date aninhada (identidade de agente, bloqueio e
 * payload de evento). As demais colunas usam `parseJson`, sem heuristica.
 */
export function parseJsonWithDates<T>(text: string): T {
  return JSON.parse(text, (_key, value: unknown) =>
    typeof value === 'string' && ISO_INSTANT.test(value) ? new Date(value) : value,
  ) as T
}

export function encodeOptionalJson(value: unknown): string | null {
  return value === undefined || value === null ? null : encodeJson(value)
}

export function parseOptionalJson<T>(text: string | null): T | undefined {
  return text === null ? undefined : parseJson<T>(text)
}

export function parseOptionalJsonWithDates<T>(text: string | null): T | undefined {
  return text === null ? undefined : parseJsonWithDates<T>(text)
}

export function toIso(value: Date | undefined): string | null {
  return value === undefined ? null : value.toISOString()
}

export function fromIso(value: string | null): Date | undefined {
  return value === null ? undefined : new Date(value)
}

/** Remove chaves `undefined` para que o round-trip case por igualdade estrita. */
export function compact<T extends object>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item
  }
  return out as T
}
