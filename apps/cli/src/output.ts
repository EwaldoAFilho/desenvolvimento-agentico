import type { Tristate } from '@agentic/schemas'
import type { CommandDeps } from './deps.js'
import type { CommandResult } from './result.js'

/**
 * Saida humana e saida `--json` nao se misturam: com `--json` o stdout carrega UM
 * documento, o envelope estavel do comando.
 */
export interface Output {
  readonly json: boolean
  line(text?: string): void
  lines(values: readonly string[]): void
  warn(text: string): void
}

export function createOutput(deps: CommandDeps, json: boolean): Output {
  return {
    json,
    line: (text = '') => {
      if (!json) deps.stdout(`${text}\n`)
    },
    lines: (values) => {
      if (json) return
      for (const value of values) deps.stdout(`${value}\n`)
    },
    warn: (text) => {
      if (!json) deps.stderr(`${text}\n`)
    },
  }
}

/** Envelope do `--json`. Mesma forma para todo comando, com ou sem falha. */
export interface JsonEnvelope {
  readonly ok: boolean
  readonly command: string
  readonly data?: unknown
  readonly error?: { readonly code: string; readonly message: string }
}

export function envelopeOf(result: CommandResult): JsonEnvelope {
  return {
    ok: result.exitCode === 0,
    command: result.command,
    ...(result.data === undefined ? {} : { data: result.data }),
    ...(result.error === undefined ? {} : { error: result.error }),
  }
}

/** Emite o envelope quando `--json`; a mensagem de erro humana vai para stderr. */
export function emit(deps: CommandDeps, result: CommandResult, json: boolean): void {
  if (json) {
    deps.stdout(`${JSON.stringify(envelopeOf(result), null, 2)}\n`)
    return
  }
  if (result.error !== undefined)
    deps.stderr(`erro [${result.error.code}]: ${result.error.message}\n`)
}

/**
 * `unknown` e valor de primeira classe (DASHBOARD 5.1): nao vira `sim`, nao vira `ok` e
 * nao vira verde. Uma CLI que responde `--version` NAO prova autenticacao.
 */
export function tristate(value: Tristate): string {
  if (value === 'unknown') return 'unknown'
  return value ? 'sim' : 'nao'
}

export function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length)
}

/** Tabela de largura fixa por coluna; sem cor, sem simbolo que afirme mais do que sabemos. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = headers.map((header, index) =>
    rows.reduce((max, row) => Math.max(max, (row[index] ?? '').length), header.length),
  )
  const render = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => pad(cell, widths[index] ?? cell.length))
      .join('  ')
      .trimEnd()
  return [render(headers), ...rows.map(render)]
}

export function duration(ms: number | undefined): string {
  if (ms === undefined) return '-'
  if (ms < 1_000) return `${ms}ms`
  const seconds = ms / 1_000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${Math.round(seconds - minutes * 60)}s`
}
