import type { EventDto } from '@agentic/schemas'
import { describe, expect, it } from 'vitest'
import {
  makeManyLogsTaskDetail,
  makeNoChangesTaskDetail,
  makeNoChangesWithLogTaskDetail,
  makeTaskDetail,
  makeTruncatedLogTaskDetail,
} from '../__fixtures__/snapshot.js'
import { agentLogArtifacts, agentLogView, MAX_LISTED_LOGS } from './agent-log.js'

const SEM_CAMINHO: EventDto = {
  seq: 999,
  ts: '2026-01-08T12:50:00.000Z',
  type: 'attempt.log_persisted',
  actor: { kind: 'orchestrator' },
  taskId: 'T09',
  payload: { role: 'execute', bytes: 10, truncated: false },
}

describe('artefatos de log do agente', () => {
  it('le caminho, papel, tamanho e truncagem do evento que gravou o artefato', () => {
    const [artifact] = agentLogArtifacts(makeNoChangesWithLogTaskDetail().events)
    expect(artifact?.role).toBe('execute')
    expect(artifact?.path).toBe('.agentic/runs/01J8ZC/attempts/T02-a2/agent.log.jsonl')
    expect(artifact?.bytes).toBe(18_442)
    expect(artifact?.truncated).toBe(false)
  })

  it('lista do mais recente para o mais antigo — o log da tentativa em curso vem primeiro', () => {
    const artifacts = agentLogArtifacts(makeTruncatedLogTaskDetail().events)
    expect(artifacts.map((artifact) => artifact.role)).toEqual(['review', 'execute'])
  })

  it('evento sem caminho nao vira artefato inventado', () => {
    expect(agentLogArtifacts([SEM_CAMINHO])).toEqual([])
  })
})

describe('leitura do log na interface', () => {
  it('log truncado diz que a saida NAO esta completa', () => {
    const view = agentLogView(makeTruncatedLogTaskDetail())
    expect(view.truncated).toBe(true)
    expect(view.notice).toContain('truncado')
    expect(view.notice).toContain('NÃO está completa')
  })

  it('saida de comando de gate truncada tambem e anunciada', () => {
    const base = makeTaskDetail()
    const task = {
      ...base,
      quality: {
        ...base.quality,
        commandResults: base.quality.commandResults.map((result) => ({
          ...result,
          truncated: true,
        })),
      },
    }
    const view = agentLogView(task)
    expect(view.truncatedCommands.map((command) => command.command)).toEqual(['npm test -w ui'])
    expect(view.notice).toContain('truncada')
  })

  it('sem truncagem, nao promete completude que ninguem mediu', () => {
    const view = agentLogView(makeNoChangesWithLogTaskDetail())
    expect(view.truncated).toBe(false)
    expect(view.notice).toBe('nenhum artefato foi marcado como truncado pelo control plane')
  })

  it('sem log persistido, diz que nao existe', () => {
    const view = agentLogView(makeNoChangesTaskDetail())
    expect(view.artifacts).toEqual([])
    expect(view.empty).toBe(true)
    expect(view.notice).toBe('nenhum log do agente foi persistido para esta task')
  })

  it('soma os bytes dos artefatos conhecidos', () => {
    expect(agentLogView(makeTruncatedLogTaskDetail()).totalBytes).toBe(4_194_304 + 2_048)
  })

  it('saida grande nao vira lista infinita: a tela tem teto e diz quantos ficaram de fora', () => {
    const view = agentLogView(makeManyLogsTaskDetail(60))
    expect(view.artifacts).toHaveLength(MAX_LISTED_LOGS)
    expect(view.hiddenArtifacts).toBe(40)
  })

  it('o teto vale tambem para as referencias citaveis', () => {
    const base = makeTaskDetail()
    const commandResults = Array.from({ length: 30 }, (_, index) => ({
      command: `npm test -w pacote-${index}`,
      cwd: '/tmp/worktree',
      exitCode: 0,
      durationMs: 10,
      stdoutRef: `runs/01J8ZC/T09/a2/test-${index}.log`,
      truncated: false,
    }))
    const view = agentLogView({ ...base, quality: { ...base.quality, commandResults } }, 5)
    // 30 saidas de comando + a evidencia do gate: 31 referencias, 5 na tela.
    expect(view.refs).toHaveLength(5)
    expect(view.hiddenRefs).toBe(26)
  })
})

describe('artefato e referencia nao se repetem', () => {
  it('o caminho do log listado como artefato sai da lista de referencias', () => {
    const view = agentLogView(makeNoChangesWithLogTaskDetail())
    expect(view.artifacts.map((artifact) => artifact.path)).toContain(
      '.agentic/runs/01J8ZC/attempts/T02-a2/agent.log.jsonl',
    )
    expect(view.refs.map((ref) => ref.ref)).not.toContain(
      '.agentic/runs/01J8ZC/attempts/T02-a2/agent.log.jsonl',
    )
  })
})
