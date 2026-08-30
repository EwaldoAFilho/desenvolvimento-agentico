import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import {
  CONTRACT_CWD_FILE,
  CONTRACT_STDERR_MARK,
  CONTRACT_STDOUT_MARK,
} from '../contract.suite.js'

/**
 * CLIs de mentira. Nenhum teste toca uma CLI de verdade nem a rede: os adapters reais sao
 * validados contra estes scripts, entao a suite jamais consome quota (ADR-0010 2).
 */
export const PROMPT_FILE = 'agent-prompt.txt'
export const ARGV_FILE = 'agent-argv.txt'
export const ENV_FILE = 'agent-env.txt'
export const FAKE_VERSION = '1.2.3'

function script(readiness: string, body: string): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "agente-falso ${FAKE_VERSION}"
  exit 0
fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then
${readiness}
fi
ultimo=""
for arg in "$@"; do ultimo="$arg"; done
pwd > ${CONTRACT_CWD_FILE}
printf '%s' "$ultimo" > ${PROMPT_FILE}
printf '%s\\n' "$@" > ${ARGV_FILE}
env > ${ENV_FILE}
echo "${CONTRACT_STDOUT_MARK}"
echo "${CONTRACT_STDERR_MARK}" >&2
${body}
`
}

const READY = '  exit 0'
const NOT_READY = '  echo "sessao nao autenticada" >&2\n  exit 1'

const MODES: Readonly<Record<string, string>> = {
  ok: script(READY, 'exit 0'),
  falha: script(READY, 'echo "o agente falhou" >&2\nexit 7'),
  lento: script(READY, 'sleep 30\nexit 0'),
  'sem-login': script(NOT_READY, 'exit 0'),
  mudo: script(READY, 'exit 0').replace(`agente-falso ${FAKE_VERSION}`, 'sem numero legivel'),
}

export interface FakeCliBundle {
  readonly dir: string
  readonly ok: string
  readonly falha: string
  readonly lento: string
  readonly semLogin: string
  /** Responde `--version` sem numero legivel: versao vira `unknown`. */
  readonly mudo: string
  /** Caminho absoluto que nao existe: `PROVIDER_UNAVAILABLE`. */
  readonly ausente: string
  /** PATH so para os utilitarios do proprio script (`sleep`, `env`). Sem credencial. */
  readonly env: Readonly<Record<string, string>>
  cleanup(): void
}

export function makeTempDir(prefix = 'agentic-providers-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

export function makeFakeCliBundle(): FakeCliBundle {
  const dir = makeTempDir('agentic-fake-cli-')
  for (const [mode, source] of Object.entries(MODES)) {
    const path = join(dir, `agente-${mode}`)
    writeFileSync(path, source, { mode: 0o755 })
    chmodSync(path, 0o755)
  }
  return {
    dir,
    ok: join(dir, 'agente-ok'),
    falha: join(dir, 'agente-falha'),
    lento: join(dir, 'agente-lento'),
    semLogin: join(dir, 'agente-sem-login'),
    mudo: join(dir, 'agente-mudo'),
    ausente: join(dir, 'agente-que-nao-existe'),
    env: { PATH: nodeProcess.env.PATH ?? '/usr/bin:/bin' },
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
