import { type FSWatcher, watch } from 'node:fs'
import { readdir } from 'node:fs/promises'
import process from 'node:process'
import * as vscode from 'vscode'
import { AgenticClient } from '../core/client.js'
import type { ProviderHealthDto, RunHeaderDto } from '../core/contracts.js'
import { CONTROL_PLANE_FILE_NAME } from '../core/contracts.js'
import { discoverLive } from '../core/discovery.js'
import { launchServe } from '../core/launcher.js'
import {
  type MissionSummary,
  missionFilesOnDisk,
  summariesFromControlPlane,
} from '../core/missions.js'
import { type DetectedProject, detectProject, messageOf } from '../core/project.js'
import { AgenticService, type ServiceView } from '../core/service.js'
import { childEnv, resolveToolchain } from '../core/toolchain.js'
import { discoveryDeps, exec, projectIo, sendSignal, sleep, toolchainIo } from './io.js'
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
  /** Sugestao para o `actor` (git config user.name); nunca assumida em silencio — a tela exige o campo. */
  defaultActor: string | undefined
  data: HostData = { missions: [] }
  busy: string | undefined

  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChange = this.changed.event
  private readonly disposables: vscode.Disposable[] = [this.changed]
  private watcher: FSWatcher | undefined
  private pollTimer: NodeJS.Timeout | undefined
  private lastDataAt = 0
  private loading: Promise<void> | undefined
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
    // Um servico com filho vivo — ou com spawn em voo — nao e esquecido ao trocar de projeto:
    // a janela nao consegue mais observa-lo, entao o que ELA criou e encerrado ja, e o servico
    // fica em `retired` ate o fechamento provar (ou nao) a saida. Dono externo: nunca tocado.
    const previous = this.service
    if (previous !== undefined) {
      const view = previous.view()
      if (view.spawning || view.childPid !== undefined) {
        this.retired.push(previous)
        void previous.stopOwnChild().then((outcome) => {
          this.log.info(`projeto trocado: filho do servico anterior ${outcome}`)
        })
      }
    }
    this.service = undefined
    this.data = { missions: [] }
    if (detected !== undefined) {
      this.log.info(`projeto detectado: ${detected.name} (${detected.repoRoot})`)
      this.defaultActor = await suggestedActor(detected.repoRoot)
      this.service = this.createService(detected)
      this.disposables.push({
        dispose: this.service.onDidChange((view) => {
          this.setContexts()
          // Entrou ou saiu do ar: os dados mudam de fonte (control plane x disco). Recarrega
          // FRESCO — uma carga em voo iniciada antes da transicao leu a fonte antiga.
          if (view.state === 'RUNNING' || view.state === 'STOPPED') {
            void this.loadData({ fresh: true }).then(() => this.notify())
          }
        }),
      })
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
          env: childEnv(process.env, toolchain.node),
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
  async loadData(options: { readonly fresh?: boolean } = {}): Promise<void> {
    if (this.loading !== undefined) {
      if (!options.fresh) return this.loading
      // Uma carga em voo pode ter lido a fonte errada; espera ela e faz outra, do zero.
      await this.loading.catch(() => undefined)
    }
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
      this.data = {
        missions: missionFilesOnDisk(project.missionsDir, project.repoRoot, entries),
        loadedAt: new Date().toISOString(),
      }
      return
    }
    try {
      const [providers, items, runs] = await Promise.all([
        client.providers(),
        client.missions(),
        client.runs(),
      ])
      this.data = {
        providers,
        runs,
        missions: summariesFromControlPlane(project.repoRoot, items),
        loadedAt: new Date().toISOString(),
      }
    } catch (error) {
      this.log.warn(`leitura do control plane falhou: ${messageOf(error)}`)
      this.data = { ...this.data, error: messageOf(error) }
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
      await this.loadData({ fresh: true })
      this.notify()
    }
  }

  private setContexts(): void {
    const state = this.view()?.state ?? 'STOPPED'
    void vscode.commands.executeCommand(
      'setContext',
      'agentic.missions',
      this.data.missions.length === 0 ? 'none' : 'some',
    )
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
    // Todo filho criado por esta janela — vivo, em STARTING, retido em FAILED ou ainda por
    // nascer (spawn em voo) — e alcancado por `stopOwnChild`, que NUNCA sinaliza um dono
    // externo. Um dono que a janela apenas reutilizava segue no ar, como deve.
    const own = [...this.retired, ...(this.service === undefined ? [] : [this.service])].filter(
      (service) => {
        const view = service.view()
        return view.spawning || view.childPid !== undefined
      },
    )
    for (const service of own) {
      this.log.info('janela fechando: encerrando o control plane desta janela')
      // O host da extensao da poucos segundos ao deactivate. A bandeira de abandono fica
      // ligada mesmo se o prazo vencer: um spawn que assente depois recebe SIGTERM no ato.
      const outcome = await Promise.race([
        service.stopOwnChild(),
        sleep(4_000).then(() => 'DEADLINE' as const),
      ])
      if (outcome !== 'stopped' && outcome !== 'none') {
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

/** `git config user.name` do repositorio (ou global): sugestao de `actor`, editavel na tela. */
async function suggestedActor(repoRoot: string): Promise<string | undefined> {
  try {
    const result = await exec('git', ['config', 'user.name'], repoRoot)
    const name = result.code === 0 ? result.stdout.trim() : ''
    return name.length === 0 ? undefined : name
  } catch {
    return undefined
  }
}
