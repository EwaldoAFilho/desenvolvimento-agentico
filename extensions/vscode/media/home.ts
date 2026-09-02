import { elapsedSince, formatClock, formatDuration } from '../../../apps/web/src/lib/format.js'
import type { ProviderHealthDto, RunHeaderDto, TaskDetail } from '../src/core/contracts.js'
import type { MissionSummary } from '../src/core/missions.js'
import type { HomeState, HostToWebview, WebviewToHost } from '../src/webview/protocol.js'

/**
 * Project Home da webview. Vanilla de proposito: sem framework, sem rede, sem HTML montado
 * por string com dados — cada no e criado pela DOM API, entao nada que venha do control
 * plane vira markup. Reaproveita do dashboard (`apps/web`) as projecoes puras de formato.
 */
declare function acquireVsCodeApi(): { postMessage(message: WebviewToHost): void }

const vscode = acquireVsCodeApi()
const app = document.getElementById('app') as HTMLElement

function send(message: WebviewToHost): void {
  vscode.postMessage(message)
}

type Child = Node | string | undefined | false

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value
    else node.setAttribute(key, value)
  }
  for (const child of children) {
    if (child === undefined || child === false) continue
    node.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

function button(
  label: string,
  onClick: () => void,
  attrs: Record<string, string> = {},
): HTMLButtonElement {
  const node = el('button', { type: 'button', ...attrs }, label)
  node.addEventListener('click', onClick)
  return node
}

function link(label: string, onClick: () => void, title?: string): HTMLButtonElement {
  return button(label, onClick, { class: 'link', ...(title === undefined ? {} : { title }) })
}

function stateDot(state: HomeState['service']['state']): HTMLElement {
  return el('span', { class: `dot dot-${state.toLowerCase()}`, 'aria-hidden': 'true' })
}

function controlPlaneSection(state: HomeState): HTMLElement {
  const { service } = state
  const label = state.busy ?? labelOf(service.state)
  const actions = el('div', { class: 'actions' })
  const busy =
    state.busy !== undefined || service.state === 'STARTING' || service.state === 'STOPPING'
  if (service.state === 'RUNNING') {
    actions.append(
      button('Stop Agentic', () => send({ type: 'stop' }), busy ? { disabled: '' } : {}),
      button('Restart Agentic', () => send({ type: 'restart' }), busy ? { disabled: '' } : {}),
    )
  } else if (service.state === 'FAILED') {
    actions.append(
      button('Stop de novo', () => send({ type: 'stop' }), busy ? { disabled: '' } : {}),
    )
  } else {
    actions.append(
      button('Start Agentic', () => send({ type: 'start' }), {
        class: 'primary',
        ...(busy ? { disabled: '' } : {}),
      }),
    )
  }
  actions.append(
    link('Atualizar', () => send({ type: 'refresh' })),
    link('Log', () => send({ type: 'showLog' })),
  )
  const facts = el('dl', { class: 'facts' })
  if (service.live !== undefined) {
    facts.append(el('dt', {}, 'Endereço'), el('dd', {}, service.live.url))
    facts.append(
      el('dt', {}, 'Processo'),
      el(
        'dd',
        {},
        `${service.live.pid === undefined ? 'sem registro' : `pid ${service.live.pid}`} · ${service.owned ? 'iniciado por esta janela' : 'reutilizado (outra janela ou terminal)'}`,
      ),
    )
    if (service.live.startedAt !== undefined) {
      facts.append(
        el('dt', {}, 'No ar há'),
        el('dd', {}, formatDuration(elapsedSince(service.live.startedAt, Date.now()))),
      )
    }
  }
  if (service.failure !== undefined) {
    facts.append(
      el('dt', {}, `Falha (${service.failure.at})`),
      el('dd', { class: 'failure' }, service.failure.message),
    )
  }
  return el(
    'section',
    { class: 'card' },
    el('h2', {}, stateDot(service.state), ` Control Plane · ${label}`),
    actions,
    facts,
  )
}

function labelOf(state: HomeState['service']['state']): string {
  switch (state) {
    case 'RUNNING':
      return 'Running'
    case 'STARTING':
      return 'Starting…'
    case 'STOPPING':
      return 'Stopping…'
    case 'FAILED':
      return 'Failed'
    default:
      return 'Stopped'
  }
}

function projectSection(state: HomeState): HTMLElement {
  const project = state.project
  if (project === undefined) {
    return el(
      'section',
      { class: 'card' },
      el('h2', {}, 'Nenhum projeto detectado'),
      el('p', {}, 'Abra uma pasta com .agentic/project.yaml.'),
    )
  }
  return el(
    'section',
    { class: 'card' },
    el('h1', {}, project.name),
    el(
      'dl',
      { class: 'facts' },
      el('dt', {}, 'Repositório'),
      el(
        'dd',
        {},
        link(
          project.repoRoot,
          () => send({ type: 'openFile', path: project.repoRoot }),
          'revelar no Explorer',
        ),
      ),
      el('dt', {}, 'Branch'),
      el('dd', {}, project.branch ?? (project.gitRepository ? '—' : 'sem repositório git')),
      el('dt', {}, 'Configuração'),
      el(
        'dd',
        {},
        link('.agentic/project.yaml', () => send({ type: 'openFile', path: project.projectFile })),
      ),
    ),
  )
}

function providerState(provider: ProviderHealthDto): string {
  if (provider.installed === false) return 'UNAVAILABLE'
  if (provider.ready === true) return 'READY'
  if (provider.ready === false) return 'NOT READY'
  return 'UNKNOWN'
}

function providersSection(state: HomeState): HTMLElement {
  const providers = state.providers
  const body =
    providers === undefined
      ? el(
          'p',
          { class: 'muted' },
          state.service.state === 'RUNNING'
            ? 'lendo…'
            : 'não apurado: inicie o control plane para sondar os providers.',
        )
      : el(
          'table',
          {},
          el(
            'thead',
            {},
            el(
              'tr',
              {},
              el('th', {}, 'Provider'),
              el('th', {}, 'Estado'),
              el('th', {}, 'Versão'),
              el('th', {}, 'Em voo'),
              el('th', {}, 'Capacidade'),
            ),
          ),
          el(
            'tbody',
            {},
            ...providers.map((provider) =>
              el(
                'tr',
                { title: [provider.detail, provider.readinessSource].filter(Boolean).join('\n') },
                el('td', {}, provider.providerId),
                el(
                  'td',
                  {},
                  el(
                    'span',
                    {
                      class: `pill pill-${providerState(provider).toLowerCase().replace(' ', '-')}`,
                    },
                    providerState(provider),
                  ),
                ),
                el('td', {}, provider.version),
                el('td', {}, String(provider.running)),
                el('td', {}, provider.capacity === null ? 'sem teto' : String(provider.capacity)),
              ),
            ),
          ),
        )
  return el('section', { class: 'card' }, el('h2', {}, 'Providers'), body)
}

function missionRow(mission: MissionSummary, selected: boolean): HTMLElement {
  const stateText =
    mission.state === 'UNKNOWN' ? (mission.runsKnown ? 'sem run' : 'não apurado') : mission.state
  const row = el(
    'tr',
    { class: selected ? 'selected' : '' },
    el(
      'td',
      {},
      link(mission.id, () => send({ type: 'selectMission', file: mission.file })),
    ),
    el('td', {}, el('span', { class: `pill pill-${mission.state.toLowerCase()}` }, stateText)),
    el(
      'td',
      {},
      mission.lastRun === undefined
        ? '—'
        : `${mission.lastRun.id.slice(-8)} · ${formatClock(mission.lastRun.timestamps.createdAt)}`,
    ),
    el(
      'td',
      {},
      mission.stats === undefined
        ? '—'
        : `${mission.stats.tasks} tasks · ${mission.stats.phases} fases`,
    ),
    el(
      'td',
      {},
      link('abrir', () => send({ type: 'openMissionFile', file: mission.file }), mission.file),
    ),
  )
  return row
}

function missionsSection(state: HomeState): HTMLElement {
  const missions = state.missions
  const body =
    missions.length === 0
      ? el('p', { class: 'muted' }, 'Nenhuma mission em .agentic/missions.')
      : el(
          'table',
          {},
          el(
            'thead',
            {},
            el(
              'tr',
              {},
              el('th', {}, 'Mission'),
              el('th', {}, 'Estado'),
              el('th', {}, 'Último run'),
              el('th', {}, 'DAG'),
              el('th', {}, 'Arquivo'),
            ),
          ),
          el(
            'tbody',
            {},
            ...missions.map((mission) =>
              missionRow(mission, state.selected?.summary.file === mission.file),
            ),
          ),
        )
  return el('section', { class: 'card' }, el('h2', {}, 'Missions'), body)
}

function runLine(run: RunHeaderDto): HTMLElement {
  return el(
    'li',
    {},
    el('code', {}, run.id),
    ` · ${run.status} · criado ${formatClock(run.timestamps.createdAt)}`,
    run.integrationBranch === undefined
      ? undefined
      : el('span', { class: 'muted' }, ` · ${run.integrationBranch}`),
  )
}

function taskRow(task: TaskDetail, repoBranch: string | undefined): HTMLElement {
  const isolation = task.isolation
  const actions = el('div', { class: 'inline-actions' })
  if (isolation.worktreePath !== undefined) {
    const path = isolation.worktreePath
    actions.append(link('worktree', () => send({ type: 'openWorktree', path }), path))
  }
  const base = isolation.baseCommit
  const head = isolation.commit ?? isolation.branch
  if (base !== undefined && head !== undefined) {
    for (const change of task.facts.filesChanged) {
      actions.append(
        link(
          `diff ${change.path}`,
          () => send({ type: 'openDiff', path: change.path, base, head }),
          `${change.change} +${change.added} -${change.removed}`,
        ),
      )
    }
  }
  const touches = el('div', { class: 'touches' })
  for (const scope of task.scope.touches ?? []) {
    touches.append(link(scope, () => send({ type: 'openFile', path: scope })))
  }
  return el(
    'li',
    { class: 'task' },
    el(
      'div',
      { class: 'task-head' },
      el('strong', {}, task.id),
      ` ${task.title} `,
      el('span', { class: `pill pill-${task.status.toLowerCase()}` }, task.status),
    ),
    el(
      'div',
      { class: 'muted' },
      `fase ${task.phase}`,
      task.execution.provider === undefined ? '' : ` · ${task.execution.provider}`,
      task.execution.durationMs === undefined
        ? ''
        : ` · ${formatDuration(task.execution.durationMs)}`,
      repoBranch === undefined ? '' : '',
    ),
    touches,
    actions,
  )
}

function selectedSection(state: HomeState): HTMLElement | undefined {
  const detail = state.selected
  if (detail === undefined) return undefined
  const { summary } = detail
  const head = el(
    'h2',
    {},
    `Mission ${summary.id}`,
    ' ',
    el('span', { class: `pill pill-${summary.state.toLowerCase()}` }, summary.state),
  )
  const parts: Child[] = [head]
  parts.push(
    el(
      'p',
      {},
      link(
        summary.file,
        () => send({ type: 'openMissionFile', file: summary.file }),
        'abrir no editor',
      ),
    ),
  )
  if (summary.diagnostics !== undefined && summary.diagnostics.length > 0) {
    parts.push(
      el(
        'ul',
        { class: 'diagnostics' },
        ...summary.diagnostics.map((d) =>
          el(
            'li',
            { class: `sev-${d.severity.toLowerCase()}` },
            `${d.severity} ${d.code}: ${d.message}`,
          ),
        ),
      ),
    )
  }
  if (detail.error !== undefined) parts.push(el('p', { class: 'muted' }, detail.error))
  if (detail.runs.length > 0)
    parts.push(el('h3', {}, 'Runs'), el('ul', {}, ...detail.runs.map(runLine)))
  if (detail.tasks !== undefined && detail.tasks.length > 0) {
    parts.push(
      el('h3', {}, `Tasks do run ${detail.snapshot?.run.id ?? ''}`),
      el(
        'ul',
        { class: 'tasks' },
        ...detail.tasks.map((task) => taskRow(task, state.project?.branch)),
      ),
    )
  }
  return el('section', { class: 'card' }, ...parts)
}

function render(state: HomeState): void {
  const sections: Child[] = [
    projectSection(state),
    controlPlaneSection(state),
    providersSection(state),
    missionsSection(state),
    selectedSection(state),
  ]
  const footer = el(
    'p',
    { class: 'muted footer' },
    `atualizado ${formatClock(state.updatedAt)}`,
    state.error === undefined ? '' : ` · erro: ${state.error}`,
  )
  app.replaceChildren(...sections.filter((s): s is Node => s instanceof Node), footer)
}

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  const message = event.data
  if (message?.type === 'state') render(message.state)
})

send({ type: 'ready' })
