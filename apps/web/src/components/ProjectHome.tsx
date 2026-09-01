import type { MissionSummaryDto, ProjectHomeDto, RunSummaryDto } from '@agentic/schemas'
import type { JSX } from 'react'
import { formatClock } from '../lib/format.js'
import { environmentOf, missionActionOf, missionStateStyle } from '../lib/home.js'
import { runStatusIcon } from '../lib/status.js'
import { ProvidersPanel } from './ProvidersPanel.js'

export interface ProjectHomeProps {
  readonly home: ProjectHomeDto
  readonly onOpenRun: (runId: string) => void
  readonly onOpenMission: (missionId: string) => void
  /** Entrada da jornada por linguagem natural: descrever em texto livre e ver o DAG. */
  readonly onNewMission: () => void
  readonly onReload: () => void
  readonly reloading?: boolean
}

/** Um run identificado sem gastar a largura toda: o ULID inteiro nao cabe e nao ajuda. */
function shortRunId(id: string): string {
  return id.length <= 10 ? id : `…${id.slice(-8)}`
}

function countersOf(run: RunSummaryDto): string {
  const counters = run.counters
  // Contadores ausentes NAO viram uma linha de zeros: nao apurado e diferente de zerado.
  if (counters === undefined) return 'contadores não apurados'
  const total = Object.values(counters).reduce((sum, value) => sum + value, 0)
  return `${counters.DONE}/${total} DONE · ${counters.FAILED} FAILED · ${counters.BLOCKED} BLOCKED`
}

function MissionRow({
  mission,
  onOpenRun,
  onOpenMission,
}: {
  readonly mission: MissionSummaryDto
  readonly onOpenRun: (runId: string) => void
  readonly onOpenMission: (missionId: string) => void
}): JSX.Element {
  const style = missionStateStyle(mission.state)
  const action = missionActionOf(mission)
  // Titulo vazio e resposta legitima de arquivo que nao compila: mostramos o caminho, que e
  // o que o usuario precisa abrir, em vez de inventar um nome.
  const name = mission.title.length > 0 ? mission.title : mission.file

  return (
    <li className="home-row" data-testid={`mission-${mission.id ?? mission.file}`}>
      <span className="home-row__state" data-state={mission.state}>
        <span aria-hidden="true">{style.icon}</span>
        <span>{style.label}</span>
      </span>
      <span className="home-row__name">
        <span className="home-row__title">{name}</span>
        <code className="home-row__file">{mission.file}</code>
      </span>
      <span className="home-row__numbers">
        {`${mission.tasks} tasks · ${mission.phases} fases · ${mission.errors} erros · ${mission.warnings} avisos`}
      </span>
      <span className="home-row__action">
        {action.kind === 'none' ? (
          <span className="home-row__blocked" data-testid={`mission-${mission.file}-no-action`}>
            {action.hint}
          </span>
        ) : (
          <button
            type="button"
            className="btn"
            aria-label={`${action.label}: ${name}`}
            onClick={() => {
              if (action.kind === 'open-run' && action.runId !== undefined) onOpenRun(action.runId)
              if (action.kind === 'open-mission' && action.missionId !== undefined) {
                onOpenMission(action.missionId)
              }
            }}
          >
            {action.label}
          </button>
        )}
      </span>
    </li>
  )
}

function RunRow({
  run,
  onOpenRun,
}: {
  readonly run: RunSummaryDto
  readonly onOpenRun: (runId: string) => void
}): JSX.Element {
  return (
    <li className="home-row" data-testid={`run-${run.id}`}>
      <span className="home-row__state" data-state={run.status}>
        <span aria-hidden="true">{runStatusIcon(run.status)}</span>
        <span>{run.status}</span>
      </span>
      <span className="home-row__name">
        <span className="home-row__title">{run.missionId}</span>
        <code className="home-row__file">{shortRunId(run.id)}</code>
      </span>
      <span className="home-row__numbers">
        {`${formatClock(run.startedAt ?? run.createdAt)} · ${countersOf(run)}`}
      </span>
      <span className="home-row__action">
        <button
          type="button"
          className="btn"
          aria-label={`abrir execução ${run.missionId} ${shortRunId(run.id)}`}
          onClick={() => onOpenRun(run.id)}
        >
          abrir
        </button>
      </span>
    </li>
  )
}

/**
 * A Home do projeto. Ela existe porque, sem run e sem missao na URL, a tela ficava em
 * "carregando missao compilada" para sempre: o boot saia sem escrever estado nenhum.
 *
 * Todo estado aqui e projecao de UMA leitura (`GET /api/project`). Nada e inferido, e o
 * estado vazio e dito com todas as letras — projeto novo nao pode parecer projeto quebrado.
 */
export function ProjectHome({
  home,
  onOpenRun,
  onOpenMission,
  onNewMission,
  onReload,
  reloading = false,
}: ProjectHomeProps): JSX.Element {
  const { project, missions, runs } = home
  const environment = environmentOf(project.providers)

  return (
    <main className="home" aria-label="Projeto">
      <header className="home__head">
        <h1 className="home__name">{project.name}</h1>
        <p className="home__meta">
          {'missões em '}
          <code>{project.missionsDir}</code>
          {project.defaultProvider === undefined ? null : (
            <>
              {' · fornecedor padrão '}
              <code>{project.defaultProvider}</code>
            </>
          )}
          {project.gates.length === 0 ? null : ` · gates: ${project.gates.join(', ')}`}
        </p>
        <div className="home__head-actions">
          <button
            type="button"
            className="btn btn--primary"
            data-testid="new-mission"
            aria-label="nova missão a partir de texto livre"
            onClick={onNewMission}
          >
            nova missão
          </button>
          <button
            type="button"
            className="btn btn--ghost home__reload"
            data-testid="reload-home"
            aria-busy={reloading}
            disabled={reloading}
            onClick={onReload}
          >
            {reloading ? 'atualizando…' : 'atualizar'}
          </button>
        </div>
      </header>

      {project.configured ? null : (
        <section className="home__block home__block--warn" aria-label="Projeto não configurado">
          <h2>projeto sem configuração legível</h2>
          <p className="home__empty">
            {'não foi possível ler '}
            <code>.agentic/project.yaml</code>
            {'. O control plane responde, mas o projeto ainda não declarou providers, gates nem ' +
              'diretório de missões — crie o arquivo para que a Home mostre o ambiente real.'}
          </p>
        </section>
      )}

      <section className="home__block" aria-label="Ambiente">
        <h2>ambiente</h2>
        <p
          className="home__verdict"
          data-testid="environment-verdict"
          data-verdict={environment.verdict}
        >
          <span aria-hidden="true">{environment.icon}</span>
          <strong>{environment.label}</strong>
          <span>{environment.detail}</span>
        </p>
        {project.providers.length === 0 ? (
          <p className="home__empty">
            nenhum fornecedor configurado. Agentes são CLIs locais já autenticadas por assinatura —
            declare pelo menos um em <code>.agentic/project.yaml</code>.
          </p>
        ) : (
          <ProvidersPanel providers={project.providers} />
        )}
      </section>

      <section className="home__block" aria-label="Missões">
        <h2>{`missões (${missions.length})`}</h2>
        {missions.length === 0 ? (
          <p className="home__empty" data-testid="missions-empty">
            {'nenhuma missão em '}
            <code>{project.missionsDir}</code>
            {'. Um projeto novo começa assim: descreva o que você quer em “nova missão” e o '}
            {'control plane grava o arquivo, ou crie um '}
            <code>*.mission.yaml</code>
            {' nesse diretório à mão — nos dois casos ele aparece aqui compilado.'}
          </p>
        ) : (
          <ul className="home__list">
            {missions.map((mission) => (
              <MissionRow
                key={mission.file}
                mission={mission}
                onOpenRun={onOpenRun}
                onOpenMission={onOpenMission}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="home__block" aria-label="Execuções">
        <h2>{`execuções (${runs.length})`}</h2>
        {runs.length === 0 ? (
          <p className="home__empty" data-testid="runs-empty">
            nenhuma execução ainda. A primeira aparece aqui assim que uma missão partir.
          </p>
        ) : (
          <ul className="home__list">
            {runs.map((run) => (
              <RunRow key={run.id} run={run} onOpenRun={onOpenRun} />
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
