import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LocalAgentSpec, ProviderId } from '@agentic/domain'
import { providerId } from '@agentic/domain'

export const PROVIDER: ProviderId = providerId('p-alpha')

export const FAKE_CLI = 'fake-cli'
export const FAKE_DIR_CLI = 'fake-dir-cli'
export const FAKE_INERT_CLI = 'fake-inert-cli'

/** CLI de mentira: cobre versao legivel, versao ilegivel, prontidao e travamento. */
const SCRIPT = `#!/bin/sh
case "$1" in
  --version) echo "fake-cli 1.2.3 (build 7)" ;;
  --version-stderr) echo "v9.8.7" >&2 ;;
  --version-mudo) echo "sem numero nenhum" ;;
  --version-lenta) sleep 30 ;;
  --pronto) exit 0 ;;
  --nao-pronto) echo "sessao nao autenticada" >&2; exit 4 ;;
  --prontidao-lenta) sleep 30 ;;
  --segredo-ausente) if [ -n "\${SEGREDO_DO_TESTE}" ]; then exit 3; else exit 0; fi ;;
  *) echo "argumento desconhecido: $1" >&2; exit 64 ;;
esac
`

export interface FakeCliDir {
  /** Diretorio a usar como PATH no probe. */
  readonly dir: string
  /** Caminho absoluto do executavel de mentira. */
  readonly path: string
}

export function makeTempDir(prefix = 'agentic-agent-runtime-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

export function makeFakeCli(): FakeCliDir {
  const dir = makeTempDir()
  const path = join(dir, FAKE_CLI)
  writeFileSync(path, SCRIPT, { mode: 0o755 })
  chmodSync(path, 0o755)
  // homonimo que e diretorio, e arquivo sem bit de execucao: nenhum dos dois e instalacao
  mkdirSync(join(dir, FAKE_DIR_CLI))
  writeFileSync(join(dir, FAKE_INERT_CLI), SCRIPT, { mode: 0o644 })
  chmodSync(join(dir, FAKE_INERT_CLI), 0o644)
  return { dir, path }
}

export function spec(overrides: Partial<LocalAgentSpec> = {}): LocalAgentSpec {
  return {
    providerId: PROVIDER,
    executable: FAKE_CLI,
    args: [],
    ...overrides,
  }
}
