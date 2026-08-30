import { GateError } from './errors.js'

/**
 * Operadores de shell recusados fora de aspas. O gate roda o processo direto (sem shell),
 * entao aceitar `|`, `>` ou `$VAR` como argumento literal daria um resultado DIFERENTE do
 * que o humano obtem colando a mesma linha no terminal — o oposto de P08. Quem precisa de
 * shell declara o shell: `sh -c 'a && b'` passa, porque ai a linha colada faz o mesmo.
 */
const SHELL_OPERATORS = new Set(['|', '&', ';', '<', '>', '`', '$', '(', ')'])

/** Dentro de aspas duplas o shell so trata estes como escape. */
const DOUBLE_QUOTE_ESCAPES = new Set(['"', '\\', '$', '`'])

function syntaxError(line: string, detail: string): GateError {
  return new GateError('GATE_COMMAND_SYNTAX', `comando de gate invalido: ${detail}`, line)
}

/**
 * Quebra a linha do `gates.yaml` em argv com as mesmas regras de aspas do shell POSIX,
 * sem expansao. `argv[0]` e o executavel.
 */
export function tokenizeCommandLine(line: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let index = 0

  const flush = (): void => {
    if (!started) return
    tokens.push(current)
    current = ''
    started = false
  }

  while (index < line.length) {
    const char = line[index] as string

    if (char === '\n' || char === '\r') {
      throw syntaxError(line, 'quebra de linha nao e permitida')
    }

    if (char === ' ' || char === '\t') {
      flush()
      index += 1
      continue
    }

    if (char === "'") {
      const end = line.indexOf("'", index + 1)
      if (end === -1) throw syntaxError(line, 'aspas simples nao fechadas')
      current += line.slice(index + 1, end)
      started = true
      index = end + 1
      continue
    }

    if (char === '"') {
      index += 1
      let closed = false
      while (index < line.length) {
        const inner = line[index] as string
        if (inner === '\\') {
          const next = line[index + 1]
          if (next !== undefined && DOUBLE_QUOTE_ESCAPES.has(next)) {
            current += next
            index += 2
            continue
          }
          current += inner
          index += 1
          continue
        }
        if (inner === '"') {
          closed = true
          index += 1
          break
        }
        if (inner === '$' || inner === '`') {
          throw syntaxError(line, `expansao "${inner}" dentro de aspas duplas nao e reproduzivel`)
        }
        current += inner
        index += 1
      }
      if (!closed) throw syntaxError(line, 'aspas duplas nao fechadas')
      started = true
      continue
    }

    if (char === '\\') {
      const next = line[index + 1]
      if (next === undefined) throw syntaxError(line, 'barra invertida no fim da linha')
      current += next
      started = true
      index += 2
      continue
    }

    if (SHELL_OPERATORS.has(char)) {
      throw syntaxError(line, `operador de shell "${char}" fora de aspas; use sh -c '...'`)
    }

    current += char
    started = true
    index += 1
  }

  flush()
  if (tokens.length === 0) throw syntaxError(line, 'linha vazia')
  return tokens
}
