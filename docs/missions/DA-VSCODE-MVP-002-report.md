# DA-VSCODE-MVP-002 — Mission → DAG → Approve → Run

**Branch:** `feature/DA-VSCODE-MVP-002` (a partir de `feature/DA-VSCODE-MVP`; `main` intocada)
**Data:** 2026-09-03
**Veredito:** ver §Z no fim (preenchido no fechamento do lote).

> Histórico: a primeira rodada parou em `BASE_VSCODE_BLOCKED` (§A). Por decisão do operador, os
> dois MAJOR foram corrigidos, a revisão restrita confirmou (§A2) e o MVP-002 seguiu (§C em diante).

## A. Base review (Fase 1)

Codex fresh, read-only, escopo restrito às seis correções finais da MVP-001 (commit `2a9397d`).
Log em `codex-base-review.log` (scratchpad da sessão). Resultado: **FAIL**, com dois MAJOR nas
categorias que a missão manda parar:

| # | Achado | Categoria da missão | Evidência |
| --- | --- | --- | --- |
| 2 | `deactivate` pode perder um filho: se a janela fechar (ou o projeto trocar) enquanto `spawnServe()` ainda resolve a toolchain, `childPid` não existe e o serviço fica fora do encerramento; o `launchServe()` conclui depois e cria um filho *detached* sem `stop()`. E, se o filho sair e outra janela publicar um dono antes de `doStop()`, o caminho "externo" sinaliza esse dono. | perda de lifecycle; toca dono alheio | `service.ts:177`, `host.ts:88/129/352`, `service.ts:271/304/320` |
| 3 | O schema da CLI faz `.trim()` nas strings; a extensão não. `repoRoot: " ../repositorio "` resolve para caminhos diferentes na CLI e na extensão; se o caminho literal existir e contiver `apps/cli/bin/agentic.mjs`, a extensão executa a CLI de outro diretório. `server.host` idem (`declaredUrl`). | execução no projeto errado | `project.ts:65/93/151`, `toolchain.ts:228`, `packages/schemas/src/common.ts:20` |

MINOR registrados (seguir sem corrigir agora): corrida entre janelas ainda admite dois processos
vivos quando o perdedor ignora SIGTERM (fica em `childPid`, sem perda de lifecycle);
`childEnv` materializa os valores de `process.env` antes de filtrar (nada é injetado).
NOTA: autorização de caminhos e refs/opções do git estão contidas.

**Correções recomendadas (pequenas, sem saga):**

1. `AgenticService`: registrar `spawning` (promessa do `spawnServe`) e expor no `view()`;
   `shutdown` espera o spawn pendente (com prazo) e para o filho; `retired` guarda serviço com
   spawn em voo. Novo `stopOwnChild()` que **nunca** cai no caminho externo, usado só pelo
   `deactivate`.
2. `readProjectFacts`: `trim()` em `name`, `repoRoot` e `host`, igual ao schema.

## B. Terreno preparado: merge de `mission/DA-UX-001`

O planning que a missão manda reutilizar existia só em `mission/DA-UX-001` (19 commits sobre
`main`, nunca integrado à cadeia de estabilidade). Foi feito o merge no branch novo:

- 4 conflitos resolvidos à mão, todos na fronteira com a cadeia de estabilidade
  (`control-plane.ts`, `server.ts`, `apps/cli/src/deps.ts`, `.gitignore`): o corpo de
  `createControlPlane` com posse/lease foi mantido e o planejamento enxertado sobre
  `runtimeDir` (sem `baseDir`/`databasePath`, I14); `planMission` passa pela mesma guarda de
  posse e de `quiesce()` que `createRun`/`approveMission`/`startRun`.
- `ADR-0013` do planning renumerado para `ADR-0016` (colisão com o ADR de posse), com as
  citações no código atualizadas.
- O launcher `agentic` sem argumento (U02) **não** foi portado: conflita com a verificação de
  identidade da cadeia e não é necessário para a extensão. `launch.ts`, `browser.ts` e seus
  testes ficaram de fora.
- Testes de planning do servidor passaram a adquirir a posse do fixture (como o harness) e o
  `.gitignore` do fixture ignora o lock de posse.
- Extensão adaptada ao `GET /api/missions` enriquecido (`MissionSummaryDto`); `tsconfig` da
  extensão passou a mapear todos os `@agentic/*` para o fonte.

Validação do merge: typecheck OK; lint OK; testes direcionados de domain, schemas, providers,
orchestrator, server, cli, workspace, web e extensão: 172 arquivos, 2144 testes, verde.
`verify`/e2e/browser completos **não** rodados (política do lote).

**Dívida registrada ao portar:** `agentic init` não escreve `.gitignore`; num projeto novo o
lock de posse e o `state.db` aparecem como não rastreados e a impressão digital do repositório
usada pelo planejamento os inclui — o dogfooding do MVP-002 em projeto descartável precisa
de `.gitignore` (ou o `init` precisa gerá-lo). F2 (livelock ao reiniciar missão) e F5 (run
reaberto sem executor) do relatório da DA-UX-001 continuam abertos.

## A2. Correções da base e revisão restrita

Commits `15c454f` (spawn em voo conhecido pelo `deactivate`, `stopOwnChild()` que nunca toca
dono externo, `trim` como o schema) e `4246e1d` (bandeira de abandono verificada depois de cada
descoberta; achado da própria revisão restrita). Testes A–E por barreiras, sem sleep.

| Rodada | Resultado |
| --- | --- |
| Revisão restrita das duas correções | FAIL com **um** MAJOR (interleaving da sondagem em voo); os outros cinco pontos confirmados |
| Correção adicional + confirmação restrita | **PASS** — "nenhuma regressão BLOCKER/MAJOR" |

MINOR registrados e não corrigidos: perdedor que ignora SIGTERM fica com handle (`childPid`);
valores de `process.env` materializados antes do filtro da allowlist.

## C. Nova Mission, planning, Draft, DAG, inspector, aprovação, Run (Entregas 1–13)

Decisão de reuso: em vez de reconstruir telas, o **mesmo `App` de `apps/web`** roda na aba
Agentic. Três costuras no dashboard (sem mudar o navegador): transporte injetável
(`setApiTransport`), navegação em memória (`navigation`/`initialRoute`/`onNavigate`) e um
contexto de ações de editor (`EditorActionsContext`: abrir arquivo/worktree/log, diff). `actor`
sugerido do `git config user.name`, sempre editável e obrigatório.

Na extensão: leitor SSE sobre `fetch` (`src/core/sse.ts`), protocolo da ponte validado por
inteiro (`bridge-protocol.ts`), ponte do host (`bridge.ts`: header de guarda do `repoRoot`,
prazo longo só em `/missions/plan`, worktrees devolvidas pelo control plane viram caminhos
autorizados), ponte da webview (`client-bridge.ts`), painel React (`app-panel.ts` +
`media/app.tsx`) com portão Start quando o control plane está parado, view **Active Run**,
comandos *New Mission* e *Open Run*, rota Home/Mission/Run guardada no host (título da aba e
navegação pela sidebar). Painel vanilla da MVP-001 removido.

O que cada entrega usa:

| Entrega | Onde |
| --- | --- |
| Nova Mission / planner / planning | `NewMission.tsx` → `POST /api/missions/plan` (planners de `GET /api/planners`, só READY) |
| Draft (título, tasks, warnings/errors, waves, caminho crítico, conflitos) | `PlanReview.tsx` + `lib/plan-review.ts` sobre `CompileReportDto`/`RunSnapshot` |
| DAG | `DagCanvas.tsx` (React Flow + dagre) — reutilizado, não reconstruído |
| Task inspector | `PlanNodePanel.tsx` (objective, dependências, touches clicáveis, validation, gate, risco, provider, requireReview, reviewPolicy) |
| Aprovação | `StartMission.tsx` (`actor`, `specHash`, aprovar+executar num ato, guarda de duplo clique) |
| Start / navegação ao Run | `App.tsx` (`starting` ref + navegação para `?run=`) |
| Live Run / DAG vivo | `RunDashboard.tsx` + `useRunStream` com `EventSourceLike` da ponte (SSE via host) |
| Task live detail / logs / evidence / diff | `TaskDetailPanel.tsx` + ações de editor |
| Providers no run | `RunHeader.tsx`/`ProvidersPanel.tsx` com `running`/estado do control plane |
| Failure UX | `lib/failure.ts`/`no-changes.ts` (causa, tentativa, gate/revisão, evidência) + `TaskActions` (retry/unblock/skip) e pause/resume |
| No active run / erro | `ProjectHome.tsx` / `ErrorScreen.tsx` (nunca loading infinito) |

Planejamento é síncrono (até 10 min) e o contrato do planner não tem cancelamento: a UI
mostra tempo decorrido; nenhum cancelamento inseguro foi inventado.
