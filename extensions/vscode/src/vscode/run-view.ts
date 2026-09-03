import * as vscode from 'vscode'
import type { RunHeaderDto } from '../core/contracts.js'
import type { AgenticHost } from './host.js'

/** Estados de run que ainda pedem atencao (o mesmo conjunto do dashboard: `activeRunOf`). */
export const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  'RUNNING',
  'PAUSED',
  'BLOCKED',
  'VERIFYING',
])

export function activeRunOf(runs: readonly RunHeaderDto[] | undefined): RunHeaderDto | undefined {
  return runs?.find((run) => ACTIVE_RUN_STATUSES.has(run.status))
}

type Row =
  | { readonly kind: 'run'; readonly run: RunHeaderDto }
  | {
      readonly kind: 'task'
      readonly run: RunHeaderDto
      readonly id: string
      readonly status: string
      readonly title: string
    }
  | { readonly kind: 'none' }

/** Sidebar "Active Run": o run em andamento e suas tasks; clicar abre o dashboard naquela rota. */
export class RunTreeProvider implements vscode.TreeDataProvider<Row> {
  private readonly changed = new vscode.EventEmitter<Row | undefined>()
  readonly onDidChangeTreeData = this.changed.event

  constructor(private readonly host: AgenticHost) {
    host.onDidChange(() => this.changed.fire(undefined))
  }

  async getChildren(element?: Row): Promise<Row[]> {
    if (this.host.project === undefined) return []
    if (element === undefined) {
      const run = activeRunOf(this.host.data.runs)
      return run === undefined ? [{ kind: 'none' }] : [{ kind: 'run', run }]
    }
    if (element.kind !== 'run') return []
    const client = this.host.client()
    if (client === undefined) return []
    try {
      const snapshot = await client.snapshot(element.run.id)
      const titles = new Map(snapshot.graph.nodes.map((node) => [node.id, node.title]))
      return snapshot.tasks.map((task) => ({
        kind: 'task',
        run: element.run,
        id: task.id,
        status: task.status,
        title: titles.get(task.id) ?? '',
      }))
    } catch {
      return []
    }
  }

  getTreeItem(row: Row): vscode.TreeItem {
    if (row.kind === 'none') {
      const item = new vscode.TreeItem(
        this.host.data.runs === undefined ? 'não apurado' : 'nenhum run ativo',
      )
      item.iconPath = new vscode.ThemeIcon('info')
      return item
    }
    if (row.kind === 'run') {
      const item = new vscode.TreeItem(
        `${row.run.missionId} · ${row.run.status}`,
        vscode.TreeItemCollapsibleState.Expanded,
      )
      item.description = `…${row.run.id.slice(-6)}`
      item.tooltip = `run ${row.run.id}\ncriado em ${row.run.timestamps.createdAt}`
      item.iconPath = new vscode.ThemeIcon(row.run.status === 'BLOCKED' ? 'error' : 'sync~spin')
      item.command = { command: 'agentic.openRun', title: 'Open Run', arguments: [row.run.id] }
      return item
    }
    const item = new vscode.TreeItem(row.id)
    item.description = `${row.status}${row.title === '' ? '' : ` · ${row.title}`}`
    item.iconPath = new vscode.ThemeIcon(taskIcon(row.status))
    item.command = { command: 'agentic.openRun', title: 'Open Run', arguments: [row.run.id] }
    return item
  }
}

function taskIcon(status: string): string {
  switch (status) {
    case 'RUNNING':
    case 'VERIFYING':
    case 'REVIEW':
    case 'INTEGRATING':
      return 'sync~spin'
    case 'DONE':
      return 'pass'
    case 'FAILED':
    case 'BLOCKED':
      return 'error'
    case 'SKIPPED':
    case 'CANCELLED':
      return 'circle-slash'
    case 'READY':
      return 'circle-large-outline'
    default:
      return 'circle-outline'
  }
}
