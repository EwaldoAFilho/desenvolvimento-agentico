import { describe, expect, it } from 'vitest'
import {
  makeNoChangesTaskDetail,
  makeNoChangesWithLogTaskDetail,
  makeTaskDetail,
} from '../__fixtures__/snapshot.js'
import { noChangesViewOf } from './no-changes.js'

function textOf(task: ReturnType<typeof makeNoChangesTaskDetail>): string {
  return (noChangesViewOf(task)?.statements ?? []).map((statement) => statement.text).join(' | ')
}

describe('NO_CHANGES explicado', () => {
  it('afirma que o agente concluiu a investigacao', () => {
    expect(textOf(makeNoChangesTaskDetail())).toContain('o agente concluiu a investigação')
  })

  it('afirma que nenhuma alteracao foi observada, com o diff medido', () => {
    expect(textOf(makeNoChangesTaskDetail())).toContain(
      'nenhuma alteração observada no repositório — 0 arquivo(s), +0 −0',
    )
  })

  it('afirma que a task NAO foi marcada DONE automaticamente', () => {
    expect(textOf(makeNoChangesTaskDetail())).toContain('não foi marcada DONE automaticamente')
  })

  it('nao cria estado novo: o desfecho continua sendo o que o dominio registrou', () => {
    const task = makeNoChangesTaskDetail()
    const view = noChangesViewOf(task)
    expect(view?.outcome).toBe(task.status)
    expect(view?.failureCode).toBe('NO_CHANGES')
    expect(view?.failureDetail).toBe('nenhum arquivo alterado na worktree')
  })

  it('aponta o log da tentativa quando ele existe — foi o que explicou o caso real', () => {
    expect(textOf(makeNoChangesWithLogTaskDetail())).toContain(
      '.agentic/runs/01J8ZC/attempts/T02-a2/agent.log.jsonl',
    )
  })

  it('sem log persistido, admite que nao ha registro do que o agente concluiu', () => {
    expect(textOf(makeNoChangesTaskDetail())).toContain('nenhum log do agente foi persistido')
  })

  it('diz que o gate nao chegou a rodar', () => {
    expect(noChangesViewOf(makeNoChangesTaskDetail())?.gate.reach).toBe('not-reached')
  })

  it('reconhece o NO_CHANGES da tentativa quando a task ja foi reescalonada', () => {
    const base = makeNoChangesTaskDetail()
    const view = noChangesViewOf({ ...base, status: 'RETRY', failure: undefined })
    expect(view?.outcome).toBe('RETRY')
    expect(view?.statements).toHaveLength(4)
  })

  it('falha de outro codigo nao vira leitura de NO_CHANGES', () => {
    expect(noChangesViewOf(makeTaskDetail())).toBeUndefined()
  })

  /**
   * A tentativa 1 falhou por NO_CHANGES, a 2 alterou arquivos e reprovou no gate. Ler o
   * NO_CHANGES antigo faria a tela afirmar "nenhuma alteracao observada" ao lado de um diff
   * de 2 arquivos, contradizendo o desfecho que o dominio registrou.
   */
  it('NO_CHANGES antigo nao sobrevive a uma falha mais nova de outro codigo', () => {
    const base = makeTaskDetail()
    const [first, second] = base.attempts
    const task = {
      ...base,
      status: 'FAILED' as const,
      failure: { failureCode: 'GATE_FAILED', detail: 'npm test -w ui saiu 1' },
      attempts: [
        { ...first, failure: { failureCode: 'NO_CHANGES' } },
        { ...second, result: 'FAIL' as const, failure: { failureCode: 'GATE_FAILED' } },
      ],
    } as ReturnType<typeof makeTaskDetail>
    expect(noChangesViewOf(task)).toBeUndefined()
  })
})
