import { buildEnv, runCaptured } from '@agentic/process'

/**
 * Abertura do navegador na URL do control plane.
 *
 * Todo comando de sistema operacional do produto passa por @agentic/process — o unico
 * pacote autorizado a falar com o SO. Nada aqui importa `node:child_process`: allowlist de
 * ambiente, teto de saida, tree-kill e a soltura dos pipes que sobrevivem ao filho ja estao
 * resolvidos la, e resolver de novo seria uma segunda implementacao de processo no produto.
 */

export interface BrowserCommand {
  readonly command: string
  readonly args: readonly string[]
}

/** Comando de abertura da plataforma. `undefined` = plataforma sem abertura conhecida. */
export function browserCommandOf(
  platform: NodeJS.Platform | undefined,
  url: string,
): BrowserCommand | undefined {
  if (platform === undefined) return undefined
  if (platform === 'darwin') return { command: 'open', args: [url] }
  // `start` e builtin do cmd, e o primeiro argumento dele e o titulo da janela: sem o ""
  // no lugar do titulo, a URL vira titulo e nada abre.
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] }
  return { command: 'xdg-open', args: [url] }
}

/**
 * Ambiente que o abridor recebe. Allowlist estrita, como todo processo filho do produto:
 * abrir navegador nao e motivo para derramar o shell do usuario num processo novo.
 */
export const BROWSER_ENV_ALLOW: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'TMPDIR',
  // sessao grafica em POSIX
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
  'XDG_SESSION_TYPE',
  'XDG_CURRENT_DESKTOP',
  'XDG_DATA_DIRS',
  'XDG_CONFIG_HOME',
  'DBUS_SESSION_BUS_ADDRESS',
  // sem estas, `cmd` nao encontra a si mesmo no Windows
  'SystemRoot',
  'windir',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
]

/**
 * Espera maxima entre a saida do abridor e a soltura dos pipes. O navegador costuma herdar
 * o stdout do abridor e segura-lo enquanto viver; sem soltar, a CLI ficaria presa a ele.
 */
export const BROWSER_CLOSE_GRACE_MS = 1_000

/** Diagnostico do abridor e curto por natureza; nao ha motivo para guardar um megabyte. */
export const BROWSER_MAX_OUTPUT_BYTES = 64 * 1024

export interface HeadlessInput {
  readonly platform: NodeJS.Platform | undefined
  readonly env: Readonly<Record<string, string | undefined>>
}

function on(value: string | undefined): boolean {
  if (value === undefined) return false
  const normalized = value.trim().toLowerCase()
  return normalized !== '' && normalized !== '0' && normalized !== 'false'
}

function hasDisplay(env: Readonly<Record<string, string | undefined>>): boolean {
  return on(env.DISPLAY) || on(env.WAYLAND_DISPLAY)
}

function isRemote(env: Readonly<Record<string, string | undefined>>): boolean {
  return on(env.SSH_CONNECTION) || on(env.SSH_TTY) || on(env.SSH_CLIENT)
}

/**
 * Por que NAO ha navegador para abrir; `undefined` quando ha ambiente grafico.
 *
 * Plataforma ausente conta como ambiente nao declarado e nunca vira tentativa: `unknown`
 * nao vira aprovacao aqui tambem. Na pratica isso so acontece em teste — `defaultDeps`
 * sempre declara a plataforma do host —, e e o que mantem a suite sem abrir navegador de
 * verdade em qualquer sistema operacional.
 */
export function headlessReason(input: HeadlessInput): string | undefined {
  if (input.platform === undefined) return 'plataforma do host nao declarada'
  if (on(input.env.CI)) return 'CI declarado no ambiente'
  if (isRemote(input.env) && !hasDisplay(input.env)) {
    return 'sessao remota (SSH) sem DISPLAY encaminhado'
  }
  if (input.platform === 'darwin' || input.platform === 'win32') return undefined
  if (!hasDisplay(input.env)) return 'sem DISPLAY nem WAYLAND_DISPLAY'
  return undefined
}

export interface BrowserOutcome {
  readonly opened: boolean
  /** Comando efetivamente despachado, quando houve um. */
  readonly command?: string
  /** Por que nao abriu. Sempre presente quando `opened` e falso. */
  readonly reason?: string
}

export interface OpenBrowserInput {
  readonly url: string
  readonly cwd: string
  readonly platform: NodeJS.Platform | undefined
  readonly env: Readonly<Record<string, string | undefined>>
}

/** Assinatura de `runCaptured`. Injetavel para o teste nao abrir navegador de verdade. */
export type ProcessRunner = typeof runCaptured

/**
 * Abre a URL, ou explica por que nao abriu. Nunca lanca: falhar em abrir navegador nao pode
 * derrubar o launcher — a URL continua valendo e o uso headless depende disso.
 *
 * Nao ha `timeoutMs`: o timeout de @agentic/process mata a arvore do processo, e a arvore
 * do abridor pode ser o navegador do usuario.
 */
export async function openBrowser(
  input: OpenBrowserInput,
  run: ProcessRunner = runCaptured,
): Promise<BrowserOutcome> {
  const headless = headlessReason(input)
  if (headless !== undefined) return { opened: false, reason: headless }

  const target = browserCommandOf(input.platform, input.url)
  if (target === undefined) {
    return { opened: false, reason: `sem abertura conhecida para a plataforma ${input.platform}` }
  }
  const label = [target.command, ...target.args].filter((part) => part !== '').join(' ')

  const captured = await run(
    {
      command: target.command,
      args: target.args,
      cwd: input.cwd,
      env: buildEnv(BROWSER_ENV_ALLOW, { ...input.env }),
      maxOutputBytes: BROWSER_MAX_OUTPUT_BYTES,
    },
    { closeGraceMs: BROWSER_CLOSE_GRACE_MS },
  )

  if (captured.spawnError !== undefined) {
    return {
      opened: false,
      command: label,
      reason: `${target.command} indisponivel: ${captured.spawnError.message}`,
    }
  }
  if (captured.code !== 0) {
    const detail =
      captured.stderr.trim() || captured.stdout.trim() || `saiu com codigo ${captured.code}`
    return { opened: false, command: label, reason: `${target.command} falhou: ${detail}` }
  }
  return { opened: true, command: label }
}
