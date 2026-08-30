import type { AgentClaims, ReviewFinding, ReviewVerdict } from '@agentic/domain'

const VERDICT_PATTERN = /\b(?:VERDICT|VEREDITO)\s*[:=]\s*(PASS|FAIL|ESCALATE)\b/i
/** Linha isolada com o veredito: o prompt pede "veredito em uma linha". */
const BARE_VERDICT_PATTERN = /^\s*(PASS|FAIL|ESCALATE)\s*[.!]?\s*$/i
const FINDING_PATTERN = /^\s*(?:FINDING|ACHADO)\s*(?:\[(info|warning|error)\])?\s*[:-]\s*(.+)$/i

export interface ParsedReview {
  readonly verdict?: ReviewVerdict
  readonly findings: readonly ReviewFinding[]
  readonly rationale: string
}

function textOf(claims: AgentClaims | undefined): string {
  if (claims === undefined) return ''
  return [claims.summary, claims.detail ?? ''].join('\n')
}

/**
 * O veredito e o PRODUTO do revisor — nao o relato do executor. Sem veredito explicito a
 * revisao nao concluiu: devolvemos `undefined` e o orquestrador trata como erro de agente,
 * jamais como aprovacao por omissao.
 */
function verdictOf(text: string): ReviewVerdict | undefined {
  const declared = VERDICT_PATTERN.exec(text)?.[1]
  if (declared !== undefined) return declared.toUpperCase() as ReviewVerdict
  for (const line of text.split('\n')) {
    const bare = BARE_VERDICT_PATTERN.exec(line)?.[1]
    if (bare !== undefined) return bare.toUpperCase() as ReviewVerdict
  }
  return undefined
}

export function parseReview(claims: AgentClaims | undefined): ParsedReview {
  const text = textOf(claims)
  const verdict = verdictOf(text)
  const findings: ReviewFinding[] = []
  for (const line of text.split('\n')) {
    const found = FINDING_PATTERN.exec(line)
    const message = found?.[2]
    if (message === undefined) continue
    const severity = (found?.[1] ?? 'warning').toLowerCase() as ReviewFinding['severity']
    findings.push({ severity, message: message.trim() })
  }
  return { verdict, findings, rationale: claims?.summary ?? '' }
}
