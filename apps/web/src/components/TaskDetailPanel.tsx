import type { TaskDetail } from '@agentic/schemas'
import type { JSX, ReactNode } from 'react'
import { formatClock, formatDuration } from '../lib/format.js'
import { taskStatusStyle } from '../lib/status.js'
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
  children,
}: {
  readonly title: string
  readonly children: ReactNode
}): JSX.Element {
  return (
    <section className="group" aria-label={title}>
      <h3 className="group__title">{title}</h3>
      <dl className="group__fields">{children}</dl>
    </section>
  )
}

const EMPTY = '—'

function list(values: readonly string[]): string {
  return values.length === 0 ? EMPTY : values.join(', ')
}

export interface TaskDetailPanelProps {
  readonly task: TaskDetail | undefined
  readonly loading?: boolean
  readonly busy?: boolean
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
          </span>
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

      <Group title="Falha">
        <Field label="failureReason">
          {task.failure === undefined
            ? EMPTY
            : `${task.failure.failureCode}${
                task.failure.detail === undefined ? '' : ` — ${task.failure.detail}`
              }`}
        </Field>
        <Field label="bloqueio">
          {task.blockage === undefined
            ? EMPTY
            : `${task.blockage.kind} — ${task.blockage.reason} (precisa: ${task.blockage.needs})`}
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
