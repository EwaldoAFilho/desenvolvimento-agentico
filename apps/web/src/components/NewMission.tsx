import type {
  PlanMissionCommand,
  PlanMissionResultDto,
  PlannerDto,
  PlanningFailureDto,
  RunSnapshot,
} from '@agentic/schemas'
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  describeFailure,
  getPlanners,
  getRunSnapshot,
  type PlanOutcome,
  planMission,
} from '../api.js'
import type { Grouping } from '../lib/dag-layout.js'
import { withDeadline } from '../lib/deadline.js'
import { formatDuration } from '../lib/format.js'
import {
  canPlanWith,
  defaultPlannerOf,
  plannerOptionLabel,
  plannerStateStyle,
  planningDiagnosisOf,
  revisionsText,
  subscriptionNoticeOf,
} from '../lib/planning.js'
import { DagCanvas } from './DagCanvas.js'

/**
 * Leituras e comandos da tela de nova missao. Ficam numa porta para que a jornada inteira
 * seja testavel sem servidor e — o que importa mais — sem gastar assinatura de ninguem: a
 * suite exercita a MAQUINA da tela, nunca um planejador de verdade.
 */
export interface NewMissionDeps {
  readonly loadPlanners: () => Promise<readonly PlannerDto[]>
  readonly plan: (command: PlanMissionCommand) => Promise<PlanOutcome>
  readonly loadSnapshot: (runId: string) => Promise<RunSnapshot>
}

const DEFAULT_DEPS: NewMissionDeps = {
  loadPlanners: getPlanners,
  plan: planMission,
  loadSnapshot: getRunSnapshot,
}

/**
 * Teto das leituras curtas (quem planeja, e o grafo do rascunho). NAO vale para o
 * planejamento em si: planejar com agente de verdade leva minutos e o prazo dele e do control
 * plane — cortar aqui deixaria orfa uma missao que acabou de ser gravada.
 */
export const READ_TIMEOUT_MS = 15_000

/** O rascunho como a tela o recebeu: o que o control plane gravou, mais o grafo dele. */
interface Draft {
  readonly result: PlanMissionResultDto
  readonly snapshot?: RunSnapshot
  /** O rascunho existe mesmo quando o desenho falha — e isso precisa ficar dito. */
  readonly snapshotError?: string
}

export interface NewMissionProps {
  readonly deps?: Partial<NewMissionDeps>
  /** Fornecedor padrao do projeto, quando ele declara um. Nunca inventamos um. */
  readonly defaultPlannerId?: string
  readonly onCancel: () => void
  readonly onOpenMission: (missionId: string) => void
  readonly readTimeoutMs?: number
}

function PlannerChoice({
  planners,
  chosen,
  onChoose,
}: {
  readonly planners: readonly PlannerDto[]
  readonly chosen: PlannerDto
  readonly onChoose: (providerId: string) => void
}): JSX.Element {
  const style = plannerStateStyle(chosen.state)
  if (planners.length === 1) {
    return (
      <div className="plan__field" data-testid="planner-single">
        <span className="plan__label">quem planeja</span>
        <p className="plan__only">
          <span aria-hidden="true">{chosen.simulated ? '○' : style.icon}</span>{' '}
          {plannerOptionLabel(chosen)}
        </p>
        <p className="plan__hint">único planejador declarado no projeto — não há o que escolher.</p>
      </div>
    )
  }
  return (
    <div className="plan__field">
      <label className="plan__label" htmlFor="plan-planner">
        quem planeja
      </label>
      <select
        id="plan-planner"
        className="plan__select"
        value={chosen.providerId}
        onChange={(event) => onChoose(event.target.value)}
      >
        {planners.map((planner) => (
          <option key={planner.providerId} value={planner.providerId}>
            {plannerOptionLabel(planner)}
          </option>
        ))}
      </select>
      <p className="plan__hint" data-testid="planner-state">
        <span aria-hidden="true">{chosen.simulated ? '○' : style.icon}</span>{' '}
        {chosen.simulated ? 'planejador simulado' : `ambiente: ${style.label}`}
      </p>
    </div>
  )
}

function PlanningFailureBlock({ failure }: { readonly failure: PlanningFailureDto }): JSX.Element {
  const diagnosis = planningDiagnosisOf(failure)
  return (
    <section
      className="plan__failure"
      aria-label="Falha de planejamento"
      data-testid="plan-failure"
      data-code={failure.code}
    >
      <h2 className="plan__failure-title">
        <span aria-hidden="true">✖</span> {diagnosis.title}
      </h2>
      <p className="plan__failure-origin">
        <code>{failure.code}</code>
        {' · planejador '}
        <code>{failure.plannerId}</code>
        {` · ${revisionsText(failure.revisions)}`}
      </p>
      <p className="plan__failure-message" role="alert" data-testid="plan-failure-message">
        {failure.message}
      </p>
      <p className="plan__hint">{diagnosis.hint}</p>
      {failure.problems.length === 0 ? null : (
        <ul className="plan__problems" data-testid="plan-problems">
          {failure.problems.map((problem) => (
            <li key={`${problem.path}:${problem.message}`}>
              <code>{problem.path.length === 0 ? 'plano' : problem.path}</code>
              <span>{problem.message}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="plan__hint">
        Nenhum arquivo de missão foi gravado. O seu pedido continua acima: ajuste e peça de novo.
      </p>
    </section>
  )
}

/**
 * De texto livre a rascunho desenhado. A tela nao pede validacao nem compilacao ao usuario:
 * quem aciona o planejador, grava o arquivo, compila e devolve o grafo e o control plane —
 * aqui so ha o pedido, o aviso do que ele custa, e o desenho do que voltou.
 *
 * Nada nesta tela aprova nem executa (P15): o run nasce `DRAFT` e o proximo ato e humano.
 */
export function NewMission({
  deps,
  defaultPlannerId,
  onCancel,
  onOpenMission,
  readTimeoutMs = READ_TIMEOUT_MS,
}: NewMissionProps): JSX.Element {
  const api = useMemo<NewMissionDeps>(() => ({ ...DEFAULT_DEPS, ...deps }), [deps])

  const [planners, setPlanners] = useState<readonly PlannerDto[] | undefined>(undefined)
  const [plannersError, setPlannersError] = useState<string | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)

  const [prompt, setPrompt] = useState('')
  const [actor, setActor] = useState('')
  const [picked, setPicked] = useState<string | undefined>(undefined)
  const [accepts, setAccepts] = useState(false)

  const [planning, setPlanning] = useState(false)
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  const [failure, setFailure] = useState<PlanningFailureDto | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const [grouping, setGrouping] = useState<Grouping>('phase')

  /** Idempotencia do clique: nem duplo clique nem re-render pedem dois planos. */
  const asked = useRef(false)

  useEffect(() => {
    let cancelled = false
    setPlanners(undefined)
    setPlannersError(undefined)
    withDeadline(
      Promise.resolve(api.loadPlanners()),
      readTimeoutMs,
      `o control plane não respondeu quem planeja em ${formatDuration(readTimeoutMs)}`,
    )
      .then((list) => {
        if (!cancelled) setPlanners(list)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        // A contagem entra na mensagem porque duas falhas iguais em sequencia sao
        // indistinguiveis na tela: sem ela, "tentar novamente" parece nao ter feito nada.
        const detail = describeFailure(cause)
        setPlannersError(attempt === 0 ? detail : `${detail} (tentativa ${attempt + 1})`)
      })
    return () => {
      cancelled = true
    }
  }, [api, readTimeoutMs, attempt])

  // Relogio da espera. So existe ENQUANTO o planejamento corre: uma espera de minutos sem
  // nenhum sinal de vida e indistinguivel de tela pendurada.
  useEffect(() => {
    if (startedAt === undefined) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startedAt])

  const chosen = useMemo<PlannerDto | undefined>(() => {
    if (planners === undefined) return undefined
    const asPicked = planners.find((planner) => planner.providerId === picked)
    return asPicked ?? defaultPlannerOf(planners, defaultPlannerId)
  }, [planners, picked, defaultPlannerId])

  // Trocar de planejador zera o aceite: consentimento dado para um fornecedor nao vale para
  // outro — seria aceitar consumo de uma assinatura sem ter lido o aviso dela.
  const choose = useCallback((providerId: string): void => {
    setPicked(providerId)
    setAccepts(false)
  }, [])

  const notice = chosen === undefined ? undefined : subscriptionNoticeOf(chosen)

  /** Truncado no segundo: milissegundo de espera nao diz nada a quem esta esperando. */
  const elapsedMs =
    startedAt === undefined ? 0 : Math.floor(Math.max(0, now - startedAt) / 1000) * 1000

  const blocked = ((): string | undefined => {
    if (chosen === undefined) return undefined
    if (!canPlanWith(chosen)) {
      return `${chosen.providerId} está indisponível (${plannerStateStyle(chosen.state).label}): planejar com ele falharia.`
    }
    if (prompt.trim().length === 0) return 'descreva o que você quer para continuar.'
    if (actor.trim().length === 0) return 'informe quem está pedindo o plano.'
    if (notice?.consumes === true && !accepts) {
      return 'confirme o consumo da assinatura para continuar.'
    }
    return undefined
  })()

  const submit = useCallback((): void => {
    if (chosen === undefined || planning || asked.current || blocked !== undefined) return
    asked.current = true
    setPlanning(true)
    setStartedAt(Date.now())
    setNow(Date.now())
    setFailure(undefined)
    setError(undefined)

    api
      .plan({
        prompt: prompt.trim(),
        plannerId: chosen.providerId,
        acceptsSubscriptionUse: accepts && !chosen.simulated,
        actor: actor.trim(),
      })
      .then(async (outcome) => {
        if (outcome.kind === 'refused') {
          setFailure(outcome.failure)
          return
        }
        // A missao JA existe a partir daqui. O desenho pode falhar; o rascunho, nao se perde.
        const result = outcome.result
        setDraft({ result })
        try {
          const snapshot = await withDeadline(
            Promise.resolve(api.loadSnapshot(result.run.id)),
            readTimeoutMs,
            `o grafo do rascunho não chegou em ${formatDuration(readTimeoutMs)}`,
          )
          setDraft({ result, snapshot })
        } catch (cause: unknown) {
          setDraft({ result, snapshotError: describeFailure(cause) })
        }
      })
      .catch((cause: unknown) => setError(describeFailure(cause)))
      .finally(() => {
        asked.current = false
        setPlanning(false)
        setStartedAt(undefined)
      })
  }, [api, chosen, planning, blocked, prompt, actor, accepts, readTimeoutMs])

  const back = (
    <button type="button" className="btn btn--ghost" data-testid="plan-cancel" onClick={onCancel}>
      voltar ao projeto
    </button>
  )

  if (draft !== undefined) {
    const { result, snapshot, snapshotError } = draft
    const stats = result.report.stats
    const planner = planners?.find((item) => item.providerId === result.plannerId)
    return (
      <main className="plan plan--drawn" aria-label="Rascunho da missão">
        <header className="plan__head">
          <h1 className="plan__title">{result.missionId}</h1>
          <span className="plan__state" data-testid="draft-state">
            <span aria-hidden="true">◔</span> RASCUNHO
          </span>
        </header>
        <p className="plan__stats" data-testid="draft-stats">
          {`${stats.tasks} tasks · ${stats.phases} fases · caminho crítico ${stats.criticalPathLength} tasks · ${stats.waves} ondas · paralelismo máximo ${stats.maxParallelism} · ${stats.warnings} avisos · ${stats.errors} erros`}
        </p>
        <p className="plan__origin" data-testid="draft-origin">
          {'proposto por '}
          <code>{result.plannerId}</code>
          {` após ${revisionsText(result.revisions)} · gravado pelo control plane em `}
          <code>{result.file}</code>
        </p>
        {planner?.simulated === true ? (
          <p className="plan__simulated" data-testid="draft-simulated">
            <span aria-hidden="true">○</span>{' '}
            {`${result.plannerId} é um planejador simulado: este rascunho exercita a jornada e não é um plano de verdade.`}
          </p>
        ) : null}
        {result.rationale === undefined ? null : (
          <section className="plan__rationale" aria-label="Relato do planejador">
            <h2>relato do planejador</h2>
            <p>{result.rationale}</p>
            <p className="plan__hint">
              Relato é informação operacional: não decide transição de estado e não vale como
              evidência (P05).
            </p>
          </section>
        )}
        {snapshot === undefined ? (
          <p className="plan__empty" role="status" data-testid="draft-no-graph">
            {snapshotError === undefined
              ? 'desenhando o rascunho…'
              : `o rascunho foi gravado, mas o grafo dele não pôde ser lido: ${snapshotError}`}
          </p>
        ) : (
          <DagCanvas
            snapshot={snapshot}
            grouping={grouping}
            onGroupingChange={setGrouping}
            onSelectTask={() => {}}
          />
        )}
        <div className="plan__actions">
          <button
            type="button"
            className="btn btn--primary"
            data-testid="draft-review"
            onClick={() => onOpenMission(result.missionId)}
          >
            revisar e aprovar
          </button>
          {back}
        </div>
        <p className="plan__hint" data-testid="draft-nothing-approved">
          Nada foi aprovado nem executado: aprovar continua sendo ato humano registrado.
        </p>
      </main>
    )
  }

  return (
    <main className="plan" aria-label="Nova missão">
      <header className="plan__head">
        <h1 className="plan__title">nova missão</h1>
        {back}
      </header>
      <p className="plan__lead">
        Descreva o que você quer. O control plane aciona o planejador, grava o arquivo da missão,
        compila e desenha o DAG — você não precisa pedir validação nem compilação.
      </p>

      {planners === undefined && plannersError === undefined ? (
        <p className="plan__empty" role="status" data-testid="planners-loading">
          carregando quem pode planejar…
        </p>
      ) : null}

      {plannersError === undefined ? null : (
        <section className="plan__failure" aria-label="Planejadores não carregaram">
          <h2 className="plan__failure-title">
            <span aria-hidden="true">✖</span> não foi possível saber quem planeja
          </h2>
          <p className="plan__failure-message" role="alert" data-testid="planners-error">
            {plannersError}
          </p>
          <button
            type="button"
            className="btn"
            data-testid="planners-retry"
            onClick={() => setAttempt((count) => count + 1)}
          >
            tentar novamente
          </button>
        </section>
      )}

      {planners !== undefined && planners.length === 0 ? (
        <section className="plan__empty-state" aria-label="Nenhum planejador">
          <h2>nenhum planejador configurado</h2>
          <p className="plan__hint" data-testid="planners-empty">
            Planejar exige uma CLI local de agente declarada no projeto — nenhuma chave de API é
            pedida (P17). Declare um planejador em <code>.agentic/project.yaml</code> ou escreva o
            arquivo <code>*.mission.yaml</code> à mão; ele aparece compilado na Home.
          </p>
        </section>
      ) : null}

      {chosen === undefined ? null : (
        <form
          className="plan__form"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <div className="plan__field">
            <label className="plan__label" htmlFor="plan-prompt">
              o que você quer que seja feito
            </label>
            <textarea
              id="plan-prompt"
              className="plan__prompt"
              rows={7}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="descreva o resultado esperado, em texto livre"
            />
            <p className="plan__hint">
              Texto livre. Descreva o resultado, não o caminho: o plano em tasks, dependências e
              escopo é o que o planejador propõe.
            </p>
          </div>

          <PlannerChoice planners={planners ?? []} chosen={chosen} onChoose={choose} />

          <div className="plan__field">
            <label className="plan__label" htmlFor="plan-actor">
              actor (quem está pedindo o plano)
            </label>
            <input
              id="plan-actor"
              className="actions__input"
              value={actor}
              onChange={(event) => setActor(event.target.value)}
              placeholder="seu identificador"
            />
          </div>

          {notice === undefined ? null : (
            <section
              className="plan__notice"
              aria-label="Consumo de assinatura"
              data-testid="subscription-notice"
              data-consumes={notice.consumes}
            >
              <h2 className="plan__notice-title">
                <span aria-hidden="true">{notice.consumes ? '⚠' : '○'}</span> {notice.title}
              </h2>
              <p>{notice.detail}</p>
              {notice.consumes ? (
                <p className="plan__accept">
                  <input
                    type="checkbox"
                    id="plan-accepts"
                    checked={accepts}
                    onChange={(event) => setAccepts(event.target.checked)}
                  />
                  <label htmlFor="plan-accepts">
                    {`entendo que planejar aciona ${chosen.providerId} nesta máquina e consome a minha assinatura`}
                  </label>
                </p>
              ) : null}
            </section>
          )}

          <div className="plan__actions">
            <button
              type="submit"
              className="btn btn--primary btn--start"
              data-testid="plan-mission"
              data-phase={planning ? 'planning' : 'idle'}
              aria-busy={planning}
              disabled={planning || blocked !== undefined}
            >
              {planning ? 'planejando…' : 'propor plano'}
            </button>
          </div>

          <p className="plan__phase" role="status" data-testid="plan-phase">
            {planning
              ? `planejando com ${chosen.providerId} há ${formatDuration(elapsedMs)} — o prazo é do control plane; sair desta tela não cancela o plano`
              : (blocked ?? 'pronto para propor o plano')}
          </p>
        </form>
      )}

      {failure === undefined ? null : <PlanningFailureBlock failure={failure} />}

      {error === undefined ? null : (
        <p className="plan__error" role="alert" data-testid="plan-error">
          {error}
        </p>
      )}
    </main>
  )
}
