import nodeProcess from 'node:process'
import type { LocalAgentSpec, ProviderHealth } from '@agentic/domain'
import type { CapturedRun } from '@agentic/process'
import { buildEnv, runCaptured } from '@agentic/process'
import { describeError } from './errors.js'
import { resolveExecutable } from './resolve.js'
import type { LocalAgentRuntimeDeps, ProbeContext } from './types.js'

export const DEFAULT_PROBE_TIMEOUT_MS = 5000
export const DEFAULT_PROBE_MAX_OUTPUT_BYTES = 64 * 1024

/**
 * Allowlist minima do probe. Nada aqui e credencial: o processo do agente recebe o
 * ambiente que o chamador montou, e este probe nao acrescenta nada a ele (P17/ADR-0009).
 */
export const PROBE_ENV_ALLOW: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'USERPROFILE',
]

/** Tolerante de proposito: `1.2`, `1.2.3`, `v9.8.7-beta.1`, `cli 0.9.2 (build 7)`. */
const VERSION_PATTERN = /\d+\.\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.]+)?/

export function extractVersion(...outputs: readonly string[]): string | 'unknown' {
  for (const text of outputs) {
    const match = VERSION_PATTERN.exec(text)
    if (match !== null) return match[0]
  }
  return 'unknown'
}

function quote(executable: string, args: readonly string[]): string {
  return `\`${[executable, ...args].join(' ')}\``
}

function hasArgs(args: readonly string[] | undefined): args is readonly string[] {
  return args !== undefined && args.length > 0
}

async function askCli(
  command: string,
  args: readonly string[],
  deps: LocalAgentRuntimeDeps,
): Promise<CapturedRun> {
  return runCaptured(
    {
      command,
      args,
      cwd: deps.probeCwd ?? nodeProcess.cwd(),
      env: deps.probeEnv ?? buildEnv(PROBE_ENV_ALLOW),
      timeoutMs: deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      maxOutputBytes: deps.probeMaxOutputBytes ?? DEFAULT_PROBE_MAX_OUTPUT_BYTES,
    },
    deps.processDeps,
  )
}

/**
 * Saude observada, nunca deduzida. Em particular: `--version` que respondeu prova
 * instalacao, jamais autenticacao — nesse caso `ready` e `unknown` (DOMAIN-MODEL 4.1).
 */
export async function probeLocalAgent(
  spec: LocalAgentSpec,
  ctx: ProbeContext = {},
  deps: LocalAgentRuntimeDeps = {},
): Promise<ProviderHealth> {
  const now = deps.now ?? Date.now
  const notes: string[] = []

  const resolution = await resolveExecutable(spec.executable, {
    platform: deps.platform,
    pathEnv: deps.pathEnv ?? nodeProcess.env.PATH,
    pathExt: deps.pathExt,
    isExecutableFile: deps.isExecutableFile,
  })

  let installed: boolean | 'unknown'
  let version: string | 'unknown' = 'unknown'
  let ready: boolean | 'unknown' = 'unknown'

  if (resolution.status === 'found') {
    installed = true
    notes.push(`executavel em ${resolution.path}`)
    version = await probeVersion(spec, resolution.path, deps, notes)
    ready = await probeReadiness(spec, resolution.path, ctx, deps, notes)
  } else if (resolution.status === 'not-found') {
    installed = false
    // Sem binario nao ha o que estar pronto: unica ocasiao em que `ready: false` dispensa sonda.
    ready = false
    notes.push(`instalacao: ${resolution.detail}`)
    notes.push('prontidao: false por ausencia do executavel')
  } else {
    installed = 'unknown'
    ready = 'unknown'
    notes.push(`instalacao unknown: ${resolution.detail}`)
    notes.push('prontidao unknown: instalacao nao apurada')
  }

  const fromLedger = deps.ledger?.usage(spec.providerId)
  const running = ctx.running ?? fromLedger?.running ?? 0
  const capacity = ctx.capacity !== undefined ? ctx.capacity : (fromLedger?.capacity ?? null)

  return {
    providerId: spec.providerId,
    installed,
    ready,
    version,
    detail: notes.join('; '),
    probedAt: new Date(now()),
    running,
    capacity,
  }
}

async function probeVersion(
  spec: LocalAgentSpec,
  command: string,
  deps: LocalAgentRuntimeDeps,
  notes: string[],
): Promise<string | 'unknown'> {
  if (!hasArgs(spec.versionArgs)) {
    notes.push('versao unknown: spec sem versionArgs')
    return 'unknown'
  }
  const label = quote(spec.executable, spec.versionArgs)
  let run: CapturedRun
  try {
    run = await askCli(command, spec.versionArgs, deps)
  } catch (error) {
    notes.push(`versao unknown: ${label} falhou (${describeError(error)})`)
    return 'unknown'
  }
  if (run.spawnError !== undefined) {
    notes.push(`versao unknown: ${label} nao iniciou (${run.spawnError.code})`)
    return 'unknown'
  }
  if (run.timedOut) {
    notes.push(`versao unknown: ${label} expirou`)
    return 'unknown'
  }
  const version = extractVersion(run.stdout, run.stderr)
  notes.push(version === 'unknown' ? `versao unknown: ${label} ilegivel` : `versao via ${label}`)
  return version
}

async function probeReadiness(
  spec: LocalAgentSpec,
  command: string,
  ctx: ProbeContext,
  deps: LocalAgentRuntimeDeps,
  notes: string[],
): Promise<boolean | 'unknown'> {
  if (ctx.capabilities?.readinessProbe === 'unsupported') {
    notes.push('prontidao nao observavel nesta CLI (readinessProbe unsupported)')
    return 'unknown'
  }
  if (!hasArgs(spec.readinessArgs)) {
    notes.push('prontidao nao observavel: spec sem readinessArgs')
    return 'unknown'
  }
  const label = quote(spec.executable, spec.readinessArgs)
  let run: CapturedRun
  try {
    run = await askCli(command, spec.readinessArgs, deps)
  } catch (error) {
    notes.push(`prontidao unknown: ${label} falhou (${describeError(error)})`)
    return 'unknown'
  }
  if (run.spawnError !== undefined) {
    notes.push(`prontidao unknown: ${label} nao iniciou (${run.spawnError.code})`)
    return 'unknown'
  }
  // Sonda travada nao e prova de nao-prontidao: e ausencia de observacao.
  if (run.timedOut) {
    notes.push(`prontidao unknown: ${label} expirou`)
    return 'unknown'
  }
  if (run.code === 0) {
    notes.push(`prontidao via ${label} (exit 0)`)
    return true
  }
  notes.push(`prontidao false: ${label} saiu com codigo ${run.code ?? '-'}`)
  return false
}
