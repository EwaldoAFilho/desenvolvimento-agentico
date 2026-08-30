import { describe, expect, it } from 'vitest'
import { isGateError } from './errors.js'
import { tokenizeCommandLine } from './tokenize.js'

function codeOf(line: string): string {
  try {
    tokenizeCommandLine(line)
  } catch (error) {
    return isGateError(error) ? error.code : 'NAO_E_GATE_ERROR'
  }
  return 'NAO_LANCOU'
}

describe('tokenizeCommandLine', () => {
  it('quebra a linha em argv preservando a ordem', () => {
    expect(tokenizeCommandLine('npm run lint -w @agentic/web')).toEqual([
      'npm',
      'run',
      'lint',
      '-w',
      '@agentic/web',
    ])
  })

  it('colapsa espacos e tabs repetidos', () => {
    expect(tokenizeCommandLine('  npm \t  run   test  ')).toEqual(['npm', 'run', 'test'])
  })

  it('aspas simples mantem o conteudo literal', () => {
    expect(tokenizeCommandLine("find . -name '*.ts | x'")).toEqual([
      'find',
      '.',
      '-name',
      '*.ts | x',
    ])
  })

  it('aspas duplas viram um argumento so', () => {
    expect(tokenizeCommandLine('node -e "console.log(\'oi\')"')).toEqual([
      'node',
      '-e',
      "console.log('oi')",
    ])
  })

  it('barra invertida escapa o proximo caractere fora de aspas', () => {
    expect(tokenizeCommandLine('cmd a\\ b')).toEqual(['cmd', 'a b'])
  })

  it('mantem a barra invertida que nao e escape de shell dentro de aspas duplas', () => {
    expect(tokenizeCommandLine('node -e "write(\'a\\nb\')"')).toEqual([
      'node',
      '-e',
      "write('a\\nb')",
    ])
  })

  it.each(['|', '&', ';', '<', '>', '`', '$', '(', ')'])(
    'recusa o operador de shell %s fora de aspas',
    (operator) => {
      expect(codeOf(`npm test ${operator} outro`)).toBe('GATE_COMMAND_SYNTAX')
    },
  )

  it('recusa expansao de variavel, que nao seria reproduzivel', () => {
    expect(codeOf('npm run test -- --reporter=$REPORTER')).toBe('GATE_COMMAND_SYNTAX')
    expect(codeOf('node -e "console.log($HOME)"')).toBe('GATE_COMMAND_SYNTAX')
  })

  it('aceita shell explicito, porque a linha colada faz exatamente o mesmo', () => {
    expect(tokenizeCommandLine("sh -c 'a && b'")).toEqual(['sh', '-c', 'a && b'])
  })

  it('recusa aspas nao fechadas', () => {
    expect(codeOf("npm run 'lint")).toBe('GATE_COMMAND_SYNTAX')
    expect(codeOf('npm run "lint')).toBe('GATE_COMMAND_SYNTAX')
  })

  it('recusa barra invertida no fim da linha e quebra de linha', () => {
    expect(codeOf('npm run lint \\')).toBe('GATE_COMMAND_SYNTAX')
    expect(codeOf('npm run lint\nnpm run test')).toBe('GATE_COMMAND_SYNTAX')
  })

  it('recusa linha vazia', () => {
    expect(codeOf('   ')).toBe('GATE_COMMAND_SYNTAX')
  })

  it('argumento vazio explicito continua sendo um argumento', () => {
    expect(tokenizeCommandLine('cmd "" x')).toEqual(['cmd', '', 'x'])
  })
})
