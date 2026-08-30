import nodeProcess from 'node:process'
import type { LocalAgentSpec, ProviderDiagnostic, ProviderHealth } from '@agentic/domain'
import type { CapturedRun } from '@agentic/process'
import { buildEnv, redactSecrets, runCaptured } from '@agentic/process'
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

/**
 * Unico pedaco da saida da sonda que a gente le: um booleano de sessao. Tudo o mais que
 * a CLI imprima — e-mail, organizacao, token — nao e olhado, nao e guardado e nao sai
 * daqui. O que vira `ProviderHealth` sao frases nossas, nunca trecho da saida.
 */
const READINESS_SIGNAL =
  /["']?(?:logged_?in|signed_?in|is_?authenticated|authenticated)["']?\s*[:=]\s*(true|false)\b/i

export function extractVersion(...outputs: readonly string[]): string | 'unknown' {
  for (const text of outputs) {
    const match = VERSION_PATTERN.exec(text)
    if (match !== null) return match[0]
  }
  return 'unknown'
}

/**
 * `true`/`false` quando a sonda declarou explicitamente o estado da sessao; `null`
 * quando nao declarou nada legivel. Le apenas o booleano — jamais o resto da linha.
 */
export function readinessSignal(...outputs: readonly string[]): boolean | null {
  for (const text of outputs) {
    const match = READINESS_SIGNAL.exec(text)
    if (match !== null) return match[1]?.toLowerCase() === 'true'
  }
  return null
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

/** O que a sonda de prontidao apurou: o veredito e a frase que explica de onde ele veio. */
interface ReadinessVerdict {
  readonly ready: boolean | 'unknown'
  readonly source: string
  readonly diagnostic?: ProviderDiagnostic
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
  let readiness: ReadinessVerdict
  let resolvedPath: string | 'unknown' = 'unknown'
  let diagnostic: ProviderDiagnostic | undefined

  if (resolution.status === 'found') {
    installed = true
    resolvedPath = resolution.path
    notes.push(`executavel em ${resolution.path}`)
    version = await probeVersion(spec, resolution.path, deps, notes)
    readiness = await probeReadiness(spec, resolution.path, ctx, deps)
    diagnostic = readiness.diagnostic
  } else if (resolution.status === 'not-found') {
    installed = false
    // Sem binario nao ha o que estar pronto: unica ocasiao em que `ready: false` dispensa sonda.
    readiness = { ready: false, source: 'prontidao false por ausencia do executavel' }
    diagnostic = resolution.diagnostic
    notes.push(`instalacao: ${resolution.detail}`)
  } else {
    installed = 'unknown'
    readiness = { ready: 'unknown', source: 'prontidao unknown: instalacao nao apurada' }
    diagnostic = resolution.diagnostic
    notes.push(`instalacao unknown: ${resolution.detail}`)
  }
  notes.push(readiness.source)

  const fromLedger = deps.ledger?.usage(spec.providerId)
  const running = ctx.running ?? fromLedger?.running ?? 0
  const capacity = ctx.capacity !== undefined ? ctx.capacity : (fromLedger?.capacity ?? null)

  const health: ProviderHealth = {
    providerId: spec.providerId,
    installed,
    ready: readiness.ready,
    version,
    // Redigido de novo na saida: nenhuma frase nossa carrega segredo, e ainda assim
    // nada chega ao artefato sem passar pelo redator (ARCHITECTURE 9).
    detail: redactSecrets(notes.join('; ')),
    probedAt: new Date(now()),
    running,
    capacity,
    resolvedPath,
    readinessSource: redactSecrets(readiness.source),
  }
  return diagnostic === undefined ? health : { ...health, diagnostic: redactDiagnostic(diagnostic) }
}

function redactDiagnostic(diagnostic: ProviderDiagnostic): ProviderDiagnostic {
  const out: ProviderDiagnostic = {
    kind: diagnostic.kind,
    detail: redactSecrets(diagnostic.detail),
  }
  return {
    ...out,
    ...(diagnostic.target === undefined ? {} : { target: redactSecrets(diagnostic.target) }),
    ...(diagnostic.remediation === undefined
      ? {}
      : { remediation: redactSecrets(diagnostic.remediation) }),
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
  const version = extractVersion(redactSecrets(run.stdout), redactSecrets(run.stderr))
  notes.push(version === 'unknown' ? `versao unknown: ${label} ilegivel` : `versao via ${label}`)
  return version
}

/**
 * Regra dura (ADR-0010 4): `ready: true` so com sonda que efetivamente saiu 0. Sonda
 * ausente, expirada, ilegivel ou que nao iniciou continua `unknown` — nunca `false` por
 * suposicao, nunca `true` por otimismo.
 */
async function probeReadiness(
  spec: LocalAgentSpec,
  command: string,
  ctx: ProbeContext,
  deps: LocalAgentRuntimeDeps,
): Promise<ReadinessVerdict> {
  if (ctx.capabilities?.readinessProbe === 'unsupported') {
    return {
      ready: 'unknown',
      source:
        'CLI nao expoe estado de autenticacao (readinessProbe unsupported): prontidao nao observavel',
    }
  }
  if (!hasArgs(spec.readinessArgs)) {
    return { ready: 'unknown', source: 'prontidao nao observavel: spec sem readinessArgs' }
  }
  const label = quote(spec.executable, spec.readinessArgs)
  const unobserved = (motivo: string): ReadinessVerdict => {
    const detail = `prontidao unknown: sonda ${label} ${motivo}`
    return {
      ready: 'unknown',
      source: detail,
      diagnostic: {
        kind: 'probe-failed',
        detail,
        remediation: `rode ${label} a mao para ver o que a CLI responde`,
      },
    }
  }

  let run: CapturedRun
  try {
    run = await askCli(command, spec.readinessArgs, deps)
  } catch (error) {
    return unobserved(`falhou (${describeError(error)})`)
  }
  if (run.spawnError !== undefined) return unobserved(`nao iniciou (${run.spawnError.code})`)
  // Sonda travada nao e prova de nao-prontidao: e ausencia de observacao.
  if (run.timedOut) return unobserved('expirou antes de responder')
  if (run.code !== 0) {
    return {
      ready: false,
      source: `prontidao false: sonda ${label} saiu com codigo ${run.code ?? '-'}`,
    }
  }
  // Saiu 0. So agora o sinal booleano da saida pode ser lido — e nada alem dele.
  const signal = readinessSignal(redactSecrets(run.stdout), redactSecrets(run.stderr))
  if (signal === false) {
    return {
      ready: false,
      source: `prontidao false: sonda ${label} saiu 0 mas declarou sessao nao autenticada`,
    }
  }
  if (signal === true)
    return { ready: true, source: `sonda ${label} saiu 0 e declarou sessao autenticada` }
  return { ready: true, source: `sonda ${label} saiu 0` }
}
