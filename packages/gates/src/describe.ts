import type { GateExecution } from '@agentic/domain'
import type { SkippedGateCommand } from './types.js'

/** Aceita o tipo do dominio; usa os extras do runner quando existem. */
export type DescribableGate = GateExecution & {
  readonly skipped?: readonly SkippedGateCommand[]
  readonly envAllow?: readonly string[]
}

export interface GateCommandRepro {
  readonly index: number
  /** Linha exata declarada em `gates.yaml`. */
  readonly command: string
  readonly cwd: string
  readonly ran: boolean
  readonly exitCode: number | null
  /** Colavel no terminal: entra no cwd e roda a linha exata. */
  readonly line: string
}

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/

/**
 * P08 em forma executavel: devolve, na ordem, as linhas que reproduzem o gate — inclusive
 * as dos comandos que o fail-fast nao chegou a rodar, marcadas como nao executadas.
 */
export function describeGate(execution: DescribableGate): readonly GateCommandRepro[] {
  const out: GateCommandRepro[] = []
  // Os resultados sao um prefixo dos comandos declarados (fail-fast interrompe), entao a
  // posicao no array E o indice do comando.
  execution.results.forEach((result, index) => {
    out.push({
      index,
      command: result.command,
      cwd: result.cwd,
      ran: true,
      exitCode: result.exitCode,
      line: reproLine(result.cwd, result.command),
    })
  })
  for (const skip of execution.skipped ?? []) {
    out.push({
      index: skip.index,
      command: skip.command,
      cwd: skip.cwd,
      ran: false,
      exitCode: null,
      line: reproLine(skip.cwd, skip.command),
    })
  }
  return out.sort((left, right) => left.index - right.index)
}

/** Bloco pronto para colar no terminal ou anexar ao relatorio. */
export function describeGateScript(execution: DescribableGate): string {
  const header = [
    `# gate ${execution.gateId} (${execution.scope}) — ${execution.status}`,
    `# run ${execution.runId}${execution.attemptId === undefined ? '' : ` · tentativa ${execution.attemptId}`}`,
  ]
  if (execution.envAllow !== undefined) {
    header.push(`# env allowlist: ${execution.envAllow.join(', ') || '(vazia)'}`)
  }
  const lines = describeGate(execution).map((repro) =>
    repro.ran
      ? `${repro.line}   # exit ${repro.exitCode ?? 'sem codigo'}`
      : `# nao executado (fail-fast): ${repro.line}`,
  )
  return [...header, ...lines].join('\n')
}

export function shellQuote(value: string): string {
  if (value.length > 0 && SAFE_WORD.test(value)) return value
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function reproLine(cwd: string, command: string): string {
  return `cd ${shellQuote(cwd)} && ${command}`
}
