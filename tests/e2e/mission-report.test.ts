import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import nodeProcess from 'node:process'
import { fileURLToPath } from 'node:url'
import type { MissionReport } from '@agentic/orchestrator'
import { renderMissionReport } from '@agentic/orchestrator'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMissionHarness, type MissionHarness } from './support/harness.js'

/**
 * Relatorio final da missao (UC6). Responde quem fez, quando, o que mudou e qual evidencia
 * concluiu — com o caminho critico RECALCULADO pelas duracoes observadas, nao pelas
 * estimativas do plano.
 */

const here = dirname(fileURLToPath(import.meta.url))
const ARTEFATO = resolve(here, '../../docs/missions/EXEMPLO-001-report.md')

const PREAMBULO = [
  '<!--',
  'Artefato de exemplo. Gerado pelo E2E do fixture examples/estoque-cli:',
  '',
  '    AGENTIC_WRITE_REPORT=1 npx vitest run --project e2e tests/e2e/mission-report.test.ts',
  '',
  'O run foi executado com agentes in-process roteirizados (nenhuma CLI real, nenhuma quota)',
  'sobre um clone temporario do fixture — por isso os caminhos citados apontam para /tmp.',
  'O conteudo abaixo e a saida literal de `renderMissionReport`, sem edicao manual.',
  '-->',
  '',
].join('\n')

let harness: MissionHarness
let report: MissionReport
let markdown: string
let duracoes: Map<string, number>

beforeAll(async () => {
  harness = await createMissionHarness({ safetyIntervalMs: 0 })
  await harness.start()
  await harness.drain()
  report = await harness.plane.generateMissionReport(harness.runId)
  markdown = renderMissionReport(report)
  duracoes = new Map(
    (await harness.tasks()).map((task) => [
      String(task.taskId),
      task.startedAt !== undefined && task.finishedAt !== undefined
        ? task.finishedAt.getTime() - task.startedAt.getTime()
        : 0,
    ]),
  )

  if (nodeProcess.env.AGENTIC_WRITE_REPORT !== undefined) {
    await mkdir(dirname(ARTEFATO), { recursive: true })
    await writeFile(ARTEFATO, `${PREAMBULO}${markdown}`, 'utf8')
  }
}, 240_000)

afterAll(async () => {
  await harness?.cleanup()
})

describe('conteudo do relatorio', () => {
  it('conta tasks, tentativas, retries e reprovacoes de review', () => {
    expect(report.status).toBe('COMPLETED')
    expect(report.tasks).toEqual({ total: 8, done: 8, skipped: 0, cancelled: 0, blocked: 0 })
    expect(report.attempts).toBe(8)
    expect(report.retries).toBe(0)
    expect(report.reviewFailures).toBe(0)
    expect(report.retriedTasks).toEqual([])
    expect(report.blockages).toEqual([])
  })

  it('registra o resultado do mission gate e o wall time do run', () => {
    expect(report.missionGate).toEqual({ gateId: 'mission', status: 'PASS' })
    expect(report.wallTimeMs).toBeGreaterThan(0)
  })

  it('recalcula o caminho critico com as duracoes observadas', () => {
    const caminho = report.criticalPath.tasks.map(String)
    expect(caminho.length).toBeGreaterThanOrEqual(2)

    // Todo par consecutivo do caminho e uma aresta declarada do DAG.
    const arestas = new Set(harness.compiled.edges.map((edge) => `${edge.from}->${edge.to}`))
    for (let index = 1; index < caminho.length; index += 1) {
      expect(arestas.has(`${caminho[index - 1]}->${caminho[index]}`), caminho.join('->')).toBe(true)
    }

    // A duracao e a SOMA do que foi medido nas tasks do caminho — nao a soma dos estimates.
    const somaObservada = caminho.reduce((total, taskId) => total + (duracoes.get(taskId) ?? 0), 0)
    expect(report.criticalPath.durationMs).toBe(somaObservada)
    expect(report.criticalPath.durationMs).toBeGreaterThan(0)
    expect(report.criticalPath.durationMs).toBeLessThanOrEqual(report.wallTimeMs)
    expect(report.criticalPath.durationMs).not.toBe(harness.compiled.criticalPath.length)
  })

  it('lista as tasks mais demoradas com as duracoes que foram medidas', () => {
    expect(report.slowestTasks).toHaveLength(5)
    for (const task of report.slowestTasks) {
      expect(task.durationMs).toBe(duracoes.get(String(task.taskId)))
      expect(task.title.length).toBeGreaterThan(0)
    }
    const ordenadas = [...report.slowestTasks].sort((a, b) => b.durationMs - a.durationMs)
    expect(report.slowestTasks).toEqual(ordenadas)
  })

  it('cita evidencia reproduzivel: comando exato, cwd e exit code', () => {
    const tarefa = report.evidence.filter((item) => item.scope === 'task')
    const missao = report.evidence.filter((item) => item.scope === 'mission')
    // Seis tasks com o perfil `unit`, a T08 com o perfil da missao (dois comandos).
    expect(tarefa).toHaveLength(8)
    expect(missao).toHaveLength(2)

    for (const item of report.evidence) {
      expect(item.exitCode, item.command).toBe(0)
      expect(item.status).toBe('PASS')
      expect(item.line.startsWith(`cd ${item.cwd}`) || item.line.startsWith("cd '")).toBe(true)
      expect(item.line).toContain(item.command)
    }
    expect(tarefa.map((item) => item.command)).toContain('node tests/run.js')
    expect(missao.some((item) => item.command.startsWith('node -e'))).toBe(true)
  })
})

describe('versao markdown do relatorio', () => {
  it('tem as secoes que o humano audita', () => {
    expect(markdown).toContain('# Relatorio da missao EXEMPLO-001')
    expect(markdown).toContain('- resultado: **COMPLETED**')
    expect(markdown).toContain('- tasks concluidas: 8/8')
    expect(markdown).toContain('mission PASS')
    expect(markdown).toContain('## Caminho critico real')
    expect(markdown).toContain('## Tasks mais demoradas')
    expect(markdown).toContain('## Tasks com retry')
    expect(markdown).toContain('## Bloqueios')
    expect(markdown).toContain('## Evidencia citavel')
  })

  it('traz os comandos de gate colaveis no terminal', () => {
    expect(markdown).toContain('node tests/run.js')
    expect(markdown).toContain('exit 0')
    expect(markdown.split('```sh').length - 1).toBe(report.evidence.length)
  })
})
