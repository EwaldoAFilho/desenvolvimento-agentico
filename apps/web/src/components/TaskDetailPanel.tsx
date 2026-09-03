import type { TaskDetail } from '@agentic/schemas'
import type { JSX, ReactNode } from 'react'
import { useEditorActions } from '../editor-actions.js'
import { type ActivityStep, activityPulse } from '../lib/activity.js'
import { AGENT_LOG_ROLE_LABEL, agentLogView, MAX_LISTED_LOGS } from '../lib/agent-log.js'
import { blockedViewOf, failureViewOf } from '../lib/failure.js'
import { formatBytes, formatClock, formatDuration } from '../lib/format.js'
import { NO_CHANGES_READING, noChangesViewOf } from '../lib/no-changes.js'
import { taskStatusStyle } from '../lib/status.js'
import type { StalledDependent, WaitingReason } from '../lib/waiting.js'
import { CopyButton } from './CopyButton.js'
import { DetailGroup } from './DetailGroup.js'
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

const EMPTY = '—'

function list(values: readonly string[]): string {
  return values.length === 0 ? EMPTY : values.join(', ')
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
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
 * O card mostra pouco; o painel mostra tudo (DASHBOARD 5) — mas **nao tudo ao mesmo tempo**.
 * A hierarquia e: cabecalho com o que se le de relance (estado, quem executa, tentativa e
 * duracao), depois o que exige atencao agora (espera, falha, desfecho sem alteracao,
 * bloqueio, atividade) e por fim o material de referencia, atras de revelacao progressiva.
 *
 * Cada evidencia continua citavel: comando exato, `cwd`, exit code e o ponteiro para a saida
 * persistida.
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
  const editor = useEditorActions()
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
  const noChanges = noChangesViewOf(task)
  const logs = agentLogView(task)
  const key = (title: string): string => `${task.id}:${title}`

  const executorText =
    execution.executor === undefined
      ? (execution.provider ?? EMPTY)
      : `${execution.executor.profileId} (${execution.executor.providerId})`
  const reviewerText =
    review.reviewer === undefined
      ? 'sem revisor atribuído'
      : `${review.reviewer.profileId} (${review.reviewerProvider ?? review.reviewer.providerId})`
  const attemptText =
    execution.attempt === undefined
      ? 'sem tentativa'
      : `tentativa ${execution.attempt.number}/${execution.attempt.max}`

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

      {/* Sempre visivel: o minimo para saber o que esta acontecendo sem abrir nada. */}
      <dl className="summary" data-testid="task-summary">
        <div className="summary__item">
          <dt className="summary__label">estado</dt>
          <dd className="summary__value">
            <span data-testid="detail-status">
              <span aria-hidden="true">{`${style.icon} `}</span>
              {style.label}
              {waiting === undefined ? null : (
                <span className="detail__waiting" data-testid="waiting-summary">
                  {` · ${waiting.summary}`}
                </span>
              )}
            </span>
          </dd>
        </div>
        <div className="summary__item">
          <dt className="summary__label">fase</dt>
          <dd className="summary__value" data-testid="summary-phase">
            {task.phase}
          </dd>
        </div>
        <div className="summary__item">
          <dt className="summary__label">executor</dt>
          <dd className="summary__value" data-testid="summary-executor">
            {executorText}
          </dd>
        </div>
        <div className="summary__item">
          <dt className="summary__label">revisor</dt>
          <dd className="summary__value" data-testid="summary-reviewer">
            {reviewerText}
          </dd>
        </div>
        <div className="summary__item">
          <dt className="summary__label">tentativa</dt>
          <dd className="summary__value" data-testid="summary-attempt">
            {`${attemptText} · ${formatDuration(execution.durationMs)}`}
          </dd>
        </div>
      </dl>

      {waiting === undefined ? null : (
        <DetailGroup
          key={key('Espera')}
          title="Espera"
          tone="wait"
          hint={waiting.summary}
          defaultOpen
        >
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
        </DetailGroup>
      )}

      <DetailGroup
        key={key('Falha')}
        title="Falha"
        tone={failure === undefined ? undefined : 'fail'}
        hint={failure === undefined ? 'sem falha registrada' : failure.code}
        defaultOpen={failure !== undefined}
      >
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
            <Field label="evidência mais recente">
              <span data-testid="failure-evidence" data-origin={failure.evidence.origin}>
                {failure.evidence.label}
                {failure.evidence.ref === undefined ? null : (
                  <code className="evidence__ref">{failure.evidence.ref}</code>
                )}
              </span>
            </Field>
          </>
        )}
      </DetailGroup>

      {noChanges === undefined ? null : (
        <DetailGroup
          key={key('Desfecho sem alteração')}
          title="Desfecho sem alteração"
          tone="reading"
          hint={NO_CHANGES_READING}
          defaultOpen
        >
          <Field label="o que aconteceu">
            <ul className="statements" data-testid="no-changes-statements">
              {noChanges.statements.map((statement) => (
                <li key={statement.key} data-fact={statement.key}>
                  {statement.text}
                </li>
              ))}
            </ul>
          </Field>
          <Field label="desfecho do domínio">
            <span data-testid="no-changes-outcome">
              {`${noChanges.outcome} · ${noChanges.failureCode}`}
              {noChanges.failureDetail === undefined ? '' : ` — ${noChanges.failureDetail}`}
            </span>
          </Field>
          <Field label="gate">
            <span data-testid="no-changes-gate">{noChanges.gate.label}</span>
          </Field>
          <Field label="leitura da interface">
            <span data-testid="no-changes-reading">{NO_CHANGES_READING}</span>
          </Field>
        </DetailGroup>
      )}

      {blocked === undefined ? null : (
        <DetailGroup
          key={key('Bloqueio')}
          title="Bloqueio"
          tone="block"
          hint={blocked.kindLabel}
          defaultOpen
        >
          <Field label="tipo">
            <span data-testid="blocked-kind">{`${blocked.kind} — ${blocked.kindLabel}`}</span>
          </Field>
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
        </DetailGroup>
      )}

      <DetailGroup
        key={key('Atividade')}
        title="Atividade"
        hint={pulse.last === undefined ? 'sem sinal medido' : pulse.last.label}
        defaultOpen
      >
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
      </DetailGroup>

      <DetailGroup
        key={key('Identidade')}
        title="Identidade"
        hint={`${task.phase} · ${task.objective}`}
      >
        <Field label="objetivo">{task.objective}</Field>
        <Field label="descrição">{task.description ?? EMPTY}</Field>
        <Field label="fase">{task.phase}</Field>
      </DetailGroup>

      <DetailGroup
        key={key('Grafo')}
        title="Grafo"
        hint={`${plural(graph.dependencies.length, 'dependência', 'dependências')} · ${plural(
          graph.dependents.length,
          'dependente',
          'dependentes',
        )}`}
      >
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
      </DetailGroup>

      <DetailGroup
        key={key('Escopo')}
        title="Escopo"
        hint={
          scope.outOfScopePaths.length === 0
            ? `${plural(scope.touches.length, 'touch', 'touches')} · sem violação`
            : `${plural(scope.outOfScopePaths.length, 'violação', 'violações')} de escopo`
        }
      >
        <Field label="touches">{list(scope.touches)}</Field>
        <Field label="reads">{list(scope.reads)}</Field>
        <Field label="violações de escopo">{list(scope.outOfScopePaths)}</Field>
      </DetailGroup>

      <DetailGroup
        key={key('Execução')}
        title="Execução"
        hint={`${execution.provider ?? 'sem fornecedor'} · ${attemptText}`}
      >
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
      </DetailGroup>

      <DetailGroup
        key={key('Revisão')}
        title="Revisão"
        hint={review.verdict ?? 'sem veredito registrado'}
      >
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
      </DetailGroup>

      <DetailGroup
        key={key('Isolamento')}
        title="Isolamento"
        hint={isolation.branch ?? 'sem branch registrada'}
      >
        <Field label="worktree">
          {isolation.worktreePath === undefined ? (
            EMPTY
          ) : (
            <span className="detail__path">
              <code data-testid="worktree-path">{isolation.worktreePath}</code>
              <CopyButton value={isolation.worktreePath} />
              {editor?.openPath === undefined ? null : (
                <button
                  type="button"
                  className="detail__action"
                  onClick={() => editor.openPath?.(isolation.worktreePath ?? '')}
                >
                  abrir no editor
                </button>
              )}
            </span>
          )}
        </Field>
        <Field label="branch">
          <span data-testid="branch">{isolation.branch ?? EMPTY}</span>
        </Field>
        <Field label="modo">{isolation.kind ?? EMPTY}</Field>
        <Field label="commit base">{isolation.baseCommit ?? EMPTY}</Field>
        <Field label="commit da tentativa">{isolation.commit ?? EMPTY}</Field>
      </DetailGroup>

      <DetailGroup
        key={key('Qualidade')}
        title="Qualidade"
        hint={`${quality.gate ?? 'sem gate'}${
          quality.gateStatus === undefined ? '' : ` · ${quality.gateStatus}`
        }`}
      >
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
                  {result.truncated ? (
                    <span className="commands__cut" data-testid="command-truncated">
                      saída truncada — o trecho persistido não é a saída completa
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Field>
      </DetailGroup>

      <DetailGroup
        key={key('Fatos')}
        title="Fatos"
        hint={`${facts.diffStat.files} arquivos · +${facts.diffStat.added} −${facts.diffStat.removed}`}
      >
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
                  {editor?.openDiff === undefined ||
                  isolation.baseCommit === undefined ||
                  (isolation.commit ?? isolation.branch) === undefined ? null : (
                    <button
                      type="button"
                      className="detail__action"
                      onClick={() =>
                        editor.openDiff?.({
                          path: file.path,
                          base: isolation.baseCommit ?? '',
                          head: isolation.commit ?? isolation.branch ?? '',
                        })
                      }
                    >
                      diff
                    </button>
                  )}
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
      </DetailGroup>

      <DetailGroup key={key('Log do agente')} title="Log do agente" hint={logs.notice}>
        <Field label="integridade">
          <span data-testid="log-notice" data-truncated={logs.truncated}>
            {logs.notice}
          </span>
        </Field>
        <Field label="artefatos">
          {logs.artifacts.length === 0 ? (
            <span data-testid="agent-logs-empty">
              nenhum log do agente foi persistido para esta tentativa
            </span>
          ) : (
            <ul className="logrefs" data-testid="agent-logs">
              {logs.artifacts.map((artifact) => (
                <li key={`${artifact.seq}:${artifact.path}`} data-truncated={artifact.truncated}>
                  <span className="logrefs__label">
                    {`${AGENT_LOG_ROLE_LABEL[artifact.role]} · ${formatBytes(artifact.bytes)}`}
                    {artifact.truncated ? (
                      <span className="logrefs__cut" data-testid="agent-log-truncated">
                        {' truncado — a saída NÃO está completa'}
                      </span>
                    ) : null}
                  </span>
                  <code>{artifact.path}</code>
                  <CopyButton value={artifact.path} label="copiar caminho do log" />
                  {editor?.openPath === undefined ? null : (
                    <button
                      type="button"
                      className="detail__action"
                      onClick={() => editor.openPath?.(artifact.path)}
                    >
                      abrir log
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Field>
        <Field label="referências">
          {logs.refs.length === 0 ? (
            <span data-testid="log-refs-empty">
              sem referência de log do agente persistida para esta task
            </span>
          ) : (
            <ul className="logrefs" data-testid="log-refs">
              {logs.refs.map((ref) => (
                <li key={ref.ref}>
                  <span className="logrefs__label">{ref.label}</span>
                  <code>{ref.ref}</code>
                  <CopyButton value={ref.ref} label="copiar referência" />
                </li>
              ))}
            </ul>
          )}
        </Field>
        <Field label="limite da tela">
          <span data-testid="log-bounded">
            {`o conteúdo do artefato não é carregado aqui; a tela lista no máximo ${MAX_LISTED_LOGS} itens`}
            {logs.hiddenArtifacts + logs.hiddenRefs === 0
              ? ''
              : ` — ${logs.hiddenArtifacts + logs.hiddenRefs} não listado(s)`}
          </span>
        </Field>
      </DetailGroup>

      <DetailGroup
        key={key('Tentativas')}
        title="Tentativas"
        hint={plural(task.attempts.length, 'tentativa', 'tentativas')}
      >
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
      </DetailGroup>

      <DetailGroup
        key={key('Eventos')}
        title="Eventos"
        hint={plural(task.events.length, 'evento', 'eventos')}
      >
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
      </DetailGroup>

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
