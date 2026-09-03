import type {
  ApproveMissionCommand,
  CompileReportDto,
  MissionSummaryDto,
  ProjectHomeDto,
  ProviderHealthDto,
  RunHeaderDto,
  StartRunCommand,
} from '@agentic/schemas'
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  approveMission,
  describeFailure,
  getCompileReport,
  getMissions,
  getProjectHome,
  getProviders,
  listRuns,
  startRun,
} from './api.js'
import { ErrorScreen } from './components/ErrorScreen.js'
import { NewMission, type NewMissionDeps } from './components/NewMission.js'
import { PlanReview, type PlanReviewDeps } from './components/PlanReview.js'
import { ProjectHome } from './components/ProjectHome.js'
import { RunDashboard } from './components/RunDashboard.js'
import { StartMission, type StartPhase } from './components/StartMission.js'
import type { RunStreamDeps } from './hooks/useRunStream.js'
import { formatDuration } from './lib/format.js'
import { activeRunOf } from './lib/home.js'

/**
 * Leituras e comandos que a tela inicial usa. Ficam numa porta para que o boot inteiro seja
 * testavel sem servidor: o que se prova aqui e a MAQUINA de estados da entrada, nao o HTTP.
 */
export interface AppDeps {
  readonly loadProjectHome: () => Promise<ProjectHomeDto>
  readonly loadCompileReport: (missionId: string) => Promise<CompileReportDto>
  readonly loadProviders: () => Promise<readonly ProviderHealthDto[]>
  readonly loadRuns: () => Promise<readonly RunHeaderDto[]>
  /** De onde sai o caminho do YAML da missao — o ajuste minimo mora nele (DASHBOARD 7). */
  readonly loadMissions: () => Promise<readonly MissionSummaryDto[]>
  readonly approve: (missionId: string, command: ApproveMissionCommand) => Promise<void>
  readonly start: (command: StartRunCommand) => Promise<string>
}

const DEFAULT_DEPS: AppDeps = {
  loadProjectHome: getProjectHome,
  loadCompileReport: getCompileReport,
  loadProviders: getProviders,
  loadRuns: listRuns,
  loadMissions: getMissions,
  approve: approveMission,
  start: startRun,
}

/**
 * `?run=`, `?mission=` e `?new=` sao os tres enderecos que a tela entende. Nada mais e
 * inventado. `new` tem endereco proprio para que a tela de nova missao sobreviva a um F5 e
 * para que uma execucao ativa nao a sequestre no meio do pedido.
 */
export interface Route {
  readonly run?: string
  readonly mission?: string
  readonly new?: true
}

function paramOf(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name)
  return value === null || value.length === 0 ? undefined : value
}

export function routeOf(search: string): Route {
  const params = new URLSearchParams(search)
  const run = paramOf(params, 'run')
  const mission = paramOf(params, 'mission')
  const fresh = paramOf(params, 'new')
  return {
    ...(run === undefined ? {} : { run }),
    ...(mission === undefined ? {} : { mission }),
    ...(fresh === undefined ? {} : { new: true as const }),
  }
}

function currentRoute(): Route {
  return typeof window === 'undefined' ? {} : routeOf(window.location.search)
}

/** `run` tem precedencia na URL tambem: dois deles juntos nunca sao escritos por nos. */
function searchOf(route: Route): string {
  const params = new URLSearchParams()
  if (route.run !== undefined) params.set('run', route.run)
  else if (route.mission !== undefined) params.set('mission', route.mission)
  else if (route.new === true) params.set('new', '1')
  const query = params.toString()
  return query.length === 0 ? '' : `?${query}`
}

/**
 * Estado do boot. Toda saida e terminal: Home, missao compilada ou erro com acao. `loading`
 * so existe enquanto ha requisicao em voo — nenhum caminho sai daqui sem escrever estado,
 * que era exatamente o defeito da tela presa em "carregando missao compilada".
 */
type Boot =
  | { readonly kind: 'loading' }
  | { readonly kind: 'home'; readonly home: ProjectHomeDto }
  | {
      readonly kind: 'mission'
      readonly report: CompileReportDto
      readonly providers: readonly ProviderHealthDto[]
      readonly approved: boolean
      /** Caminho do YAML. Ausente quando o control plane nao o informou — nunca inventado. */
      readonly missionFile?: string
    }
  | { readonly kind: 'error'; readonly message: string }

/**
 * Teto do boot. `fetch` nao tem prazo proprio: uma conexao aceita e nunca respondida deixa a
 * promessa pendente para sempre, e a tela ficaria carregando sem nada errado ter acontecido.
 * Estourado o prazo, a tela vira erro com acao — o pedido em voo ainda pode chegar e, se
 * chegar, ele ganha.
 */
export const BOOT_TIMEOUT_MS = 15_000

export interface AppProps {
  readonly deps?: Partial<AppDeps>
  /** Repassado ao dashboard de execucao; existe para o teste dispensar SSE de verdade. */
  readonly runStream?: RunStreamDeps
  /**
   * Repassado a tela de nova missao. Existe para que a jornada seja testavel sem servidor e,
   * sobretudo, sem acionar planejador de verdade: teste nunca consome assinatura (P17).
   * Precisa ser estavel entre renders — a tela recarrega os planejadores quando ele muda.
   */
  readonly newMission?: Partial<NewMissionDeps>
  /**
   * Repassado a revisao do plano. Existe pelo mesmo motivo: a jornada de revisar, ajustar e
   * aprovar precisa ser testavel sem servidor. Precisa ser estavel entre renders.
   */
  readonly planReview?: Partial<PlanReviewDeps>
  readonly bootTimeoutMs?: number
  /**
   * `history` (padrao): a rota vive na URL, com voltar/avancar do navegador. `memory`: a rota
   * vive so no estado — e o que a webview do editor usa, onde a URL nao e nossa.
   */
  readonly navigation?: 'history' | 'memory'
  /** Rota inicial em modo `memory` (em `history` a URL manda). */
  readonly initialRoute?: Route
  /** Observador de navegacao (o host do editor guarda a rota para restaurar a aba). */
  readonly onNavigate?: (route: Route) => void
  /** Sugestao para o campo `actor` das telas de aprovacao/planejamento (ex.: git user.name). */
  readonly defaultActor?: string
}

/**
 * Tres telas, uma precedencia: run na URL manda no que aparece; depois missao na URL; e, sem
 * nenhuma das duas, a Home do projeto — com o desvio para a execucao ATIVA, se houver.
 */
export function App({
  deps,
  runStream,
  newMission,
  planReview,
  bootTimeoutMs = BOOT_TIMEOUT_MS,
  navigation = 'history',
  initialRoute,
  onNavigate,
  defaultActor,
}: AppProps = {}): JSX.Element {
  const api = useMemo<AppDeps>(() => ({ ...DEFAULT_DEPS, ...deps }), [deps])

  const [route, setRoute] = useState<Route>(() =>
    navigation === 'memory' ? (initialRoute ?? {}) : currentRoute(),
  )
  const [boot, setBoot] = useState<Boot>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [startPhase, setStartPhase] = useState<StartPhase>('idle')
  const [error, setError] = useState<string | undefined>(undefined)

  /** Segunda guarda de idempotencia: nem um clique duplo nem um re-render criam dois runs. */
  const starting = useRef(false)
  const booted = useRef<Route | undefined>(undefined)
  /** Quantas vezes ESTA tela foi pedida de novo. Zera quando a rota muda. */
  const retries = useRef(0)

  const navigate = useCallback(
    (next: Route, replace = false): void => {
      if (navigation === 'history' && typeof window !== 'undefined') {
        const url = `${window.location.pathname}${searchOf(next)}`
        if (replace) window.history.replaceState({}, '', url)
        else window.history.pushState({}, '', url)
      }
      setRoute(next)
      onNavigate?.(next)
    },
    [navigation, onNavigate],
  )

  // Voltar e avancar no navegador sao navegacao de verdade: a tela acompanha a URL.
  useEffect(() => {
    if (navigation !== 'history' || typeof window === 'undefined') return
    const onPop = (): void => setRoute(currentRoute())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [navigation])

  // Em modo memoria, quem hospeda pode mandar a tela para outra rota (ex.: item da sidebar).
  useEffect(() => {
    if (navigation === 'memory' && initialRoute !== undefined) setRoute(initialRoute)
  }, [navigation, initialRoute])

  useEffect(() => {
    const previous = booted.current
    const sameRoute =
      previous?.run === route.run &&
      previous?.mission === route.mission &&
      previous?.new === route.new
    booted.current = route
    // `attempt` so muda quando alguem pede "tentar novamente"; a contagem e por TELA para
    // que a mensagem de uma rota nao carregue o numero de tentativas de outra.
    retries.current = sameRoute && attempt > 0 ? retries.current + 1 : 0
    starting.current = false
    setStartPhase('idle')
    setError(undefined)

    // A guarda de run ganha de tudo: com run na URL nao ha nada a carregar aqui e o
    // dashboard de execucao assume a tela sem passar por estado intermediario nenhum.
    if (route.run !== undefined) return

    // Nova missao tambem nao carrega nada aqui — e, sobretudo, nao passa pelo desvio
    // automatico da Home: uma execucao ativa nao pode sequestrar quem esta escrevendo o
    // pedido. A tela de nova missao busca o que precisa por conta.
    if (route.new === true) return

    let cancelled = false
    // Recarregar a MESMA tela nao apaga o que ja esta nela: quem pediu "atualizar" quer o
    // dado novo, nao um piscar de carregamento.
    if (sameRoute) setRefreshing(true)
    else setBoot({ kind: 'loading' })

    const bootHome = async (): Promise<Boot> => {
      const home = await api.loadProjectHome()
      const active = activeRunOf(home.runs)
      if (active === undefined) return { kind: 'home', home }
      // Desvio automatico SUBSTITUI a entrada do historico: com `pushState`, voltar cairia
      // na Home, que desviaria de novo — o botao de voltar viraria uma armadilha.
      navigate({ run: active.id }, true)
      return { kind: 'loading' }
    }

    const bootMission = async (missionId: string): Promise<Boot> => {
      const [report, providers, runs, missions] = await Promise.all([
        api.loadCompileReport(missionId),
        api.loadProviders(),
        api.loadRuns(),
        // O caminho do arquivo e conveniencia da revisao, nao condicao para a tela existir:
        // se a listagem falhar, perde-se o caminho — nunca o plano.
        api.loadMissions().catch(() => [] as readonly MissionSummaryDto[]),
      ])
      // `approved` sai de um run desta missao E DESTA VERSAO do plano. So o missionId nao
      // basta: um run APPROVED antigo faria um YAML novo nascer aprovado, habilitando a
      // execucao de um plano que ninguem inspecionou. Sem specHash dos dois lados a
      // comparacao nao e possivel, e a tela prefere pedir aprovacao de novo a presumi-la.
      const approved = runs.some(
        (run) =>
          run.missionId === report.missionId &&
          run.status === 'APPROVED' &&
          report.specHash !== undefined &&
          run.specHash === report.specHash,
      )
      const file = missions.find((mission) => mission.id === report.missionId)?.file
      return {
        kind: 'mission',
        report,
        providers,
        approved,
        ...(file === undefined ? {} : { missionFile: file }),
      }
    }

    const fail = (detail: string): void => {
      if (cancelled) return
      setRefreshing(false)
      // A contagem entra na mensagem porque duas falhas iguais em sequencia sao
      // indistinguiveis na tela: sem ela, "tentar novamente" parece nao ter feito nada.
      const count = retries.current
      setBoot({
        kind: 'error',
        message: count === 0 ? detail : `${detail} (tentativa ${count + 1})`,
      })
    }

    // Prazo do boot. Se o pedido em voo chegar depois, ele ganha: o `.finally` desarma o
    // relogio e a resposta de verdade substitui a mensagem.
    const deadline = setTimeout(
      () => fail(`o control plane não respondeu em ${formatDuration(bootTimeoutMs)}`),
      bootTimeoutMs,
    )

    const mission = route.mission
    void (mission === undefined ? bootHome() : bootMission(mission))
      .then((next) => {
        if (!cancelled) setBoot(next)
      })
      .catch((cause: unknown) => fail(describeFailure(cause)))
      .finally(() => {
        clearTimeout(deadline)
        if (!cancelled) setRefreshing(false)
      })

    return () => {
      cancelled = true
      clearTimeout(deadline)
    }
  }, [route, attempt, api, navigate, bootTimeoutMs])

  const retry = useCallback((): void => setAttempt((count) => count + 1), [])
  const goHome = useCallback((): void => navigate({}), [navigate])
  const goNewMission = useCallback((): void => navigate({ new: true }), [navigate])
  const openMission = useCallback(
    (missionId: string): void => navigate({ mission: missionId }),
    [navigate],
  )

  const onApprove = useCallback(
    (actor: string, note: string) => {
      if (boot.kind !== 'mission') return
      const missionId = boot.report.missionId
      // Mesma garantia do ato combinado: aprova-se o plano inspecionado, nao o que estiver
      // no disco na hora. Sao dois caminhos na tela e a regra vale para os dois.
      const inspecionado = boot.report.specHash
      setBusy(true)
      api
        .approve(missionId, {
          actor,
          ...(note.length > 0 ? { note } : {}),
          ...(inspecionado === undefined ? {} : { specHash: inspecionado }),
        })
        .then(() =>
          setBoot((prev) => (prev.kind === 'mission' ? { ...prev, approved: true } : prev)),
        )
        .catch((cause: unknown) => setError(describeFailure(cause)))
        .finally(() => setBusy(false))
    },
    [boot, api],
  )

  /**
   * Aprovar e executar num ato humano — e DUAS chamadas em ordem: sem a aprovacao confirmada
   * pelo control plane nao existe partida, e quem aprovou fica registrado antes de qualquer
   * execucao (P15, DASHBOARD 7). A mesma guarda de `onStart` vale aqui: um clique duplo, ou um
   * re-render no meio, nao criam dois runs.
   */
  const onApproveAndStart = useCallback(
    (acceptWarnings: boolean, actor: string, note: string) => {
      if (boot.kind !== 'mission' || starting.current) return
      starting.current = true
      setStartPhase('starting')
      setBusy(true)
      const missionId = boot.report.missionId
      const inspecionado = boot.report.specHash
      // O endpoint de aprovacao RECOMPILA o arquivo. Entre carregar esta tela e clicar,
      // alguem pode ter editado o YAML — e a aprovacao registraria um plano que este humano
      // nunca viu, com o nome dele. Antes de aprovar, conferimos que a versao no disco ainda
      // e a que esta desenhada; se mudou, a tela recusa e pede nova revisao.
      //
      // Isto e guarda de cliente e fecha a janela pratica, nao a corrida absoluta: so o
      // control plane aceitando o specHash inspecionado fecharia de vez, e isso e contrato
      // novo entre interface e servidor.
      // O `specHash` inspecionado viaja no comando: quem decide se o plano ainda e o mesmo e
      // o control plane, na mesma transacao em que aprova. Conferir aqui antes so encolheria
      // a janela; mandar fecha.
      api
        .approve(missionId, {
          actor,
          ...(note.length > 0 ? { note } : {}),
          ...(inspecionado === undefined ? {} : { specHash: inspecionado }),
        })
        .then(() => {
          // A aprovacao ja e fato mesmo que a partida falhe depois: a tela registra isso
          // antes de tentar iniciar, para nao pedir a mesma aprovacao duas vezes.
          setBoot((prev) => (prev.kind === 'mission' ? { ...prev, approved: true } : prev))
          return api.start({ missionId, acceptWarnings, actor })
        })
        .then((created) => {
          setStartPhase('running')
          navigate({ run: created })
        })
        .catch((cause: unknown) => {
          starting.current = false
          setStartPhase('idle')
          setError(describeFailure(cause))
        })
        .finally(() => setBusy(false))
    },
    [boot, api, navigate],
  )

  const onStart = useCallback(
    (acceptWarnings: boolean, actor: string) => {
      if (boot.kind !== 'mission' || starting.current) return
      starting.current = true
      setStartPhase('starting')
      setBusy(true)
      api
        .start({ missionId: boot.report.missionId, acceptWarnings, actor })
        .then((created) => {
          setStartPhase('running')
          navigate({ run: created })
        })
        .catch((cause: unknown) => {
          starting.current = false
          setStartPhase('idle')
          setError(describeFailure(cause))
        })
        .finally(() => setBusy(false))
    },
    [boot, api, navigate],
  )

  if (route.run !== undefined) {
    return <RunDashboard runId={route.run} streamDeps={runStream} onHome={goHome} />
  }

  if (route.new === true) {
    // `defaultProvider` so viaja quando a Home ja foi lida: num link direto nao ha padrao do
    // projeto a oferecer, e inventar um seria pior do que deixar a tela escolher pela regra.
    const suggested = boot.kind === 'home' ? boot.home.project.defaultProvider : undefined
    return (
      <NewMission
        {...(newMission === undefined ? {} : { deps: newMission })}
        {...(suggested === undefined ? {} : { defaultPlannerId: suggested })}
        {...(defaultActor === undefined ? {} : { defaultActor })}
        onCancel={goHome}
        onOpenMission={openMission}
      />
    )
  }

  if (boot.kind === 'error') {
    return (
      <ErrorScreen
        title="O control plane não respondeu"
        message={boot.message}
        hint="O dado da tela vem todo do control plane; nada é reconstruído de memória. Confira se ele continua no ar e tente de novo."
        retrying={refreshing}
        onRetry={retry}
        {...(route.mission === undefined ? {} : { onHome: goHome })}
      />
    )
  }

  if (boot.kind === 'home') {
    return (
      <ProjectHome
        home={boot.home}
        onOpenRun={(runId) => navigate({ run: runId })}
        onOpenMission={openMission}
        onNewMission={goNewMission}
        onReload={retry}
        reloading={refreshing}
      />
    )
  }

  if (boot.kind === 'mission') {
    return (
      <StartMission
        report={boot.report}
        approved={boot.approved}
        {...(defaultActor === undefined ? {} : { defaultActor })}
        providers={boot.providers}
        busy={busy}
        error={error}
        startPhase={startPhase}
        plan={
          <PlanReview
            report={boot.report}
            {...(boot.missionFile === undefined ? {} : { missionFile: boot.missionFile })}
            {...(planReview === undefined ? {} : { deps: planReview })}
            onReload={retry}
            reloading={refreshing}
          />
        }
        onApprove={onApprove}
        onStart={onStart}
        onApproveAndStart={onApproveAndStart}
      />
    )
  }

  return (
    <main className="loading" aria-label="Carregando projeto">
      <p>carregando o projeto…</p>
    </main>
  )
}
