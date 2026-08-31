import type {
  ApproveMissionCommand,
  CompileReportDto,
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
  getProjectHome,
  getProviders,
  listRuns,
  startRun,
} from './api.js'
import { ErrorScreen } from './components/ErrorScreen.js'
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
  readonly approve: (missionId: string, command: ApproveMissionCommand) => Promise<void>
  readonly start: (command: StartRunCommand) => Promise<string>
}

const DEFAULT_DEPS: AppDeps = {
  loadProjectHome: getProjectHome,
  loadCompileReport: getCompileReport,
  loadProviders: getProviders,
  loadRuns: listRuns,
  approve: approveMission,
  start: startRun,
}

/** `?run=` e `?mission=` sao os dois enderecos que a tela entende. Nada mais e inventado. */
export interface Route {
  readonly run?: string
  readonly mission?: string
}

function paramOf(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name)
  return value === null || value.length === 0 ? undefined : value
}

export function routeOf(search: string): Route {
  const params = new URLSearchParams(search)
  const run = paramOf(params, 'run')
  const mission = paramOf(params, 'mission')
  return { ...(run === undefined ? {} : { run }), ...(mission === undefined ? {} : { mission }) }
}

function currentRoute(): Route {
  return typeof window === 'undefined' ? {} : routeOf(window.location.search)
}

/** `run` tem precedencia na URL tambem: os dois juntos nunca sao escritos por nos. */
function searchOf(route: Route): string {
  const params = new URLSearchParams()
  if (route.run !== undefined) params.set('run', route.run)
  else if (route.mission !== undefined) params.set('mission', route.mission)
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
  readonly bootTimeoutMs?: number
}

/**
 * Tres telas, uma precedencia: run na URL manda no que aparece; depois missao na URL; e, sem
 * nenhuma das duas, a Home do projeto — com o desvio para a execucao ATIVA, se houver.
 */
export function App({
  deps,
  runStream,
  bootTimeoutMs = BOOT_TIMEOUT_MS,
}: AppProps = {}): JSX.Element {
  const api = useMemo<AppDeps>(() => ({ ...DEFAULT_DEPS, ...deps }), [deps])

  const [route, setRoute] = useState<Route>(currentRoute)
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

  const navigate = useCallback((next: Route, replace = false): void => {
    if (typeof window !== 'undefined') {
      const url = `${window.location.pathname}${searchOf(next)}`
      if (replace) window.history.replaceState({}, '', url)
      else window.history.pushState({}, '', url)
    }
    setRoute(next)
  }, [])

  // Voltar e avancar no navegador sao navegacao de verdade: a tela acompanha a URL.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onPop = (): void => setRoute(currentRoute())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    const previous = booted.current
    const sameRoute = previous?.run === route.run && previous?.mission === route.mission
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
      const [report, providers, runs] = await Promise.all([
        api.loadCompileReport(missionId),
        api.loadProviders(),
        api.loadRuns(),
      ])
      // `approved` sai de um run DESTA missao. Antes vinha do run mais recente do projeto
      // inteiro, e uma missao herdava a aprovacao de outra.
      const approved = runs.some(
        (run) => run.missionId === report.missionId && run.status === 'APPROVED',
      )
      return { kind: 'mission', report, providers, approved }
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

  const onApprove = useCallback(
    (actor: string, note: string) => {
      if (boot.kind !== 'mission') return
      const missionId = boot.report.missionId
      setBusy(true)
      api
        .approve(missionId, note.length > 0 ? { actor, note } : { actor })
        .then(() =>
          setBoot((prev) => (prev.kind === 'mission' ? { ...prev, approved: true } : prev)),
        )
        .catch((cause: unknown) => setError(describeFailure(cause)))
        .finally(() => setBusy(false))
    },
    [boot, api],
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
        onOpenMission={(missionId) => navigate({ mission: missionId })}
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
        providers={boot.providers}
        busy={busy}
        error={error}
        startPhase={startPhase}
        onApprove={onApprove}
        onStart={onStart}
      />
    )
  }

  return (
    <main className="loading" aria-label="Carregando projeto">
      <p>carregando o projeto…</p>
    </main>
  )
}
