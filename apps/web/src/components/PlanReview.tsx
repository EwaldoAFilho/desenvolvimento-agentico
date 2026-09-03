import type {
  CompileReportDto,
  CreateDraftCommand,
  CreateDraftResultDto,
  RunSnapshot,
  TaskDetail,
} from '@agentic/schemas'
import { type JSX, useEffect, useMemo, useState } from 'react'
import { createMissionDraft, describeFailure, getRunSnapshot, getTaskDetail } from '../api.js'
import type { Grouping } from '../lib/dag-layout.js'
import { withDeadline } from '../lib/deadline.js'
import { formatDuration } from '../lib/format.js'
import { bySeverity, diagnosticsFor } from '../lib/plan-review.js'
import { CopyButton } from './CopyButton.js'
import { DagCanvas } from './DagCanvas.js'
import { PlanNodePanel } from './PlanNodePanel.js'

/**
 * Leituras que a revisao do plano usa. Ficam numa porta para que a tela inteira seja testavel
 * sem servidor: o que se prova e a MAQUINA da revisao, nao o HTTP — e nenhum teste aciona
 * planejador nem consome assinatura (P17).
 */
export interface PlanReviewDeps {
  readonly createDraft: (command: CreateDraftCommand) => Promise<CreateDraftResultDto>
  readonly loadSnapshot: (runId: string) => Promise<RunSnapshot>
  readonly loadTaskDetail: (runId: string, taskId: string) => Promise<TaskDetail>
}

const DEFAULT_DEPS: PlanReviewDeps = {
  createDraft: createMissionDraft,
  loadSnapshot: getRunSnapshot,
  loadTaskDetail: getTaskDetail,
}

/** Teto das leituras desta tela: nenhum carregamento pode ficar indefinido. */
export const PLAN_TIMEOUT_MS = 15_000

/**
 * O plano como a tela o obteve. Toda saida e terminal: desenhado, sem grafo com motivo, ou
 * bloqueado por ERROR — nunca "carregando" para sempre.
 */
type Plan =
  | { readonly kind: 'loading' }
  | { readonly kind: 'drawn'; readonly runId: string; readonly snapshot: RunSnapshot }
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'blocked' }

export interface PlanReviewProps {
  readonly report: CompileReportDto
  /** Caminho do YAML da missao, quando o control plane o informou. */
  readonly missionFile?: string
  readonly deps?: Partial<PlanReviewDeps>
  /** Reler o plano do disco: recompila e redesenha. */
  readonly onReload: () => void
  readonly reloading?: boolean
  readonly readTimeoutMs?: number
}

/**
 * Revisao do plano antes da aprovacao. O DAG vem do rascunho CONGELADO (`POST
 * /api/missions/draft`), que compila e para: nao aprova, nao parte e e idempotente por versao
 * do plano. Pedir o rascunho aqui — em vez de reaproveitar um run qualquer desta missao — e o
 * que garante que o desenho e os numeros na tela sejam do MESMO plano: um YAML editado tem
 * outro `specHash` e devolve outro rascunho, entao a tela nunca mostra o grafo de ontem com os
 * numeros de hoje.
 *
 * Ajuste minimo mora no YAML de proposito: o contrato versionado e o arquivo, e editar missao
 * pela UI esta fora do MVP (DASHBOARD 7, P09/P13). O que a tela faz e tirar o atrito do
 * caminho — caminho a vista, comando do editor pronto para copiar e releitura num clique.
 */
export function PlanReview({
  report,
  missionFile,
  deps,
  onReload,
  reloading = false,
  readTimeoutMs = PLAN_TIMEOUT_MS,
}: PlanReviewProps): JSX.Element {
  const api = useMemo<PlanReviewDeps>(() => ({ ...DEFAULT_DEPS, ...deps }), [deps])

  const [plan, setPlan] = useState<Plan>({ kind: 'loading' })
  const [grouping, setGrouping] = useState<Grouping>('phase')
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [detail, setDetail] = useState<TaskDetail | undefined>(undefined)
  const [detailError, setDetailError] = useState<string | undefined>(undefined)
  const [loadingDetail, setLoadingDetail] = useState(false)

  // `report` e a identidade do plano nesta tela: relido o disco, ele e outro objeto e o
  // rascunho e pedido de novo. Sem isso, editar o YAML deixaria o desenho para tras.
  useEffect(() => {
    setSelected(undefined)
    if (!report.ok || bySeverity(report, 'ERROR').length > 0) {
      setPlan({ kind: 'blocked' })
      return
    }
    let cancelled = false
    setPlan({ kind: 'loading' })
    // O ARQUIVO manda quando o control plane o informou: o id so resolve para um arquivo
    // quando o nome dele segue o id, e um plano com nome proprio ficaria sem desenho.
    const ref: CreateDraftCommand =
      missionFile === undefined ? { missionId: report.missionId } : { missionPath: missionFile }
    withDeadline(
      Promise.resolve(api.createDraft(ref)).then(async (draft) => {
        const snapshot = await api.loadSnapshot(draft.run.id)
        return { runId: draft.run.id, snapshot }
      }),
      readTimeoutMs,
      `o plano congelado não chegou em ${formatDuration(readTimeoutMs)}`,
    )
      .then(({ runId, snapshot }) => {
        if (!cancelled) setPlan({ kind: 'drawn', runId, snapshot })
      })
      .catch((cause: unknown) => {
        if (!cancelled) setPlan({ kind: 'unavailable', message: describeFailure(cause) })
      })
    return () => {
      cancelled = true
    }
  }, [api, report, missionFile, readTimeoutMs])

  const runId = plan.kind === 'drawn' ? plan.runId : undefined

  useEffect(() => {
    setDetail(undefined)
    setDetailError(undefined)
    if (runId === undefined || selected === undefined) return
    let cancelled = false
    setLoadingDetail(true)
    withDeadline(
      Promise.resolve(api.loadTaskDetail(runId, selected)),
      readTimeoutMs,
      `o detalhe de ${selected} não chegou em ${formatDuration(readTimeoutMs)}`,
    )
      .then((loaded) => {
        if (!cancelled) setDetail(loaded)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setDetailError(describeFailure(cause))
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false)
      })
    return () => {
      cancelled = true
    }
  }, [api, runId, selected, readTimeoutMs])

  const node =
    plan.kind === 'drawn' && selected !== undefined
      ? plan.snapshot.graph.nodes.find((item) => item.id === selected)
      : undefined

  const adjust = (
    <section className="plan-review__adjust" aria-label="Ajustar o plano">
      <h3 className="plan-review__subtitle">ajustar o plano</h3>
      <p className="plan-review__hint">
        O plano é o YAML da missão — contrato versionado, e esta tela não o edita (DASHBOARD 7).
        Ajuste mínimo: abra o arquivo, mude o que precisa e releia aqui. Os números, os conflitos e
        o DAG voltam recompilados, sem acionar o planejador de novo.
      </p>
      {missionFile === undefined ? (
        <p className="plan-review__hint" data-testid="plan-file-unknown">
          o control plane não informou o caminho do arquivo desta missão; ele está no diretório de
          missões do projeto.
        </p>
      ) : (
        <p className="plan-review__file">
          <code data-testid="plan-file">{missionFile}</code>
          <CopyButton value={missionFile} label="copiar caminho do arquivo" />
          <CopyButton value={`code ${missionFile}`} label="copiar comando do editor" />
        </p>
      )}
      <button
        type="button"
        className="btn"
        data-testid="plan-reload"
        aria-busy={reloading}
        disabled={reloading}
        onClick={onReload}
      >
        {reloading ? 'relendo…' : 'reler o plano do disco'}
      </button>
      <p className="plan-review__phase" role="status" data-testid="plan-reload-phase">
        {reloading
          ? 'relendo o arquivo e recompilando…'
          : 'nada é gravado no seu arquivo por esta tela: quem escreve missão é o control plane.'}
      </p>
    </section>
  )

  return (
    <section className="plan-review" aria-label="Plano proposto" data-testid="plan-review">
      <div className="plan-review__head">
        <h2 className="plan-review__subtitle">plano proposto</h2>
        <p className="plan-review__hint">
          O desenho é o grafo congelado do rascunho: mesmo plano dos números acima. Clique num nó
          para ver objetivo, dependências, escopo, validação, gate, risco e revisão — nada aqui
          aprova nem executa.
        </p>
      </div>

      {plan.kind === 'loading' ? (
        <p className="plan-review__hint" role="status" data-testid="plan-loading">
          congelando o plano para revisão…
        </p>
      ) : null}

      {plan.kind === 'blocked' ? (
        <p className="plan-review__hint" data-testid="plan-blocked">
          com ERROR não existe plano congelado para inspecionar: o compilador recusa antes. Corrija
          o YAML pelos erros listados acima e releia.
        </p>
      ) : null}

      {plan.kind === 'unavailable' ? (
        <p className="plan-review__error" role="alert" data-testid="plan-unavailable">
          {`o plano não pôde ser desenhado: ${plan.message}`}
        </p>
      ) : null}

      {plan.kind === 'drawn' ? (
        <div className="plan-review__body">
          <DagCanvas
            snapshot={plan.snapshot}
            grouping={grouping}
            onGroupingChange={setGrouping}
            {...(selected === undefined ? {} : { selectedTaskId: selected })}
            onSelectTask={setSelected}
          />
          <PlanNodePanel
            node={node}
            graph={plan.snapshot.graph}
            policies={plan.snapshot.run.policies}
            {...(detail === undefined ? {} : { detail })}
            {...(detailError === undefined ? {} : { detailError })}
            loading={loadingDetail}
            diagnostics={selected === undefined ? [] : diagnosticsFor(report, selected)}
            onClose={() => setSelected(undefined)}
          />
        </div>
      ) : null}

      {adjust}
    </section>
  )
}
