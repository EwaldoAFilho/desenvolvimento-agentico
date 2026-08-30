import { describe, expect, it } from 'vitest'
import { CLAUDE_CODE_RUN_ARGS } from './claude-code.js'
import { CODEX_RUN_ARGS } from './codex.js'

/**
 * Regressao de um defeito encontrado por SMOKE COM CLI REAL, nao por teste.
 *
 * Os dois adapters despachavam o agente sem lhe conceder permissao de escrita na worktree
 * que o proprio produto criou para ele:
 *   - claude --print recusou gravar por falta de permissao em sessao nao interativa;
 *   - codex exec roda com `sandbox: read-only` por padrao.
 * As CLIs falsas dos testes sempre escreviam, entao nada disso aparecia.
 *
 * Estes testes existem para que remover a permissao volte a quebrar.
 */
describe('permissao de escrita na worktree (achado de smoke real)', () => {
  it('claude despacha em modo nao interativo aceitando edicao de arquivo', () => {
    expect(CLAUDE_CODE_RUN_ARGS).toContain('--print')
    const at = CLAUDE_CODE_RUN_ARGS.indexOf('--permission-mode')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(CLAUDE_CODE_RUN_ARGS[at + 1]).toBe('acceptEdits')
  })

  it('codex despacha com escrita limitada ao workspace', () => {
    expect(CODEX_RUN_ARGS[0]).toBe('exec')
    const at = CODEX_RUN_ARGS.indexOf('--sandbox')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(CODEX_RUN_ARGS[at + 1]).toBe('workspace-write')
  })

  it('nenhum adapter usa o atalho perigoso: a worktree e que e a fronteira', () => {
    const proibidos = [
      '--dangerously-skip-permissions',
      '--allow-dangerously-skip-permissions',
      '--dangerously-bypass-approvals-and-sandbox',
      'danger-full-access',
      'bypassPermissions',
    ]
    for (const flag of proibidos) {
      expect(CLAUDE_CODE_RUN_ARGS).not.toContain(flag)
      expect(CODEX_RUN_ARGS).not.toContain(flag)
    }
  })
})
