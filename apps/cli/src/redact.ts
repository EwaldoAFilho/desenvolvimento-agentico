import { redactSecrets } from '@agentic/process'

export const MASK = '[REDACTED]'

/** Endereco de e-mail: a sonda de sessao de uma CLI costuma imprimir o do usuario. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g

/**
 * Ultimo filtro antes do terminal (ARCHITECTURE 9). O contrato ja diz que `detail`,
 * `readinessSource` e `diagnostic` carregam frases NOSSAS, nunca a saida da CLI — este
 * filtro existe para o dia em que um adapter novo esquecer disso. Defesa em profundidade:
 * token e e-mail nao chegam ao terminal nem por acidente.
 */
export function sanitize(text: string): string {
  return redactSecrets(text.replace(EMAIL, MASK))
}
