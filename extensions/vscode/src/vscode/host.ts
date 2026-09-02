import { type FSWatcher, watch } from 'node:fs'
import { readdir } from 'node:fs/promises'
import process from 'node:process'
import * as vscode from 'vscode'
import { AgenticClient } from '../core/client.js'
import type {
  CompileReportDto,
  MissionListItem,
  ProviderHealthDto,
  RunHeaderDto,
} from '../core/contracts.js'
import { CONTROL_PLANE_FILE_NAME } from '../core/contracts.js'
import { discoverLive } from '../core/discovery.js'
import { launchServe } from '../core/launcher.js'
import { type MissionSummary, missionFilesOnDisk, summarizeMissions } from '../core/missions.js'
import { type DetectedProject, detectProject, messageOf } from '../core/project.js'
import { AgenticService, type ServiceView } from '../core/service.js'
import { childEnv, resolveToolchain } from '../core/toolchain.js'
import type { HomeProject, MissionDetail } from '../webview/protocol.js'
import { discoveryDeps, projectIo, sendSignal, sleep, toolchainIo } from './io.js'
import type { AgenticLog } from './log.js'

/**
 * O que a janela sabe: projeto detectado, ciclo de vida do control plane e os dados lidos
 * por HTTP. Views, comandos e webview leem daqui e reagem a `onDidChange`; ninguem fala com
 * o control plane por conta propria.
 */
export interface HostData {
  readonly providers?: ProviderHealthDto[]
  readonly missions: MissionSummary[]
  readonly runs?: RunHeaderDto[]
  readonly error?: string
  readonly loadedAt?: string
}

const DISCOVERY_POLL_MS = 5_000
const DATA_POLL_MS = 15_000

export class AgenticHost implements vscode.Disposable {
  project: DetectedProject | undefined
  service: AgenticService | undefined
  data: HostData = { missions: [] }
  busy: string | undefined

  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChange = this.changed.event
  private readonly disposables: vscode.Disposable[] = [this.changed]
  private watcher: FSWatcher | undefined
  private pollTimer: NodeJS.Timeout | undefined
  private lastDataAt = 0
  private loading: Promise<void> | undefined
  private readonly reports = new Map<string, CompileReportDto>()
  /** Servicos de projetos anteriores desta janela que ainda possuem um filho vivo. */
  private readonly retired: AgenticService[] = []

  constructor(private readonly log: AgenticLog) {}

  async initialize(): Promise<void> {
    await this.detect()
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.detect().then(() => this.refresh({ data: true }))
      }),
    )
    this.pollTimer = setInterval(() => {
      void this.refresh({ data: Date.now() - this.lastDataAt > DATA_POLL_MS })
    }, DISCOVERY_POLL_MS)
    await this.refresh({ data: true })
  }

  /** Primeira pasta do workspace que tem `.agentic/project.yaml` (multi-root: uma por vez). */
  async detect(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? []
    let detected: DetectedProject | undefined
    for (const folder of folders) {
      if (folder.uri.scheme !== 'file') continue
      detected = await detectProject(folder.uri.fsPath, projectIo).catch((error: unknown) => {
        this.log.warn(`deteccao falhou em ${folder.uri.fsPath}: ${messageOf(error)}`)
        return undefined
      })
      if (detected !== undefined) break
    }
    if (detected?.repoRoot === this.project?.repoRoot && this.service !== undefined) {
      this.project = detected
      this.setContexts()
      return
    }
    this.project = detected
    this.watcher?.close()
    this.watcher = undefined
    // Um servico que possui um filho vivo nao e esquecido ao trocar de projeto: continua
    // alcancavel pelo encerramento da janela (stopOnWindowClose).
    if (this.service !== undefined && this.service.view().owned) this.retired.push(this.service)
    this.service = undefined
    this.reports.clear()
    this.data = { missions: [] }
    if (detected !== undefined) {
      this.log.info(`projeto detectado: ${detected.name} (${detected.repoRoot})`)
      this.service = this.createService(detected)
      this.disposables.push({ dispose: this.service.onDidChange(() => this.setContexts()) })
      this.watchRuntimeDir(detected)
    } else {
      this.log.info('nenhum .agentic/project.yaml nas pastas abertas')
    }
    this.setContexts()
  }

  private createService(project: DetectedProject): AgenticService {
    const log = this.log
    return new AgenticService({
      discover: () =>
        discoverLive(
          {
            runtimeDir: project.runtimeDir,
            repoRoot: project.repoRoot,
            declaredUrl: project.declaredUrl,
          },
          discoveryDeps,
        ),
      spawnServe: async () => {
        const settings = vscode.workspace.getConfiguration('agentic')
        const toolchain = await resolveToolchain(toolchainIo, project.repoRoot, {
          nodePath: settings.get<string>('nodePath', ''),
          cliPath: settings.get<string>('cliPath', ''),
        })
        const banner = `toolchain: node ${toolchain.node.version} (${toolchain.node.path}); cli ${toolchain.cli.path} [${toolchain.cli.source}]`
        log.info(banner)
        return launchServe({
          toolchain,
          projectDir: project.projectDir,
          repoRoot: project.repoRoot,
          env: childEnv(process.env, toolchain.node, settings.get<string[]>('childEnvAllow', [])),
          onLine: (line) => log.child(line),
          banner,
        })
      },
      signal: sendSignal,
      sleep,
      now: () => new Date(),
      log: (line) => log.info(line),
    })
  }

  private watchRuntimeDir(project: DetectedProject): void {
    try {
      let timer: NodeJS.Timeout | undefined
      this.watcher = watch(project.runtimeDir, (_event, name) => {
        if (name !== CONTROL_PLANE_FILE_NAME && name !== null) return
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(() => void this.refresh({ data: true }), 300)
      })
      this.watcher.on('error', () => undefined)
    } catch {
      // `.agentic` pode nao existir ainda (projeto sem estado); a sondagem periodica cobre.
    }
  }

  view(): ServiceView | undefined {
    return this.service?.view()
  }

  homeProject(): HomeProject | undefined {
    if (this.project === undefined) return undefined
    return {
      name: this.project.name,
      repoRoot: this.project.repoRoot,
      projectFile: this.project.projectFile,
      gitRepository: this.project.git.repository,
      ...(this.project.git.branch === undefined ? {} : { branch: this.project.git.branch }),
    }
  }

  client(): AgenticClient | undefined {
    const view = this.view()
    if (this.project === undefined || view?.state !== 'RUNNING' || view.live === undefined)
      return undefined
    return new AgenticClient(view.live.url, this.project.repoRoot)
  }

  async refresh(options: { readonly data: boolean } = { data: true }): Promise<void> {
    if (this.service === undefined) {
      this.notify()
      return
    }
    const before = this.service.view()
    const after = await this.service.refresh()
    const changed = before.state !== after.state || before.live?.url !== after.live?.url
    if (changed || options.data) await this.loadData()
    this.notify()
  }

  /** Providers, missions e runs. Sem control plane: missions vem do disco, o resto e "nao apurado". */
  async loadData(): Promise<void> {
    if (this.loading !== undefined) return this.loading
    this.loading = this.doLoadData().finally(() => {
      this.loading = undefined
    })
    return this.loading
  }

  private async doLoadData(): Promise<void> {
    const project = this.project
    if (project === undefined) return
    const client = this.client()
    this.lastDataAt = Date.now()
    if (client === undefined) {
      const entries = await readdir(project.missionsDir).catch(() => [] as string[])
      const files = missionFilesOnDisk(project.missionsDir, project.repoRoot, entries)
      this.data = {
        missions: summarizeMissions(files, undefined, this.reports),
        loadedAt: new Date().toISOString(),
      }
      return
    }
    try {
      const [providers, files, runs] = await Promise.all([
        client.providers(),
        client.missions(),
        client.runs(),
      ])
      await this.compileAll(client, files)
      this.data = {
        providers,
        runs,
        missions: summarizeMissions(files, runs, this.reports),
        loadedAt: new Date().toISOString(),
      }
    } catch (error) {
      this.log.warn(`leitura do control plane falhou: ${messageOf(error)}`)
      this.data = { ...this.data, error: messageOf(error) }
    }
  }

  private async compileAll(
    client: AgenticClient,
    files: readonly MissionListItem[],
  ): Promise<void> {
    await Promise.all(
      files.map(async (item) => {
        try {
          this.reports.set(item.file, await client.compile(item.file))
        } catch (error) {
          this.log.warn(`compile de ${item.file} falhou: ${messageOf(error)}`)
        }
      }),
    )
  }

  async missionDetail(file: string): Promise<MissionDetail> {
    const summary = this.data.missions.find((m) => m.file === file)
    if (summary === undefined) throw new Error(`mission nao listada: ${file}`)
    const client = this.client()
    if (client === undefined)
      return { summary, runs: [], error: 'control plane parado: runs nao apurados' }
    try {
      const runs = (this.data.runs ?? (await client.runs())).filter(
        (run) => run.missionId === summary.id,
      )
      const last = runs[0]
      if (last === undefined) return { summary, runs }
      const snapshot = await client.snapshot(last.id)
      const tasks = await Promise.all(snapshot.tasks.map((task) => client.task(last.id, task.id)))
      return { summary, runs, snapshot, tasks }
    } catch (error) {
      return { summary, runs: [], error: messageOf(error) }
    }
  }

  async lifecycle(operation: 'start' | 'stop' | 'restart'): Promise<ServiceView | undefined> {
    const service = this.service
    if (service === undefined) {
      void vscode.window.showWarningMessage('Agentic: nenhum projeto detectado nesta janela.')
      return undefined
    }
    const labels = {
      start: 'Iniciando o control plane…',
      stop: 'Encerrando o control plane…',
      restart: 'Reiniciando o control plane…',
    }
    this.busy = labels[operation]
    this.notify()
    try {
      const view = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Agentic: ${labels[operation]}` },
        () =>
          operation === 'start'
            ? service.ensureRunning()
            : operation === 'stop'
              ? service.stop()
              : service.restart(),
      )
      if (view.failure !== undefined && (view.state === 'FAILED' || view.state === 'STOPPED')) {
        const action = await vscode.window.showErrorMessage(
          `Agentic: ${firstLine(view.failure.message)}`,
          'Ver log',
        )
        if (action === 'Ver log') this.log.show()
      }
      return view
    } catch (error) {
      const action = await vscode.window.showErrorMessage(
        `Agentic: ${firstLine(messageOf(error))}`,
        'Ver log',
      )
      if (action === 'Ver log') this.log.show()
      return service.view()
    } finally {
      this.busy = undefined
      await this.loadData()
      this.notify()
    }
  }

  private setContexts(): void {
    const state = this.view()?.state ?? 'STOPPED'
    void vscode.commands.executeCommand(
      'setContext',
      'agentic.project',
      this.project === undefined ? 'none' : 'detected',
    )
    void vscode.commands.executeCommand('setContext', 'agentic.controlPlane', state.toLowerCase())
    this.notify()
  }

  notify(): void {
    this.changed.fire()
  }

  /** Encerramento da janela: o filho que ELA criou e parado com prazo; o dos outros, nunca. */
  async shutdown(): Promise<void> {
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer)
    this.watcher?.close()
    const stopOnClose = vscode.workspace
      .getConfiguration('agentic')
      .get<boolean>('stopOnWindowClose', true)
    if (!stopOnClose) return
    const owned = [...this.retired, ...(this.service === undefined ? [] : [this.service])].filter(
      (service) => service.view().owned,
    )
    for (const service of owned) {
      this.log.info('janela fechando: encerrando o control plane desta janela')
      // O host da extensao da poucos segundos ao deactivate. O stop continua com o proprio
      // prazo e prova; se a janela for embora antes, o processo (grupo proprio) continua dono
      // e a proxima janela o descobre — nunca um STOPPED falso.
      const outcome = await Promise.race([
        service.stop().then((view) => view.state),
        sleep(4_000).then(() => 'DEADLINE'),
      ])
      if (outcome !== 'STOPPED') {
        this.log.warn(
          `encerramento ao fechar a janela nao provado (${outcome}); o processo segue dono ate ser parado`,
        )
      }
    }
  }

  dispose(): void {
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer)
    this.watcher?.close()
    for (const d of this.disposables) d.dispose()
  }
}

export function firstLine(text: string): string {
  return text.split('\n')[0] ?? text
}
