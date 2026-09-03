import * as vscode from 'vscode'
import type { MissionSummary } from '../core/missions.js'
import type { AgenticHost } from './host.js'

/** Sidebar "Missions": id, estado e ultimo run. Clicar abre os detalhes no painel. */
export class MissionsTreeProvider implements vscode.TreeDataProvider<MissionSummary> {
  private readonly changed = new vscode.EventEmitter<MissionSummary | undefined>()
  readonly onDidChangeTreeData = this.changed.event

  constructor(private readonly host: AgenticHost) {
    host.onDidChange(() => this.changed.fire(undefined))
  }

  getChildren(): MissionSummary[] {
    return this.host.data.missions
  }

  getTreeItem(mission: MissionSummary): vscode.TreeItem {
    const item = new vscode.TreeItem(mission.id)
    item.description = missionDescription(mission)
    item.tooltip = missionTooltip(mission)
    item.iconPath = new vscode.ThemeIcon(missionIcon(mission))
    item.contextValue = 'mission'
    item.command = {
      command: 'agentic.openMission',
      title: 'Open Mission Details',
      arguments: [mission.file],
    }
    return item
  }
}

export function missionDescription(mission: MissionSummary): string {
  const parts: string[] = [
    mission.state === 'UNKNOWN' ? (mission.runsKnown ? 'sem run' : 'não apurado') : mission.state,
  ]
  if (mission.lastRun !== undefined) parts.push(`run ${mission.lastRun.id.slice(-6)}`)
  if (mission.tasks !== undefined) parts.push(`${mission.tasks} tasks`)
  return parts.join(' · ')
}

function missionTooltip(mission: MissionSummary): string {
  const lines = [mission.file]
  if (mission.lastRun !== undefined) {
    lines.push(
      `último run: ${mission.lastRun.id} (${mission.lastRun.status}, ${mission.lastRun.createdAt})`,
    )
  }
  if (mission.errors !== undefined || mission.warnings !== undefined) {
    lines.push(`compile: ${mission.errors ?? 0} erro(s), ${mission.warnings ?? 0} aviso(s)`)
  }
  return lines.join('\n')
}

function missionIcon(mission: MissionSummary): string {
  switch (mission.state) {
    case 'RUNNING':
      return 'sync~spin'
    case 'DRAFT':
      return 'edit'
    case 'APPROVED':
      return 'circle-outline'
    case 'COMPLETED':
      return 'pass'
    case 'FAILED':
      return 'error'
    case 'CANCELLED':
      return 'circle-slash'
    case 'INVALID':
      return 'warning'
    case 'PLANNED':
      return 'circle-large-outline'
    default:
      return 'file'
  }
}
