/**
 * Mascaramento de segredo no log do agente, antes de virar artefato.
 *
 * O comportamento e o mesmo ja aplicado a saida de gate e a sonda de provider. A copia
 * existe por fronteira, nao por gosto: `orchestrator` nao pode importar o pacote de
 * processo (scripts/boundaries.config.mjs), e o log do agente e artefato do orquestrador.
 * `EngineDeps.agentLog.redact` permite ao composition root injetar a implementacao
 * canonica no dia em que a fronteira abrir.
 */

const MASK = '[REDACTED]'

/** Formatos de segredo reconheciveis por prefixo, independente do nome da variavel. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\b(?:AKIA|ASIA|AROA|AIDA|ANPA|ANVA|AIPA|AGPA)[A-Z0-9]{12,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
]

const BEARER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9\-._~+/]{8,}={0,2}/gi

const ASSIGNMENT = /([A-Za-z_][A-Za-z0-9_.-]*)("?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|\S+)/g

/** Marcadores que valem como palavra inteira dentro do nome. */
const EXACT_MARKERS = new Set(['KEY', 'KEYS', 'PWD'])
/** Marcadores longos o bastante para valerem como substring (sem falso positivo util). */
const SUBSTRING_MARKERS = ['TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'CREDENTIAL', 'APIKEY']

function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.toUpperCase())
}

/**
 * `MONKEY=banana` nao e segredo e `API_KEY=...` e: por isso KEY vale como palavra
 * inteira e nao como substring.
 */
function isSensitiveName(name: string): boolean {
  const tokens = tokenize(name)
  if (tokens.some((token) => EXACT_MARKERS.has(token))) return true
  const flat = tokens.join('')
  return SUBSTRING_MARKERS.some((marker) => flat.includes(marker))
}

/**
 * Mascara padroes obvios de segredo preservando o resto do texto. O objetivo e evidencia
 * legivel: um log todo suprimido nao diagnostica nada.
 */
export function redactLogText(text: string): string {
  if (text.length === 0) return text
  let out = text.replace(BEARER, (_match: string, scheme: string) => `${scheme} ${MASK}`)
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, MASK)
  }
  return out.replace(
    ASSIGNMENT,
    (match: string, name: string, separator: string, value: string) => {
      if (value === MASK) return match
      return isSensitiveName(name) ? `${name}${separator}${MASK}` : match
    },
  )
}
