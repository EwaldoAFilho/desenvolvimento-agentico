import type { TaskDetail } from '@agentic/schemas'
import type { JSX, ReactNode } from 'react'
import { type ActivityStep, activityPulse } from '../lib/activity.js'
import { blockedViewOf, failureViewOf, logRefsOf } from '../lib/failure.js'
import { formatClock, formatDuration } from '../lib/format.js'
import { taskStatusStyle } from '../lib/status.js'
import type { StalledDependent, WaitingReason } from '../lib/waiting.js'
import { CopyButton } from './CopyButton.js'
import { TaskActions } from './TaskActions.js'

function Field({
  label,
  children,
}: {
  readonly label: string
  readonly children: ReactNode
}): JSX.Element {
  return (
    <div className="field">
      <dt className="field__label">{label}</dt>
      <dd className="field__value">{children}</dd>
    </div>
  )
}

function Group({
  title,
  tone,
  children,
}: {
  readonly title: string
  readonly tone?: 'wait' | 'fail' | 'block'
  readonly children: ReactNode
}): JSX.Element {
  return (
    <section
      className={`group${tone === undefined ? '' : ` group--${tone}`}`}
      aria-label={title}
      data-testid={`group-${title.toLowerCase()}`}
    >
      <h3 className="group__title">{title}</h3>
      <dl className="group__fields">{children}</dl>
    </section>
  )
}

const EMPTY = '—'

function list(values: readonly string[]): string {
  return values.length === 0 ? EMPTY : values.join(', ')
}

/** Ícone acompanha texto — nunca informa sozinho (DASHBOARD 3). */
const ACTIVITY_ICON: Record<ActivityStep['kind'], string> = {
  'workspace-ready': '⌂',
  'agent-started': '▶',
  'process-active': '·',
  'gate-started': '⚙',
  'gate-progress': '·',
  'gate-finished': '⚙',
  'review-started': '⟳',
  'review-finished': '⟳',
  integrating: '⇉',
  'attempt-finished': '■',
  settled: '✔',
}

export interface TaskPanelContext {
  /** Motivo de espera projetado do snapshot (não é estado novo da máquina). */
  readonly waiting?: WaitingReason
  /** Dependentes que ficaram parados atrás desta task. */
  readonly stalled?: readonly StalledDependent[]
  readonly now?: number
}

export interface TaskDetailPanelProps {
  readonly task: TaskDetail | undefined
  readonly loading?: boolean
  readonly busy?: boolean
  readonly context?: TaskPanelContext
  readonly onClose: () => void
  readonly onRetry: (taskId: string) => void
  readonly onUnblock: (taskId: string, note: string) => void
  readonly onSkip: (taskId: string, reason: string) => void
}

/**
 * O card mostra pouco; o painel mostra tudo (DASHBOARD 5). Cada evidencia e citavel: comando
 * exato, `cwd`, exit code e o ponteiro para a saida persistida.
 */
export function TaskDetailPanel({
  task,
  loading = false,
  busy = false,
  context,
  onClose,
  onRetry,
  onUnblock,
  onSkip,
}: TaskDetailPanelProps): JSX.Element {
  if (task === undefined) {
    return (
      <aside className="detail detail--empty" aria-label="Detalhe da task">
        <p className="detail__hint">
          {loading ? 'carregando detalhe…' : 'selecione uma task no canvas'}
        </p>
      </aside>
    )
  }

  const style = taskStatusStyle(task.status)
  const { execution, review, isolation, quality, facts, graph, scope } = task
  const waiting = context?.waiting
  const now = context?.now ?? Date.now()
  const pulse = activityPulse(task.events, now)
  const failure = failureViewOf(task)
  const blocked = blockedViewOf(task, context?.stalled ?? [])
  const logRefs = logRefsOf(task)

  return (
    <aside className="detail" aria-label={`Detalhe da task ${task.id}`}>
      <div className="detail__head">
        <div>
          <p className="detail__id">{`TASK ${task.id}`}</p>
          <h2 className="detail__title">{task.title}</h2>
        </div>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onClose}
          aria-label="fechar detalhe"
        >
          ✕
        </button>
      </div>

      <Group title="Identidade">
        <Field label="objetivo">{task.objective}</Field>
        <Field label="descrição">{task.description ?? EMPTY}</Field>
        <Field label="fase">{task.phase}</Field>
        <Field label="estado">
          <span data-testid="detail-status">
            <span aria-hidden="true">{`${style.icon} `}</span>
            {style.label}
            {waiting === undefined ? null : (
              <span className="detail__waiting" data-testid="waiting-summary">
                {` · ${waiting.summary}`}
              </span>
            )}
          </span>
        </Field>
      </Group>

      {waiting === undefined ? null : (
        <Group title="Espera" tone="wait">
          <Field label="motivo">
            <span data-testid="waiting-cause">{waiting.summary}</span>
          </Field>
          <Field label="por quê">
            <span data-testid="waiting-detail">{waiting.detail}</span>
          </Field>
          <Field label="o que resolve">
            <span data-testid="waiting-needs">{waiting.needs ?? EMPTY}</span>
          </Field>
          {waiting.waitingOn.length === 0 ? null : (
            <Field label="esperando por">
              <ul className="inline-list" data-testid="waiting-on">
                {waiting.waitingOn.map((dependency) => (
                  <li key={dependency.id}>
                    <span aria-hidden="true">{`${taskStatusStyle(dependency.status).icon} `}</span>
                    {`${dependency.id} ${dependency.status}`}
                  </li>
                ))}
              </ul>
            </Field>
          )}
        </Group>
      )}

      <Group title="Atividade">
        <Field label="último sinal">
          <span data-testid="activity-last">
            {pulse.last === undefined
              ? 'nenhum sinal medido para esta task'
              : `${pulse.last.label} · há ${formatDuration(pulse.sinceMs)}`}
          </span>
        </Field>
        <Field label="agente">
          <span data-testid="activity-live">
            {pulse.last === undefined
              ? 'sem tentativa registrada'
              : pulse.live
                ? 'processo em andamento — derivado dos eventos do run'
                : 'sem processo em andamento'}
          </span>
        </Field>
        <Field label="linha do tempo">
          {pulse.steps.length === 0 ? (
            EMPTY
          ) : (
            <ol className="activity" data-testid="activity-steps">
              {pulse.steps.map((step) => (
                <li key={`${step.seq}:${step.kind}`} data-kind={step.kind}>
                  <span className="activity__icon" aria-hidden="true">
                    {ACTIVITY_ICON[step.kind]}
                  </span>
                  <span className="activity__ts">{formatClock(step.at)}</span>
                  <span className="activity__label">{step.label}</span>
                  <span className="activity__source">{step.source}</span>
                </li>
              ))}
            </ol>
          )}
        </Field>
      </Group>

      <Group title="Grafo">
        <Field label="depende de">
          {graph.dependencies.length === 0 ? (
            EMPTY
          ) : (
            <ul className="inline-list">
              {graph.dependencies.map((dep) => (
                <li key={dep.id}>
                  <span aria-hidden="true">{`${taskStatusStyle(dep.status).icon} `}</span>
                  {`${dep.id} ${dep.status}`}
                </li>
              ))}
            </ul>
          )}
        </Field>
        <Field label="destrava">{list(graph.dependents)}</Field>
        <Field label="caminho crítico">{graph.onCriticalPath ? 'sim' : 'não'}</Field>
      </Group>

      <Group title="Escopo">
        <Field label="touches">{list(scope.touches)}</Field>
        <Field label="reads">{list(scope.reads)}</Field>
        <Field label="violações de escopo">{list(scope.outOfScopePaths)}</Field>
      </Group>

      <Group title="Execução">
        <Field label="provider">{execution.provider ?? EMPTY}</Field>
        <Field label="executor">
          {execution.executor === undefined
            ? EMPTY
            : `${execution.executor.profileId} · ${execution.executor.providerId}${
                execution.executor.model === undefined ? '' : ` · ${execution.executor.model}`
              }`}
        </Field>
        <Field label="tentativa">
          {execution.attempt === undefined
            ? EMPTY
            : `${execution.attempt.number} de ${execution.attempt.max}`}
        </Field>
        <Field label="início">{formatClock(execution.startedAt)}</Field>
        <Field label="duração">{formatDuration(execution.durationMs)}</Field>
      </Group>

      <Group title="Revisão">
        <Field label="revisor">
          {review.reviewer === undefined ? EMPTY : review.reviewer.profileId}
        </Field>
        <Field label="provider do revisor">
          {review.reviewerProvider ?? review.reviewer?.providerId ?? EMPTY}
        </Field>
        <Field label="política de revisão">
          <span data-testid="review-policy">{review.policy ?? EMPTY}</span>
        </Field>
        <Field label="política rebaixada">
          {review.policyOutcome === undefined
            ? EMPTY
            : review.policyOutcome === 'downgraded'
              ? 'sim — rebaixada'
              : 'não — satisfeita'}
        </Field>
        <Field label="veredito">{review.verdict ?? EMPTY}</Field>
        <Field label="findings">
          {review.findings.length === 0 ? (
            EMPTY
          ) : (
            <ul className="findings">
              {review.findings.map((finding) => (
                <li key={`${finding.path ?? ''}:${finding.line ?? 0}:${finding.message}`}>
                  <span className="findings__severity">{finding.severity}</span>
                  {finding.path === undefined
                    ? null
                    : ` ${finding.path}${finding.line === undefined ? '' : `:${finding.line}`}`}
                  {` — ${finding.message}`}
                </li>
              ))}
            </ul>
          )}
        </Field>
      </Group>

      <Group title="Isolamento">
        <Field label="worktree">
          {isolation.worktreePath === undefined ? (
            EMPTY
          ) : (
            <span className="detail__path">
              <code data-testid="worktree-path">{isolation.worktreePath}</code>
              <CopyButton value={isolation.worktreePath} />
            </span>
          )}
        </Field>
        <Field label="branch">
          <span data-testid="branch">{isolation.branch ?? EMPTY}</span>
        </Field>
        <Field label="modo">{isolation.kind ?? EMPTY}</Field>
        <Field label="commit base">{isolation.baseCommit ?? EMPTY}</Field>
        <Field label="commit da tentativa">{isolation.commit ?? EMPTY}</Field>
      </Group>

      <Group title="Qualidade">
        <Field label="contrato de validação">{list(quality.validation)}</Field>
        <Field label="gate">
          {quality.gate ?? EMPTY}
          {quality.gateStatus === undefined ? '' : ` · ${quality.gateStatus}`}
        </Field>
        <Field label="comandos">
          {quality.commandResults.length === 0 ? (
            EMPTY
          ) : (
            <ul className="commands">
              {quality.commandResults.map((result) => (
                <li key={`${result.command}@${result.cwd}`}>
                  <code>{result.command}</code>
                  {` → exit ${result.exitCode ?? 'null'} · ${formatDuration(result.durationMs)}`}
                  {result.stdoutRef === undefined ? null : (
                    <span className="commands__ref">{result.stdoutRef}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Field>
      </Group>

      <Group title="Fatos">
        <Field label="arquivos alterados">
          {facts.filesChanged.length === 0 ? (
            EMPTY
          ) : (
            <ul className="files">
              {facts.filesChanged.map((file) => (
                <li key={file.path}>
                  <span className="files__kind">{file.change}</span>
                  <code>{file.path}</code>
                  <span className="files__stat">{`+${file.added} −${file.removed}`}</span>
                </li>
              ))}
            </ul>
          )}
        </Field>
        <Field label="diff stat">
          {`${facts.diffStat.files} arquivos · +${facts.diffStat.added} −${facts.diffStat.removed}`}
        </Field>
        <Field label="evidências">
          {facts.evidence.length === 0 ? (
            EMPTY
          ) : (
            <ul className="evidence">
              {facts.evidence.map((item) => (
                <li key={`${item.kind}:${item.sourceId}`}>
                  {`${item.kind} · ${item.sourceId}`}
                  {item.artifactPath === undefined ? null : <code>{item.artifactPath}</code>}
                  <span className="evidence__digest">{item.digest}</span>
                </li>
              ))}
            </ul>
          )}
        </Field>
      </Group>

      <Group title="Falha" tone={failure === undefined ? undefined : 'fail'}>
        {failure === undefined ? (
          <Field label="failureReason">
            <span data-testid="failure-code">sem falha registrada</span>
          </Field>
        ) : (
          <>
            <Field label="código">
              <span data-testid="failure-code">
                {failure.code}
                {failure.detail === undefined ? '' : ` — ${failure.detail}`}
              </span>
            </Field>
            <Field label="tentativa">
              <span data-testid="failure-attempt">
                {failure.attempt === undefined
                  ? EMPTY
                  : `${failure.attempt.number} de ${failure.attempt.max}`}
              </span>
            </Field>
            <Field label="fornecedor">
              <span data-testid="failure-provider">{failure.provider ?? EMPTY}</span>
            </Field>
            <Field label="violação de escopo">
              <span data-testid="failure-scope">
                {failure.scope.violated
                  ? `sim — ${failure.scope.paths.join(', ')}`
                  : 'não — nenhum caminho fora de touches'}
              </span>
            </Field>
            <Field label="gate">
              <span data-testid="failure-gate">
                {`${failure.gate.label}${
                  failure.gate.id === undefined ? '' : ` · gate ${failure.gate.id}`
                } · ${failure.gate.commands} comando(s)`}
              </span>
            </Field>
            <Field label="retry">
              <span data-testid="failure-retry" data-retry={failure.retry}>
                {failure.retryDetail}
              </span>
            </Field>
          </>
        )}
      </Group>

      {blocked === undefined ? null : (
        <Group title="Bloqueio" tone="block">
          <Field label="por quê">
            <span data-testid="blocked-reason">{`${blocked.kind} — ${blocked.reason}`}</span>
          </Field>
          <Field label="o que resolve">
            <span data-testid="blocked-needs">{blocked.needs}</span>
          </Field>
          <Field label="levantado por">
            {`${blocked.raisedBy} · ${formatClock(blocked.raisedAt)}`}
          </Field>
          <Field label="dependentes parados">
            {blocked.dependents.length === 0 ? (
              'nenhum'
            ) : (
              <ul className="inline-list" data-testid="blocked-dependents">
                {blocked.dependents.map((dependent) => (
                  <li key={dependent.id}>
                    <span aria-hidden="true">{`${taskStatusStyle(dependent.status).icon} `}</span>
                    {`${dependent.id} ${dependent.status}${dependent.direct ? '' : ' (indireto)'}`}
                  </li>
                ))}
              </ul>
            )}
          </Field>
        </Group>
      )}

      <Group title="Log do agente">
        <Field label="referências">
          {logRefs.length === 0 ? (
            <span data-testid="log-refs-empty">
              sem referência de log do agente persistida para esta task
            </span>
          ) : (
            <ul className="logrefs" data-testid="log-refs">
              {logRefs.map((ref) => (
                <li key={ref.ref}>
                  <span className="logrefs__label">{ref.label}</span>
                  <code>{ref.ref}</code>
                  <CopyButton value={ref.ref} label="copiar referência" />
                </li>
              ))}
            </ul>
          )}
        </Field>
      </Group>

      <Group title="Tentativas">
        <Field label="histórico">
          {task.attempts.length === 0 ? (
            EMPTY
          ) : (
            <ol className="attempts">
              {task.attempts.map((attempt) => (
                <li key={attempt.id}>
                  <strong>{`TENTATIVA ${attempt.attemptNumber}`}</strong>
                  {` ${attempt.result ?? 'em andamento'}`}
                  {attempt.failure === undefined ? '' : ` · ${attempt.failure.failureCode}`}
                  {attempt.gateStatus === undefined ? '' : ` · gate ${attempt.gateStatus}`}
                  {attempt.reviewVerdict === undefined ? '' : ` · review ${attempt.reviewVerdict}`}
                  {` · ${formatDuration(attempt.durationMs)}`}
                </li>
              ))}
            </ol>
          )}
        </Field>
      </Group>

      <Group title="Eventos">
        <Field label="linha do tempo desta task">
          {task.events.length === 0 ? (
            EMPTY
          ) : (
            <ul className="events events--task">
              {task.events.map((event) => (
                <li key={event.seq}>
                  <span className="events__ts">{formatClock(event.ts)}</span>
                  <span className="events__type">{event.type}</span>
                </li>
              ))}
            </ul>
          )}
        </Field>
      </Group>

      <TaskActions
        task={task}
        busy={busy}
        onRetry={onRetry}
        onUnblock={onUnblock}
        onSkip={onSkip}
      />
    </aside>
  )
}
