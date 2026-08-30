import { rmSync } from 'node:fs'
import type { LocalAgentRuntimeDeps } from '@agentic/agent-runtime'
import { createLocalAgentRuntime } from '@agentic/agent-runtime'
import type { FakeCliBundle } from './__fixtures__/fake-cli.js'
import { makeFakeCliBundle, makeTempDir } from './__fixtures__/fake-cli.js'
import { CapacityBook } from './capacity.js'
import { ClaudeCodeCliProvider } from './claude-code.js'
import { CodexCliProvider } from './codex.js'
import type {
  ContractCreateOptions,
  ContractScenario,
  ContractSetup,
  ProviderContractHarness,
} from './contract.suite.js'
import {
  CONTRACT_CWD_FILE,
  CONTRACT_STDERR_MARK,
  CONTRACT_STDOUT_MARK,
  runProviderContract,
} from './contract.suite.js'
import type { LocalCliAgentProvider, LocalCliProviderOptions } from './local-cli.js'
import type { MockScript } from './mock.js'
import { MOCK_CWD_TOKEN, MockAgentProvider } from './mock.js'

/** Worktree nova por cenario: o caso de cwd le arquivo e nenhum caso herda sujeira. */
function worktree(): { path: string; cleanup: () => void } {
  const path = makeTempDir('agentic-worktree-')
  return {
    path,
    cleanup: () => {
      rmSync(path, { recursive: true, force: true })
    },
  }
}

function bookFor(id: string, options: ContractCreateOptions | undefined): CapacityBook | undefined {
  const max = options?.maxConcurrent
  return max === undefined ? undefined : new CapacityBook({ [id]: max })
}

const MOCK_SCRIPTS: Readonly<Record<ContractScenario, MockScript>> = {
  success: {
    default: {
      status: 'completed',
      claims: { summary: 'mock: tarefa concluida conforme roteiro' },
      writeFiles: { [CONTRACT_CWD_FILE]: MOCK_CWD_TOKEN },
      stdout: [CONTRACT_STDOUT_MARK],
      stderr: [CONTRACT_STDERR_MARK],
    },
  },
  failure: {
    default: {
      status: 'failed',
      claims: { summary: 'mock: o agente reportou falha' },
      stdout: [CONTRACT_STDOUT_MARK],
      stderr: [CONTRACT_STDERR_MARK],
    },
  },
  slow: {
    default: {
      status: 'completed',
      claims: { summary: 'mock: trabalho longo' },
      delayMs: 30_000,
      stdout: [CONTRACT_STDOUT_MARK],
    },
  },
  unavailable: {
    default: { status: 'completed', claims: { summary: 'mock: nunca chega a rodar' } },
  },
  'not-ready': {
    default: { status: 'completed', claims: { summary: 'mock: nunca chega a rodar' } },
  },
}

const mockHarness: ProviderContractHarness = {
  create(scenario, options): Promise<ContractSetup> {
    const ws = worktree()
    const book = bookFor('mock', options)
    const provider = new MockAgentProvider({
      script: MOCK_SCRIPTS[scenario],
      installed: scenario !== 'unavailable',
      ready: scenario !== 'not-ready',
      ...(book === undefined ? {} : { capacity: book }),
    })
    return Promise.resolve({ provider, workspace: ws.path, cleanup: ws.cleanup })
  },
}

function commandFor(bundle: FakeCliBundle, scenario: ContractScenario): string {
  if (scenario === 'failure') return bundle.falha
  if (scenario === 'slow') return bundle.lento
  if (scenario === 'unavailable') return bundle.ausente
  if (scenario === 'not-ready') return bundle.semLogin
  return bundle.ok
}

/** Duble de processo: `command` aponta para o script falso, jamais para a CLI real. */
function cliHarness(
  id: string,
  build: (options: LocalCliProviderOptions) => LocalCliAgentProvider,
): ProviderContractHarness {
  let bundle: FakeCliBundle | null = null
  let probeDir: string | null = null
  return {
    create(scenario, options): Promise<ContractSetup> {
      const primeiro = bundle === null
      if (bundle === null) bundle = makeFakeCliBundle()
      if (probeDir === null) probeDir = makeTempDir('agentic-probe-')
      const cli = bundle
      const probe = probeDir
      const deps: LocalAgentRuntimeDeps = {
        platform: 'linux',
        probeCwd: probe,
        probeEnv: cli.env,
        probeTimeoutMs: 5_000,
        processDeps: { killGraceMs: 200, closeGraceMs: 300 },
      }
      const ws = worktree()
      const book = bookFor(id, options)
      const provider = build({
        command: commandFor(cli, scenario),
        runtime: createLocalAgentRuntime(deps),
        ...(book === undefined ? {} : { capacity: book }),
      })
      return Promise.resolve({
        provider,
        workspace: ws.path,
        env: cli.env,
        cleanup: () => {
          ws.cleanup()
          if (!primeiro) return
          cli.cleanup()
          rmSync(probe, { recursive: true, force: true })
        },
      })
    },
  }
}

runProviderContract('mock', () => mockHarness)
runProviderContract('claude-code-cli', () =>
  cliHarness('claude-code', (options) => new ClaudeCodeCliProvider(options)),
)
runProviderContract('codex-cli', () =>
  cliHarness('codex', (options) => new CodexCliProvider(options)),
)
