import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

/**
 * Canal entre o global setup e os testes. O ambiente sobe numa porta EFEMERA, entao a
 * baseURL so existe depois que o servidor escuta — e o worker do Playwright e outro
 * processo. Arquivo, portanto: inspecionavel, e sem depender de heranca de env.
 */
export interface BrowserHandoff {
  readonly baseURL: string
  /** Referencia da missao do fixture, do jeito que a URL do dashboard aceita. */
  readonly missionRef: string
  /** Raiz do projeto-alvo temporario; ausente quando o servidor veio de fora. */
  readonly projectRoot: string | undefined
  /** `false` quando a suite se conectou a um control plane que ja estava no ar. */
  readonly managed: boolean
  readonly startedAt: string
}

const HOME = `agentic-browser-${userInfo().uid}`

export const HANDOFF_DIR = join(tmpdir(), HOME)
export const HANDOFF_PATH = join(HANDOFF_DIR, 'environment.json')
/**
 * Trace, screenshot e report ficam FORA do repositorio: a suite nao pode sujar o working
 * tree de quem esta no meio de uma missao.
 */
export const ARTIFACTS_DIR = join(HANDOFF_DIR, 'test-results')

function isHandoff(value: unknown): value is BrowserHandoff {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.baseURL === 'string' && typeof candidate.missionRef === 'string'
}

export function readHandoff(): BrowserHandoff | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(HANDOFF_PATH, 'utf8'))
    return isHandoff(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Falta de handoff nunca vira "pulei o teste": o global setup nao subiu o ambiente e isso
 * e uma reprovacao com endereco.
 */
export function requireHandoff(): BrowserHandoff {
  const handoff = readHandoff()
  if (handoff === undefined) {
    throw new Error(
      `ambiente de navegador ausente: ${HANDOFF_PATH} nao existe ou esta invalido. ` +
        'Rode a suite por `npm run test:browser` (o global setup e quem sobe o control plane).',
    )
  }
  return handoff
}

export function writeHandoff(handoff: BrowserHandoff): void {
  mkdirSync(HANDOFF_DIR, { recursive: true })
  writeFileSync(HANDOFF_PATH, `${JSON.stringify(handoff, null, 2)}\n`, 'utf8')
}

export function clearHandoff(): void {
  rmSync(HANDOFF_PATH, { force: true })
}
