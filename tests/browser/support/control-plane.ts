import type { RunHeaderDto, RunSnapshot } from '@agentic/schemas'
import type { ApproveMissionResult, HealthBody, StartRunResult } from '@agentic/server'

/**
 * Utilidades HTTP para o teste dirigir o control plane REAL: aprovar a missao e dar a
 * partida sao os dois atos do dashboard (DASHBOARD 7). Nada aqui grava estado por conta
 * propria — tudo passa pelo endpoint do produto.
 */
export class ControlPlaneError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ControlPlaneError'
    this.status = status
  }
}

async function send<T>(baseURL: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseURL}${path}`, {
    ...init,
    headers: { accept: 'application/json', ...(init?.headers ?? {}) },
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText)
    throw new ControlPlaneError(response.status, `${init?.method ?? 'GET'} ${path}: ${detail}`)
  }
  return (await response.json()) as T
}

async function post<T>(baseURL: string, path: string, body: unknown): Promise<T> {
  return send<T>(baseURL, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function health(baseURL: string): Promise<HealthBody> {
  return send<HealthBody>(baseURL, '/api/health')
}

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms)
  })

/** Espera o control plane responder de verdade; nao basta a porta estar aberta. */
export async function waitForHealth(baseURL: string, timeoutMs = 20_000): Promise<HealthBody> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  for (;;) {
    try {
      return await health(baseURL)
    } catch (cause) {
      last = cause
      if (Date.now() > deadline) {
        throw new Error(`control plane em ${baseURL} nao respondeu /api/health: ${String(last)}`)
      }
      await sleep(100)
    }
  }
}

export interface ApproveInput {
  readonly file: string
  /** Aprovar e ato humano REGISTRADO: sem `actor` o servidor recusa, e faz bem. */
  readonly actor: string
  readonly note?: string
}

export async function approveMission(
  baseURL: string,
  input: ApproveInput,
): Promise<ApproveMissionResult> {
  return post<ApproveMissionResult>(baseURL, '/api/missions/approve', input)
}

export interface StartInput {
  readonly missionId: string
  readonly actor: string
  readonly acceptWarnings?: boolean
}

/** UM clique: quem descobre as tasks READY e o orquestrador, nao o teste. */
export async function startRun(baseURL: string, input: StartInput): Promise<StartRunResult> {
  return post<StartRunResult>(baseURL, '/api/runs', {
    missionId: input.missionId,
    actor: input.actor,
    acceptWarnings: input.acceptWarnings ?? false,
  })
}

export async function listRuns(baseURL: string): Promise<readonly RunHeaderDto[]> {
  return send<readonly RunHeaderDto[]>(baseURL, '/api/runs')
}

export async function runSnapshot(baseURL: string, runId: string): Promise<RunSnapshot> {
  return send<RunSnapshot>(baseURL, `/api/runs/${encodeURIComponent(runId)}/snapshot`)
}

export async function resumeRun(baseURL: string, runId: string, actor: string): Promise<unknown> {
  return post(baseURL, `/api/runs/${encodeURIComponent(runId)}/resume`, { actor })
}

/** Run mais recente da missao. O servidor ja devolve a lista em ordem decrescente. */
export async function latestRun(
  baseURL: string,
  missionId: string,
): Promise<RunHeaderDto | undefined> {
  return (await listRuns(baseURL)).find((run) => run.missionId === missionId)
}

/** Statuses em que o run parou de andar sozinho. */
export const TERMINAL_RUN_STATUSES = ['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED'] as const

export async function waitForRunStatus(
  baseURL: string,
  runId: string,
  wanted: readonly string[],
  timeoutMs = 90_000,
): Promise<RunSnapshot> {
  const deadline = Date.now() + timeoutMs
  let last = 'desconhecido'
  for (;;) {
    const snapshot = await runSnapshot(baseURL, runId)
    last = snapshot.run.status
    if (wanted.includes(last)) return snapshot
    if (Date.now() > deadline) {
      throw new Error(
        `run ${runId} nao chegou a ${wanted.join('|')} em ${timeoutMs}ms: parou em ${last}`,
      )
    }
    await sleep(100)
  }
}

/**
 * Deixa o run terminar antes de o teste ceder o control plane ao proximo. Sem isto, um run
 * ainda vivo continua gravando eventos enquanto outro teste mede o que ve na tela.
 */
export async function settle(baseURL: string, runId: string): Promise<RunSnapshot> {
  return waitForRunStatus(baseURL, runId, TERMINAL_RUN_STATUSES)
}
