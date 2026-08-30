import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gateStatusFromResults } from '@agentic/domain'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ATTEMPT_ID,
  appendMarker,
  cleanupWorkspaces,
  ENV_ALLOW,
  envSource,
  makeGate,
  makeWorkspace,
  nodeCommand,
  RUN_ID,
  writeMarker,
} from './__fixtures__/gate-fixtures.js'
import { isGateError } from './errors.js'
import { GateRunner } from './runner.js'
import type { GateRunRequest } from './types.js'

const OK = nodeCommand('process.exit(0)')
const FAIL_2 = nodeCommand('process.exit(2)')

function runner(extra: Record<string, string> = {}): GateRunner {
  return new GateRunner({ envSource: envSource(extra) })
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (error) {
    return isGateError(error) ? error.code : 'NAO_E_GATE_ERROR'
  }
  return 'NAO_LANCOU'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

afterAll(() => {
  cleanupWorkspaces()
})

describe('GateRunner: veredito', () => {
  it('comando que sai 0 aprova o gate', async () => {
    const workspace = makeWorkspace()
    const execution = await runner().run({
      gate: makeGate([{ run: OK }]),
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      envAllow: ENV_ALLOW,
    })
    expect(execution.status).toBe('PASS')
    expect(execution.results[0]?.exitCode).toBe(0)
    expect(execution.skipped).toEqual([])
  })

  it('comando que sai diferente de 0 reprova e registra o exit code', async () => {
    const workspace = makeWorkspace()
    const execution = await runner().run({
      gate: makeGate([{ run: FAIL_2 }]),
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    expect(execution.status).toBe('FAIL')
    expect(execution.results[0]?.exitCode).toBe(2)
    expect(execution.results[0]?.timedOut).toBe(false)
  })

  it('o veredito e recomputavel a partir dos resultados registrados', async () => {
    const workspace = makeWorkspace()
    const gate = makeGate([{ run: OK }, { run: FAIL_2 }])
    const execution = await runner().run({
      gate,
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    expect(gateStatusFromResults(gate.commands, execution.results)).toBe(execution.status)
  })

  it('registra a linha exata, o cwd, a duracao e o inicio de cada comando', async () => {
    const workspace = makeWorkspace()
    const before = Date.now()
    const execution = await runner().run({
      gate: makeGate([{ run: OK }]),
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    const record = execution.results[0]
    expect(record?.command).toBe(OK)
    expect(record?.cwd).toBe(workspace)
    expect(record?.argv[0]).toBe('node')
    expect(record?.durationMs).toBeGreaterThanOrEqual(0)
    expect(record?.startedAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(record?.finishedAt.getTime()).toBeGreaterThanOrEqual(record?.startedAt.getTime() ?? 0)
    expect(record?.truncated).toBe(false)
  })

  it('carrega a identidade da execucao', async () => {
    const workspace = makeWorkspace()
    const execution = await new GateRunner({
      envSource: envSource(),
      newId: () => 'gate_fixo',
    }).run({
      gate: makeGate([{ run: OK }]),
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      envAllow: ENV_ALLOW,
    })
    expect(execution.id).toBe('gate_fixo')
    expect(execution.gateId).toBe('unit')
    expect(execution.runId).toBe(RUN_ID)
    expect(execution.attemptId).toBe(ATTEMPT_ID)
    expect(execution.scope).toBe('task')
    expect(execution.finishedAt.getTime()).toBeGreaterThanOrEqual(execution.startedAt.getTime())
  })

  it('gate de missao roda sem tentativa', async () => {
    const workspace = makeWorkspace()
    const execution = await runner().run({
      gate: makeGate([{ run: OK }]),
      scope: 'mission',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    expect(execution.scope).toBe('mission')
    expect(execution.attemptId).toBeUndefined()
    expect(execution.status).toBe('PASS')
  })
})

describe('GateRunner: ordem e fail-fast', () => {
  it('executa os comandos na ordem declarada', async () => {
    const workspace = makeWorkspace()
    const execution = await runner().run({
      gate: makeGate([
        { run: appendMarker('ordem.txt', 'a') },
        { run: appendMarker('ordem.txt', 'b') },
        { run: appendMarker('ordem.txt', 'c') },
      ]),
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    expect(execution.status).toBe('PASS')
    expect(readFileSync(join(workspace, 'ordem.txt'), 'utf8')).toBe('abc')
    expect(execution.results.map((record) => record.index)).toEqual([0, 1, 2])
  })

  it('o primeiro obrigatorio que falha interrompe os seguintes', async () => {
    const workspace = makeWorkspace()
    const execution = await runner().run({
      gate: makeGate([
        { run: appendMarker('ordem.txt', 'a') },
        { run: FAIL_2 },
        { run: writeMarker('nunca.txt', 'x') },
        { run: writeMarker('nunca2.txt', 'x'), required: false },
      ]),
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    expect(execution.status).toBe('FAIL')
    expect(execution.results).toHaveLength(2)
    // prova de que nao rodaram: eles escreveriam estes arquivos
    expect(existsSync(join(workspace, 'nunca.txt'))).toBe(false)
    expect(existsSync(join(workspace, 'nunca2.txt'))).toBe(false)
  })

  it('os comandos nao executados ficam registrados como skipped', async () => {
    const workspace = makeWorkspace()
    const execution = await runner().run({
      gate: makeGate([
        { run: FAIL_2 },
        { run: writeMarker('nunca.txt', 'x') },
        { run: writeMarker('nunca2.txt', 'x'), required: false, cwd: 'sub' },
      ]),
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    expect(execution.skipped.map((skip) => skip.index)).toEqual([1, 2])
    expect(execution.skipped[0]).toMatchObject({ reason: 'FAIL_FAST', after: 0, required: true })
    expect(execution.skipped[1]).toMatchObject({ required: false, cwd: join(workspace, 'sub') })
    expect(execution.skipped[0]?.command).toBe(writeMarker('nunca.txt', 'x'))
  })

  it('required: false que falha registra a falha sem reprovar o gate', async () => {
    const workspace = makeWorkspace()
    const execution = await runner().run({
      gate: makeGate([{ run: nodeCommand('process.exit(1)'), required: false }, { run: OK }]),
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    expect(execution.status).toBe('PASS')
    expect(execution.results[0]?.exitCode).toBe(1)
    expect(execution.results[0]?.required).toBe(false)
  })

  it('required: false que falha nao interrompe os seguintes', async () => {
    const workspace = makeWorkspace()
    const execution = await runner().run({
      gate: makeGate([
        { run: nodeCommand('process.exit(1)'), required: false },
        { run: writeMarker('depois.txt', 'x') },
      ]),
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    expect(execution.results).toHaveLength(2)
    expect(execution.skipped).toEqual([])
    expect(existsSync(join(workspace, 'depois.txt'))).toBe(true)
  })
})

describe('GateRunner: timeout', () => {
  it('comando que estoura o tempo vira TIMEOUT e o processo e morto', async () => {
    const workspace = makeWorkspace()
    const lento = nodeCommand(
      "setTimeout(function(){require('node:fs').writeFileSync('tarde.txt','x')}, 1500)",
    )
    const execution = await runner().run({
      gate: makeGate([{ run: lento, timeoutMs: 300 }, { run: writeMarker('nunca.txt', 'x') }]),
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    expect(execution.status).toBe('TIMEOUT')
    expect(execution.results[0]?.timedOut).toBe(true)
    expect(execution.results[0]?.exitCode).toBeNull()
    expect(execution.skipped.map((skip) => skip.index)).toEqual([1])

    // se tivesse sobrevivido, escreveria o marcador depois do timeout
    await sleep(2000)
    expect(existsSync(join(workspace, 'tarde.txt'))).toBe(false)
  }, 20_000)
})

describe('GateRunner: ambiente', () => {
  it('somente a allowlist chega ao processo', async () => {
    const workspace = makeWorkspace()
    const execution = await runner({ EXTRA_VAR: 'vazou' }).run({
      gate: makeGate([
        { run: nodeCommand("console.log(Object.keys(process.env).sort().join(','))") },
        { run: nodeCommand("console.log(process.env.EXTRA_VAR ?? 'AUSENTE')") },
      ]),
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    expect(execution.results[0]?.stdout.text.trim()).toBe('HOME,PATH')
    expect(execution.results[1]?.stdout.text.trim()).toBe('AUSENTE')
  })

  it('variavel declarada na allowlist chega (contraprova)', async () => {
    const workspace = makeWorkspace()
    const allow = [...ENV_ALLOW, 'EXTRA_VAR']
    const execution = await runner({ EXTRA_VAR: 'visivel-42' }).run({
      gate: makeGate(
        [{ run: nodeCommand("console.log(process.env.EXTRA_VAR ?? 'AUSENTE')") }],
        allow,
      ),
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: allow,
    })
    expect(execution.results[0]?.stdout.text.trim()).toBe('visivel-42')
    expect([...execution.envAllow]).toEqual(allow)
  })

  it('o chamador nao amplia a allowlist do arquivo versionado', async () => {
    const workspace = makeWorkspace()
    const code = await codeOf(() =>
      runner({ EXTRA_VAR: 'vazou' }).run({
        gate: makeGate([{ run: OK }]),
        scope: 'task',
        cwd: workspace,
        runId: RUN_ID,
        envAllow: [...ENV_ALLOW, 'EXTRA_VAR'],
      }),
    )
    expect(code).toBe('GATE_ENV_NOT_ALLOWED')
  })
})

describe('GateRunner: workspace', () => {
  it('o comando roda no workspace informado, nunca na arvore principal', async () => {
    const workspace = makeWorkspace()
    const execution = await runner().run({
      gate: makeGate([{ run: nodeCommand('console.log(process.cwd())') }]),
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    expect(execution.results[0]?.stdout.text.trim()).toBe(workspace)
    expect(execution.cwd).toBe(workspace)
  })

  it('cwd de comando e resolvido relativo ao workspace', async () => {
    const workspace = makeWorkspace()
    mkdirSync(join(workspace, 'apps', 'web'), { recursive: true })
    const execution = await runner().run({
      gate: makeGate([{ run: nodeCommand('console.log(process.cwd())'), cwd: 'apps/web' }]),
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    expect(execution.results[0]?.stdout.text.trim()).toBe(join(workspace, 'apps', 'web'))
  })

  it('cwd que tenta escapar do workspace e recusado e nada roda', async () => {
    const workspace = makeWorkspace()
    const execution = await runner().run({
      gate: makeGate([{ run: writeMarker('fugiu-t07.txt', 'x'), cwd: '..' }]),
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    expect(execution.status).toBe('ERROR')
    expect(execution.results[0]?.error?.code).toBe('GATE_CWD_ESCAPE')
    expect(execution.results[0]?.exitCode).toBeNull()
    expect(execution.results[0]?.argv).toEqual([])
    expect(existsSync(join(dirname(workspace), 'fugiu-t07.txt'))).toBe(false)
  })

  it('workspace relativo e recusado antes de qualquer processo', async () => {
    const code = await codeOf(() =>
      runner().run({
        gate: makeGate([{ run: OK }]),
        scope: 'task',
        cwd: 'worktrees/T07-1',
        runId: RUN_ID,
        envAllow: ENV_ALLOW,
      }),
    )
    expect(code).toBe('GATE_CONFIG_INVALID')
  })

  it('comando com sintaxe de shell nao suportada vira ERROR sem rodar nada', async () => {
    const workspace = makeWorkspace()
    const execution = await runner().run({
      gate: makeGate([{ run: `${writeMarker('pipe.txt', 'x')} | cat` }]),
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    expect(execution.status).toBe('ERROR')
    expect(execution.results[0]?.error?.code).toBe('GATE_COMMAND_SYNTAX')
    expect(existsSync(join(workspace, 'pipe.txt'))).toBe(false)
  })

  it('executavel inexistente vira ERROR com o motivo do sistema', async () => {
    const workspace = makeWorkspace()
    const execution = await runner().run({
      gate: makeGate([{ run: 'comando-que-nao-existe-t07 --versao' }]),
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    expect(execution.status).toBe('ERROR')
    expect(execution.results[0]?.exitCode).toBeNull()
    expect(execution.results[0]?.error?.code).toBe('ENOENT')
  })
})

describe('GateRunner: artefato de saida', () => {
  it('segredo na saida e mascarado antes de virar artefato', async () => {
    const workspace = makeWorkspace()
    const execution = await runner().run({
      gate: makeGate([
        { run: nodeCommand("console.log('API_KEY=super-secret-value')") },
        { run: nodeCommand("console.error('achei sk-abcdefghijklmno no log')") },
      ]),
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    expect(execution.results[0]?.stdout.text.trim()).toBe('API_KEY=[REDACTED]')
    expect(execution.results[0]?.stdout.text).not.toContain('super-secret-value')
    expect(execution.results[1]?.stderr.text.trim()).toBe('achei [REDACTED] no log')
  })

  it('o digest e do stream integral; o artefato tem digest proprio', async () => {
    const workspace = makeWorkspace()
    const execution = await runner().run({
      gate: makeGate([{ run: nodeCommand("console.log('API_KEY=super-secret-value')") }]),
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    const stdout = execution.results[0]?.stdout
    expect(stdout?.digest).toBe(sha256('API_KEY=super-secret-value\n'))
    expect(stdout?.artifactDigest).toBe(sha256('API_KEY=[REDACTED]\n'))
    expect(stdout?.truncated).toBe(false)
  })

  it('saida grande e truncada, e o digest continua sendo do total', async () => {
    const workspace = makeWorkspace()
    const execution = await new GateRunner({ envSource: envSource(), maxOutputBytes: 32 }).run({
      gate: makeGate([{ run: nodeCommand("process.stdout.write('x'.repeat(200))") }]),
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    })
    const record = execution.results[0]
    expect(record?.stdout.text).toBe('x'.repeat(32))
    expect(record?.stdout.truncated).toBe(true)
    expect(record?.truncated).toBe(true)
    expect(record?.stdout.digest).toBe(sha256('x'.repeat(200)))
  })
})

describe('GateRunner: tipos', () => {
  it('P09: a API nao aceita linha de comando solta', async () => {
    const workspace = makeWorkspace()
    const request: GateRunRequest = {
      // @ts-expect-error gate so vem de loadGateProfiles, nunca de uma string
      gate: 'npm run lint',
      scope: 'task',
      cwd: workspace,
      runId: RUN_ID,
      envAllow: ENV_ALLOW,
    }
    await expect(runner().run(request)).rejects.toThrow()
    expect(existsSync(join(workspace, 'node_modules'))).toBe(false)
  })
})
