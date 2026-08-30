import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { attemptId, missionId, pathScope, runId, taskId } from '@agentic/domain'
import type { AttemptLease } from '../types.js'

const exec = promisify(execFile)

export const MISSION = missionId('DA-CORE-001')
export const RUN = runId('01JBXQ7T9K4M2N8P6R3S5V7W9Z')
export const T01 = taskId('T01')
export const T02 = taskId('T02')

export interface TestRepo {
  readonly root: string
  git(...args: string[]): Promise<string>
  write(relative: string, content: string): Promise<void>
  read(relative: string): Promise<string>
  exists(relative: string): Promise<boolean>
  commitAll(message: string): Promise<string>
  cleanup(): Promise<void>
}

const GITIGNORE = ['node_modules/', '.agentic/', '.env', ''].join('\n')

export async function createTestRepo(seed = true): Promise<TestRepo> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentic-ws-')))
  const run = async (...args: string[]): Promise<string> => {
    const { stdout } = await exec('git', args, { cwd: root, encoding: 'utf8' })
    return stdout.trim()
  }
  const write = async (relative: string, content: string): Promise<void> => {
    const target = join(root, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
  const repo: TestRepo = {
    root,
    git: run,
    write,
    read: (relative) => readFile(join(root, relative), 'utf8'),
    exists: async (relative) =>
      access(join(root, relative)).then(
        () => true,
        () => false,
      ),
    commitAll: async (message) => {
      await run('add', '-A')
      await run('commit', '--no-verify', '-m', message)
      return run('rev-parse', 'HEAD')
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
  if (seed) {
    await run('init', '-q', '-b', 'main')
    await run('config', 'user.name', 'Agentic Test')
    await run('config', 'user.email', 'test@example.invalid')
    await run('config', 'commit.gpgsign', 'false')
    await write('.gitignore', GITIGNORE)
    await write('README.md', 'base\n')
    await write('packages/a/a.ts', 'export const a = 1\n')
    await write('packages/b/b.ts', 'export const b = 1\n')
    await repo.commitAll('init')
  }
  return repo
}

export interface LeaseOptions {
  readonly task?: string
  readonly attempt?: number
  readonly touches?: readonly string[]
  readonly deny?: readonly string[]
}

export function lease(options: LeaseOptions = {}): AttemptLease {
  const task = taskId(options.task ?? 'T01')
  const attempt = options.attempt ?? 1
  return {
    runId: RUN,
    taskId: task,
    attemptId: attemptId(`${RUN}:${task}:a${attempt}`),
    kind: 'git-worktree',
    missionId: MISSION,
    attemptNumber: attempt,
    touches: (options.touches ?? ['packages/a/']).map(pathScope),
    denyPaths: (options.deny ?? ['.agentic/']).map(pathScope),
  }
}

export function sharedLease(options: LeaseOptions = {}): AttemptLease {
  return { ...lease(options), kind: 'shared' }
}
