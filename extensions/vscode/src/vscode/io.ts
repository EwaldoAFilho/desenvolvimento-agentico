import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { access, readdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import process from 'node:process'
import type { DiscoveryDeps } from '../core/discovery.js'
import type { ExecResult, ProjectIo } from '../core/project.js'
import type { ToolchainIo } from '../core/toolchain.js'

/**
 * As dependencias de sistema operacional, num lugar so. O nucleo (`src/core`) recebe
 * interfaces e e testado sem SO; este arquivo e a implementacao real que o extension host
 * usa.
 */
export function exec(command: string, args: readonly string[], cwd: string): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    execFile(
      command,
      [...args],
      { cwd, timeout: 15_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(error)
          return
        }
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export function canonical(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

export const projectIo: ProjectIo = {
  readFile: (path) => readFile(path, 'utf8').catch(() => undefined),
  realpath: (path) => realpath(path).catch(() => path),
  exec,
}

export const toolchainIo: ToolchainIo = {
  exists,
  readdir: (path) => readdir(path),
  realpath: (path) => realpath(path).catch(() => path),
  exec,
  env: process.env,
  homedir: homedir(),
  platform: process.platform,
}

/** Sinal 0 nao entrega nada: so pergunta se o processo existe. `EPERM` = existe e nao e nosso. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const PROBE_TIMEOUT_MS = 750

export async function fetchHealth(
  url: string,
): Promise<DiscoveryDeps extends { fetchHealth: (u: string) => Promise<infer R> } ? R : never> {
  try {
    const response = await fetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    return (await response.json()) as { service?: unknown; repoRoot?: unknown }
  } catch {
    return undefined
  }
}

export const discoveryDeps: DiscoveryDeps = {
  readFile: (path) => readFile(path, 'utf8').catch(() => undefined),
  alive: processAlive,
  fetchHealth,
  canonical,
}

export function sendSignal(pid: number, signal: 'SIGTERM'): boolean {
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
