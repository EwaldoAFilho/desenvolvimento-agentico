import { spawnSync } from 'node:child_process'
import nodeProcess from 'node:process'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ATTEMPT_ID,
  cleanupWorkspaces,
  ENV_ALLOW,
  envSource,
  makeGate,
  makeWorkspace,
  nodeCommand,
  RUN_ID,
  writeMarker,
} from './__fixtures__/gate-fixtures.js'
import { describeGate, describeGateScript, shellQuote } from './describe.js'
import { GateRunner } from './runner.js'

const POSIX = nodeProcess.platform !== 'win32'

afterAll(() => {
  cleanupWorkspaces()
})

function runner(): GateRunner {
  return new GateRunner({ envSource: envSource(), newId: () => 'gate_fixo' })
}

describe('shellQuote', () => {
  it('deixa caminho simples sem aspas', () => {
    expect(shellQuote('/tmp/agentic/T07')).toBe('/tmp/agentic/T07')
  })

  it('protege espaco e aspas simples', () => {
    expect(shellQuote('/tmp/com espaco')).toBe("'/tmp/com espaco'")
    expect(shellQuote("/tmp/ma'aspas")).toBe("'/tmp/ma'\\''aspas'")
  })
})

describe('describeGate', () => {
  it('devolve a linha exata com o cwd, na ordem', async () => {
    const workspace = makeWorkspace()
    const execution = await runner().run({
      gate: makeGate([
        { run: nodeCommand('process.exit(0)') },
        { run: nodeCommand('process.exit(7)') },
      ]),
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      envAllow: ENV_ALLOW,
    })
    const repro = describeGate(execution)
    expect(repro.map((item) => item.index)).toEqual([0, 1])
    expect(repro[0]?.line).toBe(`cd ${workspace} && ${nodeCommand('process.exit(0)')}`)
    expect(repro.every((item) => item.ran)).toBe(true)
  })

  it('inclui os comandos que o fail-fast nao executou, marcados como nao executados', async () => {
    const workspace = makeWorkspace()
    const execution = await runner().run({
      gate: makeGate([
        { run: nodeCommand('process.exit(3)') },
        { run: writeMarker('nunca.txt', 'x') },
      ]),
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    const repro = describeGate(execution)
    expect(repro).toHaveLength(2)
    expect(repro[0]).toMatchObject({ ran: true, exitCode: 3 })
    expect(repro[1]).toMatchObject({ ran: false, exitCode: null })
    expect(repro[1]?.line).toContain(writeMarker('nunca.txt', 'x'))
  })

  it.runIf(POSIX)('a linha devolvida reproduz o mesmo exit code no terminal', async () => {
    const workspace = makeWorkspace()
    const execution = await runner().run({
      gate: makeGate([{ run: nodeCommand('process.exit(7)') }]),
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    const line = describeGate(execution)[0]?.line ?? ''
    const replay = spawnSync('sh', ['-c', line], { encoding: 'utf8' })
    expect(replay.status).toBe(execution.results[0]?.exitCode)
    expect(replay.status).toBe(7)
  })

  it.runIf(POSIX)('a linha reproduz tambem o cwd e a saida observada', async () => {
    const workspace = makeWorkspace()
    const execution = await runner().run({
      gate: makeGate([{ run: nodeCommand('console.log(process.cwd())') }]),
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    const line = describeGate(execution)[0]?.line ?? ''
    const replay = spawnSync('sh', ['-c', line], { encoding: 'utf8' })
    expect(replay.stdout.trim()).toBe(workspace)
    expect(replay.stdout).toBe(execution.results[0]?.stdout.text)
  })
})

describe('describeGateScript', () => {
  it('monta um bloco colavel com cabecalho de contexto', async () => {
    const workspace = makeWorkspace()
    const execution = await runner().run({
      gate: makeGate([
        { run: nodeCommand('process.exit(1)') },
        { run: writeMarker('nunca.txt', 'x') },
      ]),
      scope: 'mission',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    const script = describeGateScript(execution)
    expect(script).toContain('# gate unit (mission) — FAIL')
    expect(script).toContain('# env allowlist: PATH, HOME')
    expect(script).toContain(`cd ${workspace} && ${nodeCommand('process.exit(1)')}   # exit 1`)
    expect(script).toContain('# nao executado (fail-fast):')
  })
})
