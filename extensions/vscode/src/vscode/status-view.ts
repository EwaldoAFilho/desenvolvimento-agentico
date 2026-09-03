import * as vscode from 'vscode'
import type { ProviderHealthDto } from '../core/contracts.js'
import type { ServiceView } from '../core/service.js'
import type { AgenticHost } from './host.js'
import { providerIcon, providerStateLabel } from './labels.js'

/**
 * Sidebar "Projeto": nome, branch, control plane, providers e a mission mais recente.
 * Funcional antes de bonito: cada linha e um fato medido, com a fonte no tooltip.
 */
type Row =
  | { readonly kind: 'project' }
  | { readonly kind: 'branch' }
  | { readonly kind: 'controlPlane' }
  | { readonly kind: 'providers' }
  | { readonly kind: 'provider'; readonly provider: ProviderHealthDto }
  | { readonly kind: 'providersUnknown' }
  | { readonly kind: 'mission' }

export function controlPlaneLabel(view: ServiceView | undefined, busy: string | undefined): string {
  if (busy !== undefined) return busy
  switch (view?.state) {
    case 'RUNNING':
      return '● Running'
    case 'STARTING':
      return '◌ Starting…'
    case 'STOPPING':
      return '◌ Stopping…'
    case 'FAILED':
      return '⚠ Failed'
    default:
      return '○ Stopped'
  }
}

export class StatusTreeProvider implements vscode.TreeDataProvider<Row> {
  private readonly changed = new vscode.EventEmitter<Row | undefined>()
  readonly onDidChangeTreeData = this.changed.event

  constructor(private readonly host: AgenticHost) {
    host.onDidChange(() => this.changed.fire(undefined))
  }

  getChildren(element?: Row): Row[] {
    if (this.host.project === undefined) return []
    if (element === undefined) {
      return [
        { kind: 'project' },
        { kind: 'branch' },
        { kind: 'controlPlane' },
        { kind: 'providers' },
        { kind: 'mission' },
      ]
    }
    if (element.kind === 'providers') {
      const providers = this.host.data.providers
      if (providers === undefined) return [{ kind: 'providersUnknown' }]
      return providers.map((provider) => ({ kind: 'provider', provider }))
    }
    return []
  }

  getTreeItem(row: Row): vscode.TreeItem {
    const project = this.host.project
    const view = this.host.view()
    switch (row.kind) {
      case 'project': {
        const item = new vscode.TreeItem('Projeto')
        item.description = project?.name ?? '—'
        item.tooltip =
          project === undefined ? undefined : `${project.repoRoot}\n${project.projectFile}`
        item.iconPath = new vscode.ThemeIcon('folder')
        if (project !== undefined) {
          item.command = {
            command: 'agentic.openFile',
            title: 'Abrir project.yaml',
            arguments: [project.projectFile],
          }
        }
        return item
      }
      case 'branch': {
        const item = new vscode.TreeItem('Branch')
        item.description =
          project?.git.branch ?? (project?.git.repository === false ? 'sem repositório git' : '—')
        item.tooltip = project?.git.detail ?? project?.git.root
        item.iconPath = new vscode.ThemeIcon('git-branch')
        return item
      }
      case 'controlPlane': {
        const item = new vscode.TreeItem('Control Plane')
        item.description = controlPlaneLabel(view, this.host.busy)
        item.tooltip = controlPlaneTooltip(view)
        item.iconPath = new vscode.ThemeIcon(
          view?.state === 'RUNNING'
            ? 'pass-filled'
            : view?.state === 'FAILED'
              ? 'warning'
              : 'circle-large-outline',
        )
        item.contextValue = `controlPlane.${(view?.state ?? 'STOPPED').toLowerCase()}`
        item.command = { command: 'agentic.open', title: 'Open Agentic' }
        return item
      }
      case 'providers': {
        const item = new vscode.TreeItem('Providers', vscode.TreeItemCollapsibleState.Expanded)
        const providers = this.host.data.providers
        item.description =
          providers === undefined
            ? 'não apurado'
            : `${providers.filter((p) => providerStateLabel(p) === 'READY').length}/${providers.length} prontos`
        item.iconPath = new vscode.ThemeIcon('organization')
        return item
      }
      case 'provider': {
        const { provider } = row
        const item = new vscode.TreeItem(provider.providerId)
        const state = providerStateLabel(provider)
        item.description = `${state}${provider.version === 'unknown' ? '' : ` · ${provider.version}`}${provider.running > 0 ? ` · ${provider.running} em voo` : ''}`
        item.tooltip = [provider.detail, provider.readinessSource, provider.diagnostic?.remediation]
          .filter(Boolean)
          .join('\n')
        item.iconPath = new vscode.ThemeIcon(providerIcon(state))
        return item
      }
      case 'providersUnknown': {
        const item = new vscode.TreeItem(
          view?.state === 'RUNNING' ? 'lendo…' : 'inicie o control plane para sondar',
        )
        item.iconPath = new vscode.ThemeIcon('info')
        return item
      }
      case 'mission': {
        const item = new vscode.TreeItem('Mission')
        const latest = this.host.data.runs?.[0]
        if (latest === undefined) {
          item.description = this.host.data.runs === undefined ? 'não apurado' : 'nenhum run'
        } else {
          item.description = `${latest.missionId} · ${latest.status}`
          item.tooltip = `run ${latest.id}\ncriado em ${latest.timestamps.createdAt}`
          const mission = this.host.data.missions.find((m) => m.id === latest.missionId)
          if (mission !== undefined) {
            item.command = {
              command: 'agentic.openMission',
              title: 'Open Mission Details',
              arguments: [mission.file],
            }
          }
        }
        item.iconPath = new vscode.ThemeIcon('rocket')
        return item
      }
    }
  }
}

function controlPlaneTooltip(view: ServiceView | undefined): string {
  if (view === undefined) return 'nenhum projeto'
  const lines = [`estado: ${view.state}`]
  if (view.live !== undefined) {
    lines.push(`endereço: ${view.live.url}`)
    if (view.live.pid !== undefined) lines.push(`pid: ${view.live.pid}`)
    lines.push(
      view.owned
        ? 'iniciado por esta janela'
        : 'iniciado por outra janela ou pelo terminal (reutilizado)',
    )
  }
  if (view.failure !== undefined) lines.push(`falha em ${view.failure.at}: ${view.failure.message}`)
  return lines.join('\n')
}
