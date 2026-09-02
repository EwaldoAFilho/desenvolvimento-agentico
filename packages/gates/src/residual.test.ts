import { afterAll, describe, expect, it } from 'vitest'
import {
  cleanupWorkspaces,
  ENV_ALLOW,
  envSource,
  makeGate,
  makeWorkspace,
  nodeCommand,
  RUN_ID,
} from './__fixtures__/gate-fixtures.js'
import { GateRunner } from './runner.js'

/**
 * STABILITY-SLICE-004B (C3) — um gate que deixa grupo de processos vivo precisa dizer QUAL,
 * nao so QUE deixou. `residualProcess: true` sem o pid nao permite a quem encerra sondar de
 * novo na tentativa seguinte de `stop`; e "nao lembro mais" e exatamente o que I15 proibe.
 */

afterAll(() => {
  cleanupWorkspaces()
})

const TETOS = { killGraceMs: 200, groupGraceMs: 100 }

describe('residuo de grupo de processos no gate', () => {
  it('comando cujo grupo sobrevive ao teto: residualProcess=true, groupTerminated=false e o pid do lider no registro', async () => {
    const result = await new GateRunner({
      envSource: envSource(),
      processDeps: { ...TETOS, probeGroup: () => true },
    }).run({
      gate: makeGate([{ run: nodeCommand('process.exit(0)') }]),
      scope: 'task',
      cwd: makeWorkspace(),
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    expect(result.residualProcess).toBe(true)
    const [record] = result.results
    expect(record).toMatchObject({ exitCode: 0, groupTerminated: false })
    expect(typeof record?.pid).toBe('number')
    // A medicao continua valendo: o comando saiu 0. O residuo e assunto do encerramento.
    expect(result.status).toBe('PASS')
  }, 20_000)

  it('sonda real: o grupo assenta, residualProcess=false, e o pid continua no registro', async () => {
    const result = await new GateRunner({ envSource: envSource(), processDeps: TETOS }).run({
      gate: makeGate([{ run: nodeCommand('process.exit(0)') }]),
      scope: 'task',
      cwd: makeWorkspace(),
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    expect(result.residualProcess).toBe(false)
    expect(result.results[0]).toMatchObject({ groupTerminated: true })
    expect(typeof result.results[0]?.pid).toBe('number')
  }, 20_000)

  it('comando recusado antes de existir nao tem pid nem residuo', async () => {
    const result = await new GateRunner({ envSource: envSource(), processDeps: TETOS }).run({
      gate: makeGate([{ run: '' }]),
      scope: 'task',
      cwd: makeWorkspace(),
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    expect(result.residualProcess).toBe(false)
    expect(result.results[0]).toMatchObject({ pid: null, groupTerminated: true })
  })
})
