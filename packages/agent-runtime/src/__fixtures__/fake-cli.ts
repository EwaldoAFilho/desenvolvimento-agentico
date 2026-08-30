import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LocalAgentSpec, ProviderId } from '@agentic/domain'
import { providerId } from '@agentic/domain'

export const PROVIDER: ProviderId = providerId('p-alpha')

export const FAKE_CLI = 'fake-cli'
export const FAKE_DIR_CLI = 'fake-dir-cli'
export const FAKE_INERT_CLI = 'fake-inert-cli'
/** Symlink cujo alvo nao existe: o caso real que custou uma missao de diagnostico. */
export const FAKE_BROKEN_CLI = 'fake-broken-cli'
/** Symlink com alvo existente: prova que nem todo link e um link quebrado. */
export const FAKE_LINKED_CLI = 'fake-linked-cli'

/** E-mail e token que a sonda de mentira imprime; nenhum dos dois pode vazar. */
export const PII_EMAIL = 'pessoa@exemplo.com'
export const PII_ORG = 'Acme Organizacao Ltda'
export const PII_TOKEN = 'sk-abc123'

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
  --pronto-com-pii)
    echo '{"loggedIn":true,"authMethod":"oauth","email":"${PII_EMAIL}","orgId":"org_12345","orgName":"${PII_ORG}","apiToken":"${PII_TOKEN}"}'
    exit 0 ;;
  --deslogado-com-pii)
    echo '{"loggedIn":false,"email":"${PII_EMAIL}","orgName":"${PII_ORG}","apiToken":"${PII_TOKEN}"}'
    exit 0 ;;
  --segredo-ausente) if [ -n "\${SEGREDO_DO_TESTE}" ]; then exit 3; else exit 0; fi ;;
  *) echo "argumento desconhecido: $1" >&2; exit 64 ;;
esac
`

export interface FakeCliDir {
  /** Diretorio a usar como PATH no probe. */
  readonly dir: string
  /** Caminho absoluto do executavel de mentira. */
  readonly path: string
  /** Symlink quebrado: existe como link, o alvo nao existe. */
  readonly brokenPath: string
  /** Alvo inexistente para onde o symlink quebrado aponta. */
  readonly brokenTarget: string
  /** Symlink saudavel apontando para o executavel de verdade. */
  readonly linkedPath: string
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
  const brokenTarget = join(dir, 'instalacao-que-sumiu', 'cli-real')
  const brokenPath = join(dir, FAKE_BROKEN_CLI)
  symlinkSync(brokenTarget, brokenPath)
  const linkedPath = join(dir, FAKE_LINKED_CLI)
  symlinkSync(path, linkedPath)
  return { dir, path, brokenPath, brokenTarget, linkedPath }
}

export function spec(overrides: Partial<LocalAgentSpec> = {}): LocalAgentSpec {
  return {
    providerId: PROVIDER,
    executable: FAKE_CLI,
    args: [],
    ...overrides,
  }
}
