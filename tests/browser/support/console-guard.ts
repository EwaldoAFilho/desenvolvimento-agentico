import type { Page } from '@playwright/test'

/**
 * Ruido tolerado no console, com endereco e motivo.
 *
 * Esta lista esta VAZIA de proposito: hoje o caminho feliz do dashboard nao emite um
 * unico aviso, e uma allowlist preventiva so serviria para esconder o primeiro que
 * aparecer. Entrada nova aqui exige o padrao exato e o comentario dizendo de quem e o
 * aviso e por que ele nao e nosso.
 */
export const TOLERATED: readonly RegExp[] = []

export interface ConsoleProblem {
  readonly kind: 'console' | 'pageerror' | 'requestfailed' | 'http'
  readonly detail: string
}

export interface ConsoleGuard {
  readonly problems: readonly ConsoleProblem[]
}

function tolerated(detail: string): boolean {
  return TOLERATED.some((pattern) => pattern.test(detail))
}

/**
 * Coleta o que o navegador reclamou: mensagem de erro/aviso no console, excecao nao
 * capturada, requisicao que nem completou e resposta HTTP >= 400.
 *
 * O `4xx` do control plane conta como problema por padrao — no caminho feliz nao existe
 * requisicao recusada. Quem exercita uma recusa DE PROPOSITO passa o padrao em
 * `expectedHttp`, e o teste continua reprovando qualquer outra.
 */
export function watchConsole(page: Page, expectedHttp: readonly RegExp[] = []): ConsoleGuard {
  const problems: ConsoleProblem[] = []
  const add = (kind: ConsoleProblem['kind'], detail: string): void => {
    if (!tolerated(detail)) problems.push({ kind, detail })
  }

  page.on('console', (message) => {
    const type = message.type()
    if (type !== 'error' && type !== 'warning') return
    add('console', `${type}: ${message.text()}`)
  })
  page.on('pageerror', (error) => {
    add('pageerror', `${error.name}: ${error.message}`)
  })
  page.on('requestfailed', (request) => {
    add('requestfailed', `${request.method()} ${request.url()}: ${request.failure()?.errorText}`)
  })
  page.on('response', (response) => {
    if (response.status() < 400) return
    const line = `${response.status()} ${response.request().method()} ${response.url()}`
    if (expectedHttp.some((pattern) => pattern.test(line))) return
    add('http', line)
  })

  return { problems }
}
