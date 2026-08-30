import type { CompileReportDto, DiagnosticDto, ProviderHealthDto } from '@agentic/schemas'
import { type JSX, useEffect, useRef, useState } from 'react'
import { ProvidersPanel } from './ProvidersPanel.js'

/** Partida tem tres estados visiveis — e um clique so cria um run (DASHBOARD 2.1). */
export type StartPhase = 'idle' | 'starting' | 'running'

const START_LABEL: Record<StartPhase, string> = {
  idle: 'START MISSION',
  starting: 'iniciando…',
  running: 'run em andamento',
}

export interface StartMissionProps {
  readonly report: CompileReportDto
  /** Aprovar e ato humano registrado com `actor` — nao existe aprovacao automatica. */
  readonly approved: boolean
  readonly providers: readonly ProviderHealthDto[]
  readonly busy?: boolean
  readonly error?: string
  /** Fase informada por quem conhece o run; a guarda interna vale de qualquer forma. */
  readonly startPhase?: StartPhase
  readonly onApprove: (actor: string, note: string) => void
  readonly onStart: (acceptWarnings: boolean, actor: string) => void
}

function bySeverity(
  report: CompileReportDto,
  severity: DiagnosticDto['severity'],
): DiagnosticDto[] {
  return report.diagnostics.filter((diagnostic) => diagnostic.severity === severity)
}

function DiagnosticList({
  items,
  testId,
}: {
  readonly items: readonly DiagnosticDto[]
  readonly testId: string
}): JSX.Element {
  return (
    <ul className="diagnostics" data-testid={testId}>
      {items.map((item) => (
        <li key={`${item.code}:${item.targets.join(',')}`} data-severity={item.severity}>
          <span className="diagnostics__code">{item.code}</span>
          <span className="diagnostics__message">{item.message}</span>
          {item.targets.length === 0 ? null : (
            <span className="diagnostics__targets">{item.targets.join(' ')}</span>
          )}
          {item.hint === undefined ? null : <span className="diagnostics__hint">{item.hint}</span>}
        </li>
      ))}
    </ul>
  )
}

/**
 * Tela de missao compilada (DASHBOARD 2.1). Um clique: o usuario nao dispara task a task, o
 * orquestrador descobre todas as `READY`.
 */
export function StartMission({
  report,
  approved,
  providers,
  busy = false,
  error,
  startPhase,
  onApprove,
  onStart,
}: StartMissionProps): JSX.Element {
  const [actor, setActor] = useState('')
  const [note, setNote] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [pressed, setPressed] = useState(false)
  /**
   * Idempotencia do clique: o `ref` fecha a janela entre dois cliques no mesmo tick, antes
   * de qualquer re-render. Dois cliques nunca viram dois `POST /api/runs`.
   */
  const fired = useRef(false)

  // Partida que falhou volta a ser possivel: o erro fica a vista e o botao destrava.
  useEffect(() => {
    if (error === undefined) return
    fired.current = false
    setPressed(false)
  }, [error])

  /**
   * Quem controla o run pode devolver a fase para `idle` (a partida falhou). Sem isto, uma
   * segunda falha com a MESMA mensagem nao mudaria `error` e o botao ficaria travado.
   */
  useEffect(() => {
    if (startPhase !== 'idle') return
    fired.current = false
    setPressed(false)
  }, [startPhase])

  const phase: StartPhase =
    startPhase === 'running'
      ? 'running'
      : startPhase === 'starting' || pressed || busy
        ? 'starting'
        : 'idle'

  const fireStart = (acceptWarnings: boolean): void => {
    if (phase !== 'idle' || fired.current) return
    fired.current = true
    setPressed(true)
    onStart(acceptWarnings, actor.trim())
  }

  const errors = bySeverity(report, 'ERROR')
  const warnings = bySeverity(report, 'WARNING')
  const infos = bySeverity(report, 'INFO')
  const blocked = errors.length > 0 || !report.ok
  const unavailable = providers.filter(
    (provider) => provider.installed === false || provider.ready === false,
  )

  return (
    <main className="start" aria-label="Missão compilada">
      <div className="start__head">
        <h1 className="start__mission">{report.missionId}</h1>
        <span className="start__status" data-testid="mission-status">
          <span aria-hidden="true">{approved ? '◔' : '○'}</span>
          {approved ? ' APPROVED' : ' DRAFT'}
        </span>
      </div>

      <p className="start__stats">
        {`${report.stats.tasks} tasks · ${report.stats.phases} fases · caminho crítico ${report.stats.criticalPathLength} tasks · ${report.stats.waves} ondas · ${warnings.length} avisos · ${errors.length} erros`}
      </p>

      {errors.length > 0 ? (
        <section className="start__block start__block--error" aria-label="Erros de compilação">
          <h2>{`${errors.length} erro(s) — corrija o YAML da missão`}</h2>
          <DiagnosticList items={errors} testId="diagnostics-error" />
          <p className="start__hint">
            Com qualquer ERROR não existe partida: o contrato versionado é o YAML.
          </p>
        </section>
      ) : null}

      {warnings.length > 0 ? (
        <section className="start__block start__block--warning" aria-label="Avisos de compilação">
          <h2>{`${warnings.length} aviso(s)`}</h2>
          <DiagnosticList items={warnings} testId="diagnostics-warning" />
        </section>
      ) : null}

      {infos.length > 0 ? (
        <section className="start__block" aria-label="Informações de compilação">
          <DiagnosticList items={infos} testId="diagnostics-info" />
        </section>
      ) : null}

      <ProvidersPanel providers={providers} />
      {unavailable.length > 0 ? (
        <p className="start__unavailable" role="alert">
          {`provider indisponível: ${unavailable.map((p) => p.providerId).join(', ')}`}
        </p>
      ) : null}

      <div className="start__actor">
        <label htmlFor="actor">actor (quem está aprovando/iniciando)</label>
        <input
          id="actor"
          className="actions__input"
          value={actor}
          onChange={(event) => setActor(event.target.value)}
          placeholder="seu identificador"
        />
      </div>

      {approved ? null : (
        <section className="start__approve" aria-label="Aprovar missão">
          <label htmlFor="approve-note">nota da aprovação (opcional)</label>
          <input
            id="approve-note"
            className="actions__input"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || blocked || actor.trim().length === 0}
            onClick={() => onApprove(actor.trim(), note.trim())}
          >
            aprovar missão
          </button>
        </section>
      )}

      {blocked ? null : (
        <section className="start__go" aria-label="Partida">
          {confirming && warnings.length > 0 ? (
            <div className="start__confirm">
              <p>
                {`${warnings.length} aviso(s) pendente(s). Os avisos continuam à vista — confirme para iniciar mesmo assim.`}
              </p>
              <button
                type="button"
                className="btn btn--primary"
                data-testid="confirm-start"
                data-phase={phase}
                aria-busy={phase === 'starting'}
                disabled={phase !== 'idle'}
                onClick={() => fireStart(true)}
              >
                {phase === 'idle'
                  ? `confirmar partida com ${warnings.length} aviso(s)`
                  : START_LABEL[phase]}
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => setConfirming(false)}>
                cancelar
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn--primary btn--start"
              data-testid="start-mission"
              data-phase={phase}
              aria-busy={phase === 'starting'}
              disabled={phase !== 'idle' || !approved || actor.trim().length === 0}
              onClick={() => {
                if (phase !== 'idle') return
                if (warnings.length > 0) setConfirming(true)
                else fireStart(false)
              }}
            >
              {START_LABEL[phase]}
            </button>
          )}
          <p className="start__phase" role="status" data-testid="start-phase">
            {phase === 'idle'
              ? 'pronta para partir'
              : phase === 'starting'
                ? 'iniciando o run — aguarde a confirmação do control plane'
                : 'run em andamento'}
          </p>
          {approved ? null : <p className="start__hint">START MISSION exige missão APPROVED.</p>}
        </section>
      )}

      {error === undefined ? null : (
        <p className="start__error" role="alert">
          {error}
        </p>
      )}
    </main>
  )
}
