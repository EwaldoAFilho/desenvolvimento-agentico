import type { CompileReportDto, DiagnosticDto, ProviderHealthDto } from '@agentic/schemas'
import { type JSX, type ReactNode, useEffect, useRef, useState } from 'react'
import { bySeverity, conflictKindOf, conflictsOf, planStatsLine } from '../lib/plan-review.js'
import { ProvidersPanel } from './ProvidersPanel.js'

/** Partida tem tres estados visiveis — e um clique so cria um run (DASHBOARD 2.1). */
export type StartPhase = 'idle' | 'starting' | 'running'

const START_LABEL: Record<StartPhase, string> = {
  idle: 'START MISSION',
  starting: 'iniciando…',
  running: 'run em andamento',
}

/** Qual ato o humano confirmou com os avisos a vista. Um de cada vez, nunca os dois. */
type Confirming = 'start' | 'approve-start'

export interface StartMissionProps {
  readonly report: CompileReportDto
  /** Aprovar e ato humano registrado com `actor` — nao existe aprovacao automatica. */
  readonly approved: boolean
  readonly providers: readonly ProviderHealthDto[]
  readonly busy?: boolean
  readonly error?: string
  /** Fase informada por quem conhece o run; a guarda interna vale de qualquer forma. */
  readonly startPhase?: StartPhase
  /** Revisao do plano (DAG, no aberto e caminho do YAML). Slot: esta tela segue pura. */
  readonly plan?: ReactNode
  readonly onApprove: (actor: string, note: string) => void
  readonly onStart: (acceptWarnings: boolean, actor: string) => void
  /**
   * Aprovar e executar num ato so — duas chamadas em ORDEM, nunca uma so. Opcional: sem ela a
   * tela continua oferecendo os dois atos separados, e nada muda para quem ja aprovou.
   */
  readonly onApproveAndStart?: (acceptWarnings: boolean, actor: string, note: string) => void
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
  plan,
  onApprove,
  onStart,
  onApproveAndStart,
}: StartMissionProps): JSX.Element {
  const [actor, setActor] = useState('')
  const [note, setNote] = useState('')
  const [confirming, setConfirming] = useState<Confirming | undefined>(undefined)
  const [pressed, setPressed] = useState(false)
  /**
   * Idempotencia do clique: o `ref` fecha a janela entre dois cliques no mesmo tick, antes
   * de qualquer re-render. Dois cliques nunca viram dois `POST /api/runs` — e a guarda vale
   * para os dois caminhos de partida, entao aprovar-e-executar tambem parte uma vez so.
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

  /**
   * As duas partidas passam pela MESMA guarda. `approve-start` e um ato do humano e duas
   * chamadas do controlador, em ordem: quem aprova fica registrado antes de existir execucao.
   */
  const fire = (kind: Confirming, acceptWarnings: boolean): void => {
    if (phase !== 'idle' || fired.current) return
    // A missao pode ter sido aprovada no meio do caminho — aprovacao aceita e partida
    // recusada, por exemplo. Nao ha o que aprovar de novo: o ato que resta e partir.
    const act = kind === 'approve-start' && !approved ? kind : 'start'
    if (act === 'approve-start' && onApproveAndStart === undefined) return
    fired.current = true
    setPressed(true)
    if (act === 'start') onStart(acceptWarnings, actor.trim())
    else onApproveAndStart?.(acceptWarnings, actor.trim(), note.trim())
  }

  const errors = bySeverity(report, 'ERROR')
  const warnings = bySeverity(report, 'WARNING')
  const infos = bySeverity(report, 'INFO')
  const conflicts = conflictsOf(report)
  const blocked = errors.length > 0 || !report.ok
  const noActor = actor.trim().length === 0
  /** Um ato so existe enquanto ha o que aprovar: aprovada, resta a partida. */
  const oneAct = !approved && onApproveAndStart !== undefined
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

      <p className="start__stats" data-testid="mission-stats">
        {planStatsLine(report)}
      </p>

      {/*
       * Conflito e leitura CRUZADA — quem se atropela com quem. O texto e o codigo de cada
       * diagnostico continuam na lista de avisos/erros logo abaixo: aqui a informacao nova e o
       * PAR. Zero conflitos tambem se escreve: silencio seria indistinguivel de "ninguem
       * olhou".
       */}
      <section className="start__block start__conflicts" aria-label="Conflitos do plano">
        <h2>{`conflitos — ${conflicts.length}`}</h2>
        {conflicts.length === 0 ? (
          <p className="start__hint" data-testid="conflicts-empty">
            nenhum conflito de escopo ou de dependência entre as tasks deste plano.
          </p>
        ) : (
          <ul className="conflicts" data-testid="conflicts">
            {conflicts.map((conflict) => (
              <li
                key={`${conflict.code}:${conflict.targets.join(',')}`}
                data-severity={conflict.severity}
              >
                <span className="conflicts__pair">
                  {conflict.targets.length === 0 ? 'plano inteiro' : conflict.targets.join(' ↔ ')}
                </span>
                <span className="conflicts__kind">{conflictKindOf(conflict.code)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

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

      {plan}

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
            disabled={busy || blocked || noActor}
            onClick={() => onApprove(actor.trim(), note.trim())}
          >
            aprovar missão
          </button>
          <p className="start__hint">
            Aprovar sozinho não executa nada: o run fica APPROVED esperando a partida.
          </p>
        </section>
      )}

      {blocked ? null : (
        <section className="start__go" aria-label="Partida">
          {confirming !== undefined && warnings.length > 0 ? (
            <div className="start__confirm">
              <p>
                {`${warnings.length} aviso(s) pendente(s). Os avisos continuam à vista — confirme para iniciar mesmo assim.`}
              </p>
              {confirming === 'approve-start' && !approved ? (
                <p className="start__hint" data-testid="confirm-approve-start">
                  {`Confirmar registra ${actor.trim()} como quem aprova e, em seguida, dispara a execução.`}
                </p>
              ) : null}
              <button
                type="button"
                className="btn btn--primary"
                data-testid="confirm-start"
                data-phase={phase}
                data-act={confirming}
                aria-busy={phase === 'starting'}
                disabled={phase !== 'idle'}
                onClick={() => fire(confirming, true)}
              >
                {phase === 'idle'
                  ? `confirmar partida com ${warnings.length} aviso(s)`
                  : START_LABEL[phase]}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setConfirming(undefined)}
              >
                cancelar
              </button>
            </div>
          ) : (
            <div className="start__acts">
              {/*
               * Um ato humano, duas chamadas em ordem: aprovar registra quem aprova e a
               * partida so acontece depois que o control plane confirmou a aprovacao. Nada
               * aqui aprova sozinho — sem `actor` o botao nao existe como acao.
               */}
              {oneAct ? (
                <button
                  type="button"
                  className="btn btn--primary btn--start"
                  data-testid="approve-and-start"
                  data-phase={phase}
                  aria-busy={phase === 'starting'}
                  disabled={phase !== 'idle' || noActor}
                  onClick={() => {
                    if (phase !== 'idle') return
                    if (warnings.length > 0) setConfirming('approve-start')
                    else fire('approve-start', false)
                  }}
                >
                  {phase === 'idle' ? 'aprovar e executar' : START_LABEL[phase]}
                </button>
              ) : null}
              {/* Com o ato unico a vista, a partida sozinha deixa de ser a acao primaria:
                  duas primarias lado a lado nao dizem qual e o caminho. */}
              <button
                type="button"
                className={`btn btn--start${oneAct ? '' : ' btn--primary'}`}
                data-testid="start-mission"
                data-phase={phase}
                aria-busy={phase === 'starting'}
                disabled={phase !== 'idle' || !approved || noActor}
                onClick={() => {
                  if (phase !== 'idle') return
                  if (warnings.length > 0) setConfirming('start')
                  else fire('start', false)
                }}
              >
                {START_LABEL[phase]}
              </button>
            </div>
          )}
          <p className="start__phase" role="status" data-testid="start-phase">
            {phase === 'idle'
              ? oneAct
                ? 'pronta para aprovar e partir — a tela vai sozinha para o DAG vivo'
                : 'pronta para partir'
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
