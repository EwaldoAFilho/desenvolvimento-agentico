import type {
  DiagnosticDto,
  GraphNodeDto,
  RunGraphDto,
  RunPoliciesDto,
  TaskDetail,
} from '@agentic/schemas'
import type { JSX, ReactNode } from 'react'
import { conflictKindOf, dependentsOf, RISK_LABEL, reviewReadingOf } from '../lib/plan-review.js'

const EMPTY = '—'

function list(values: readonly string[]): string {
  return values.length === 0 ? EMPTY : values.join(', ')
}

function Field({
  label,
  testId,
  children,
}: {
  readonly label: string
  readonly testId: string
  readonly children: ReactNode
}): JSX.Element {
  return (
    <div className="field">
      <dt className="field__label">{label}</dt>
      <dd className="field__value" data-testid={testId}>
        {children}
      </dd>
    </div>
  )
}

export interface PlanNodePanelProps {
  /** O no do grafo CONGELADO. Ausente = nada selecionado. */
  readonly node: GraphNodeDto | undefined
  readonly graph: RunGraphDto
  /** Politicas do run do rascunho: e o que a tela sabe de verdade sobre revisao (I10). */
  readonly policies: RunPoliciesDto
  /** Detalhe lido do control plane. Ausente enquanto carrega — ou quando a leitura falhou. */
  readonly detail?: TaskDetail
  readonly detailError?: string
  readonly loading?: boolean
  /** Diagnosticos do compilador que citam esta task. */
  readonly diagnostics: readonly DiagnosticDto[]
  readonly onClose: () => void
}

/**
 * O no do plano aberto: objetivo, dependencias, escopo, validacao, gate, risco e revisao —
 * tudo a vista de uma vez, sem revelacao progressiva. Aqui nao se decide execucao: e a leitura
 * com a qual o humano decide se APROVA. O que a estrutura ja sabe (dependencias, escopo,
 * risco) sobrevive a falha de leitura do detalhe; o que so o control plane sabe aparece com o
 * motivo quando nao pode ser lido — nunca como campo vazio que parece dado.
 */
export function PlanNodePanel({
  node,
  graph,
  policies,
  detail,
  detailError,
  loading = false,
  diagnostics,
  onClose,
}: PlanNodePanelProps): JSX.Element {
  if (node === undefined) {
    return (
      <aside className="plan-node plan-node--empty" aria-label="Nó do plano">
        <p className="plan-node__hint" data-testid="plan-node-empty">
          selecione um nó do plano para ver objetivo, dependências, escopo, validação, gate, risco e
          revisão.
        </p>
      </aside>
    )
  }

  const missing = loading ? 'lendo o nó no control plane…' : 'não lido do control plane'
  const dependents = dependentsOf(graph, node.id)
  const onCriticalPath = graph.criticalPath.includes(node.id)
  const validation = detail?.quality.validation ?? []

  return (
    <aside className="plan-node" aria-label={`Nó do plano ${node.id}`} data-testid="plan-node">
      <div className="plan-node__head">
        <div>
          <p className="plan-node__id">{`TASK ${node.id}`}</p>
          <h3 className="plan-node__title">{node.title}</h3>
        </div>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onClose}
          aria-label={`fechar o nó ${node.id}`}
        >
          ✕
        </button>
      </div>

      {detailError === undefined ? null : (
        <p className="plan-node__error" role="alert" data-testid="plan-node-error">
          {`o control plane não devolveu o detalhe deste nó: ${detailError}`}
        </p>
      )}

      <dl className="group__fields">
        <Field label="objetivo" testId="plan-node-objective">
          {detail?.objective ?? missing}
        </Field>
        {detail?.description === undefined ? null : (
          <Field label="descrição" testId="plan-node-description">
            {detail.description}
          </Field>
        )}
        <Field label="fase" testId="plan-node-phase">
          {node.phase}
        </Field>
        <Field label="dependências" testId="plan-node-dependencies">
          {list(node.dependencies)}
        </Field>
        <Field label="destrava" testId="plan-node-dependents">
          {list(dependents)}
        </Field>
        <Field label="caminho crítico" testId="plan-node-critical">
          {onCriticalPath ? 'sim — atrasar esta task atrasa a missão' : 'não'}
        </Field>
        <Field label="escopo de escrita" testId="plan-node-scope">
          {list(node.touches)}
        </Field>
        <Field label="leituras declaradas" testId="plan-node-reads">
          {detail === undefined ? missing : list(detail.scope.reads)}
        </Field>
        <Field label="validação" testId="plan-node-validation">
          {detail === undefined ? (
            missing
          ) : validation.length === 0 ? (
            'nenhum contrato de validação declarado — a conclusão desta task não é verificável por texto'
          ) : (
            <ul className="inline-list">
              {validation.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </Field>
        <Field label="gate" testId="plan-node-gate">
          {detail === undefined ? missing : (detail.quality.gate ?? 'sem gate declarado')}
        </Field>
        <Field label="risco" testId="plan-node-risk">
          <span data-risk={node.risk}>{`${RISK_LABEL[node.risk]} (${node.risk})`}</span>
          {` · estimativa ${node.estimate}`}
        </Field>
        <Field label="revisão" testId="plan-node-review">
          {reviewReadingOf(detail, policies, node)}
        </Field>
        <Field label="o compilador apontou" testId="plan-node-diagnostics">
          {diagnostics.length === 0 ? (
            'nada sobre esta task'
          ) : (
            <ul className="diagnostics">
              {diagnostics.map((diagnostic) => (
                <li
                  key={`${diagnostic.code}:${diagnostic.targets.join(',')}`}
                  data-severity={diagnostic.severity}
                >
                  <span className="diagnostics__code">{diagnostic.code}</span>
                  <span className="diagnostics__message">
                    {conflictKindOf(diagnostic.code) === undefined
                      ? diagnostic.message
                      : `conflito de ${conflictKindOf(diagnostic.code)} · ${diagnostic.message}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Field>
      </dl>
    </aside>
  )
}
