# DA-VSCODE-MVP-002 — Mission → DAG → Approve → Run

**Branch:** `feature/DA-VSCODE-MVP-002` (a partir de `feature/DA-VSCODE-MVP`; `main` intocada)
**Data:** 2026-09-03
**Veredito:** MVP_DA_EXTENSAO_ATINGIDO com ressalvas (§Z).

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

## D. Múltiplas janelas (Entrega 14)

O dashboard na aba é cliente do mesmo control plane: duas janelas do mesmo projeto veem as
mesmas missions e o mesmo run (mesmo `/api/missions`, mesmo SSE). O teste de múltiplas janelas
com processos reais (`src/multi-window.test.ts`) continua: a segunda janela reutiliza o dono, o
Stop de uma encerra o processo da outra com prova, projetos diferentes têm donos independentes.
Não foi repetido o stress 8×10.

## E. Testes direcionados

Projeto `vscode-extension` (dentro do `verify`): 90 testes — deteção/trim, descoberta, máquina
de estados (inclui A–E do spawn em voo), cliente HTTP, toolchain, missions, SSE, protocolo da
ponte (host e webview), bundle por metafile, múltiplas janelas com processos reais.
`apps/web`: 437 testes (o `App` reutilizado é o testado). Integração em VS Code real
(`npm run vscode:test:integration`, fora do `verify`): 10/10 no projeto descartável — ativação,
comandos, detecção, Start, providers/missions, Open Mission (rota), Open Agentic + New Mission
(rotas), aprovar+executar a mission de exemplo pelo control plane com o run visível em *Active
Run* e cancelado, Restart, Stop.

## F. Dogfooding real (Entrega 15)

`test/dogfood.cjs` (`AGENTIC_IT_DOGFOOD=1`) dirige a jornada real dentro de um VS Code de
verdade sobre **este repositório**, pelo mesmo cliente HTTP que a ponte da webview usa (as telas
são as de `apps/web`, cobertas pelos testes do dashboard; os cliques ficam com o operador):

| Passo | Resultado (run `01M1KKMVEAP7035E52WMFHH9TY`, mission `DA-DOGFOOD-005`) |
| --- | --- |
| Start pela extensão | control plane em 127.0.0.1:4317 (adotou o run VERIFYING da DA-UX-001) |
| Planners | `codex` READY |
| Nova Mission → plano | HTTP 201 em 31 s, 1 task, 0 erros, 1 revisão; run DRAFT |
| DRAFT na aba | rota da mission aberta |
| Aprovar (specHash) + executar | mesmo run; um clique = um run |
| Run | T01 RUNNING → REVIEW → DONE; mission gate (`npm run verify` + e2e) PASS em ~3 min; **COMPLETED** |
| Stop | control plane encerrado com prova |

O resultado do produto (o item do CHANGELOG escrito pelo agente) foi integrado ao branch
(`ba6266e`, merge de `mission/DA-DOGFOOD-005`).

Quatro tentativas até o COMPLETED, cada uma ensinando algo:

1. **`claude` desatualizado nesta máquina** (2.1.220): READY pela sonda (auth ok) mas a chamada
   falha ("version 2.1.251 or newer is required"). A tela só dizia "saiu com codigo 1"; agora a
   causa vai na mensagem (`planner.ts`). Dogfood seguiu com `codex` e um `project.yaml`
   temporário (default `codex`, sem `claude-code`), revertido depois.
2. **Provider mock virou revisor** (`cross-provider-preferred` com `mock` no registro): revisão
   sem veredito → BLOCKED. É a lacuna U12 da DA-UX-001, ainda aberta; o mock foi tirado do
   registro temporário.
3. **Mission gate reprovou o lint da minha própria árvore** (testes de integração sem formatar).
4. **Mission gate reprovou o teste de bundle** numa worktree com `node_modules` linkado (prefixo
   fixo vs. caminho que atravessa o link) — corrigido por segmento. Defeito real que só a
   execução pelo produto pegou.

## G. Full validation (uma vez)

Executado uma vez após o lote (com a revisão do Codex rodando em paralelo):

| Gate | Resultado |
| --- | --- |
| `npm run build` | OK |
| `npm run verify` | 225 arquivos, 2751 testes, verde |
| `npm run test:e2e` | 98 passados, 4 pulados (por desenho) |
| testes da extensão | 90 verdes |
| `npm run test:browser` | **5/10 na primeira execução** (sob carga: revisão Codex + e2e em paralelo); specs reprovadas passaram isoladas; ver §G2 |

### G2. O que a suíte de navegador encontrou

Reexecutada isolada: 5/10 continuavam reprovando — não era flake. Duas causas reais e uma
expectativa desatualizada:

| Causa | Efeito nas specs | Correção |
| --- | --- | --- |
| **F2 (DA-UX-001)**: o segundo run da mesma mission travava para sempre em `git worktree add -b task/<m>/<t>/a1` porque a branch da tentativa anterior sobrava (a suíte compartilha um control plane e o dashboard novo cria um run por aprovação) | `refresh`, `resolutions`, `viewport-selection`, e por arrasto `start-mission` | `addWorktree` renomeia a branch antiga para `<branch>.stale.<t>` (nunca apaga — a evidência continua referenciada) e segue; teste no provider |
| O dashboard novo desenha o DAG do **rascunho** antes do START (PlanReview busca o snapshot do run DRAFT) | `live-update` contava dois snapshots | a spec conta a partir do START |
| Aprovar é idempotente por versão do plano (rascunho DRAFT/APPROVED reutilizado) | `start-mission` esperava "um run a mais" | a spec exige exatamente um run APPROVED do spec |

Provado pela API sem navegador (sonda temporária): o mesmo control plane completava o
primeiro run em 6 s e o segundo entrava em `policy.invalid_transition` a cada tick. Depois
das correções: **10/10**.

### G3. Gate final na árvore final (após as correções)

| Gate | Resultado |
| --- | --- |
| `npm run build` (+ dashboard) | OK |
| `npm run verify` | 2758+ testes, verde (repetido após cada correção; última execução verde) |
| `npm run test:e2e` | 98 passados, 4 pulados |
| `npm run test:browser` | **10/10** (última execução, árvore final) |
| integração da extensão em VS Code real (projeto descartável) | 10/10 |
| dogfooding real neste repositório (`test/dogfood.cjs`) | COMPLETED (§F) |

## H. Codex final do lote

Codex fresh, read-only sobre `feature/DA-VSCODE-MVP..feature/DA-VSCODE-MVP-002` com os onze
focos da missão. Resultado: **FAIL**, 4 MAJOR + 3 MINOR, todos do lote e todos corrigidos no
único ciclo permitido (commit `71e63fe`):

| Achado | Correção |
| --- | --- |
| `planMission` fora da drenagem do `close()` (I15): planejador vivo após devolver a posse | planejamentos em voo rastreados; planejadores que sabem cancelar são cancelados; o `close` espera assentar dentro do prazo ou falha (posse retida). Teste com planejador pendurado e surdo |
| enxerto sobre `runtimeDir` perde a fonte de `project.yaml`/`gates.yaml` quando `repoRoot` aponta para fora (CLI `openPlane` sem textos) | `openPlane` passa `projectText`/`gatesText` como o servidor |
| start não preso ao run aprovado ("qualquer run APPROVED da missão") | `specHash` opcional em `StartRunCommand` (o dashboard envia o do relatório); divergente → `MISSION_CHANGED`; sem ele o arquivo é recompilado e a partida fica presa à versão no disco. Testes de rota |
| `timeoutMs` escolhido pela webview prevalece sobre o host | campo removido do protocolo; o host decide por rota |
| (MINOR) `missionsDir` offline diverge do control plane com `repoRoot` externo | extensão lê `<runtimeDir>/missions` |
| (MINOR) worktrees publicadas não canonicalizadas | `realpath` ao entrar na allowlist |
| (MINOR) `childEnv` lê valores antes de filtrar | registrado, não corrigido |

**Confirmação restrita ao commit de correção: FAIL** — 1 BLOCKER, 1 MAJOR, 1 MINOR, todos na
minha própria correção, e por isso corrigidos (commit `dfe0298`), excedendo o limite nominal de um
ciclo em uma confirmação adicional:

| Achado | Correção |
| --- | --- |
| BLOCKER: `LocalCliMissionPlanner.cancel()` engolia `PROCESS_GROUP_ALIVE` e descartava o handle com `groupTerminated=false`; o `close` devolvia a posse com descendente do planejador vivo | resíduo fica em `#running` (o próximo `cancel` sonda de novo); `cancel()` rejeita quando algum grupo sobreviveu; `drainPlanning` faz o `close` falhar — cancelar e assentar sob o mesmo `graceMs`. Teste com planejador cujo cancel rejeita |
| MAJOR: o caminho real do dashboard (`missionId + specHash`, sem `missionPath`) não recompilava o arquivo | sem `missionPath` o arquivo é sempre recompilado; hash inspecionado ≠ disco → `MISSION_CHANGED`. Teste de rota nesse caminho |
| MINOR: `graceMs` não cobria o `cancel()` | cancel dentro do mesmo prazo |

Segunda confirmação restrita (a `dfe0298`): **FAIL** — a partida por `missionId + specHash` foi
confirmada correta, mas ficaram 1 BLOCKER remanescente (com a lista de planejamentos em voo
vazia, `drainPlanning` saía cedo e o resíduo no adapter ficava inacessível) e 1 MAJOR novo (o
`addWorktree` renomeava também uma branch checked out por uma worktree viva de outro run — o
git arrasta o `HEAD` dela). Os dois, mais o MINOR (handle morto retido), foram corrigidos no
commit seguinte (`cancel()` sempre chamado no `close`; branch em uso recusa com
`WorkspaceError`; testes nos dois), **sem uma terceira leitura independente**: é a ressalva
explícita deste lote. Dívida registrada pela revisão: os probes de versão/prontidão
(`agent-runtime/probe.ts`) ignoram `groupTerminated=false` — pré-existente, fora do lote.

## I. VSIX e instalação

`desenvolvimento-agentico-vscode-0.2.0-alpha.1.vsix` (gerado por `npm run vscode:package`),
instalado sobre a alpha anterior com `code --install-extension --force` (exige *Developer:
Reload Window* na janela aberta). Não publicado.

## J. Limitações

- Planejamento síncrono (até 10 min) sem cancelamento (contrato do planner não o oferece).
- A prontidão de um provider não prova que a chamada funciona (P17 proíbe sondar a API): a
  causa aparece na recusa do planner, não antes.
- Provider de teste (`mock`) pode ser escolhido como revisor real (U12, dívida da DA-UX-001).
- `agentic init` não escreve `.gitignore`; projeto novo lista lock/estado como não rastreados.
- Dashboard com a paleta própria (clara); o tema do VS Code só cobre o portão.
- Só Linux/macOS (SIGTERM); CLI precisa existir no repo, em `node_modules/.bin` ou no PATH.
- Dívidas anteriores mantidas: F2/F5 da DA-UX-001, cancelamento com gate em voo (004B), run
  `DA-UX-001` ainda em VERIFYING neste repositório (re-executa o mission gate a cada adoção).

## K. Branch / commits / status

Branch `feature/DA-VSCODE-MVP-002` a partir de `feature/DA-VSCODE-MVP` (`603807f`); `main` intocada; nada enviado ao remoto; VSIX ignorado pelo git.

```text
5bfa66e fix(DA-VSCODE-MVP-002): segunda confirmacao — residuo do planner sondado mesmo sem planejamento em voo; branch em uso por worktree viva nunca e renomeada
331b73b test(browser): aprovar e idempotente por versao do plano — a spec exige um run APPROVED do spec, nao um run a mais
dfe0298 fix(DA-VSCODE-MVP-002): confirmacao restrita — cancelamento do planner com prova de grupo morto; partida recompila tambem no caminho do dashboard; branch de tentativa de run anterior renomeada (F2)
71e63fe fix(DA-VSCODE-MVP-002): ciclo de correcao da revisao final — planning na drenagem do close, start preso ao plano inspecionado, prazo da ponte no host, textos do projeto na CLI
4c99c00 docs(DA-VSCODE-MVP-002): mission DA-DOGFOOD-005 planejada e executada pelo produto dentro do VS Code
ba6266e T01 a1: Adicionar registro de dogfooding ao changelog
bfc183b test(DA-VSCODE-MVP-002): prova de bundle por segmento de caminho — numa worktree com node_modules linkado o metafile atravessa o link
c133c56 chore(DA-VSCODE-MVP-002): formatacao dos testes de integracao (o mission gate do dogfood reprovou o lint da propria arvore)
74fdedb feat(DA-VSCODE-MVP-002): falha do planner carrega a causa; suite de dogfooding real no VS Code
d55d374 test(DA-VSCODE-MVP-002): jornada estendida no VS Code real — aba, rotas, aprovar+executar, Active Run, cancelamento
7e183a3 feat(DA-VSCODE-MVP-002): ponte da webview extraida e testada; suite de integracao cobre aba, nova mission, aprovar+executar e Active Run; versao 0.2.0-alpha.1
3e0b73d feat(DA-VSCODE-MVP-002): dashboard do produto dentro do VS Code — o mesmo App de apps/web atras de uma ponte sem rede
4246e1d fix(DA-VSCODE-MVP-002): base — bandeira de abandono vale tambem apos a sondagem em voo
15c454f fix(DA-VSCODE-MVP-002): base — spawn em voo conhecido pelo deactivate; stopOwnChild nunca toca dono externo; trim como o schema
80bb68b merge(DA-VSCODE-MVP-002): traz o planning de mission/DA-UX-001 para a cadeia de estabilidade
04e4206 docs(DA-UX-001): relatorio final, com o que nao foi provado dito por extenso
96f04f7 integra U16: revisao do plano e aprovacao (correcao do supervisor, revisada pelo Codex)
c485aac fix(U16): aprovacao vale para o plano inspecionado, nao para o que estiver no disco
fef40c1 U10 a2: Nova missao por linguagem natural
c9349a5 integra U06: planejamento no control plane (correcao do supervisor, 11 rodadas de revisao)
d25bc41 fix(U06): impressao digital do repositorio observa conteudo, nao so estado
916d74a U08 a2: Home do projeto no dashboard
e50de74 integra U05: planejador local (correcao do supervisor, revisada pelo Codex em 4 rodadas)
12960d2 fix(U05): planejador fecha os tres achados que bloquearam a task
708d022 integra U04: API do Project Home e do rascunho (correcao do supervisor, revisada pelo Codex)
b32cb4b fix(U04): idempotencia do rascunho vira ato serializado por plano
7dc72a8 integra U02: launcher com identidade verificada (correcao do supervisor, revisada pelo Codex)
7365fdc fix(U02): launcher confere identidade do plane e nao duplica escritor
e9a9b5b U01 a1: Contratos de planejamento e de Home
443e335 fix(workspace): commit da tentativa perdia os arquivos que ela criou
e389be5 plan(DA-UX-001): reduz para a espinha da jornada, por decisao do supervisor
932636c fix(dogfood): worktree de tentativa precisa parecer instalacao, nao so checkout
8dbbc25 plan(DA-UX-001): corrige tres defeitos achados por auditoria independente
72896c3 plan(DA-UX-001): missao de experiencia sem atrito, compilada limpa
<este relatório>
```

`git status --short` vazio após o commit deste relatório.

## Z. Veredito

🚩 **MVP_DA_EXTENSAO_ATINGIDO**, com três ressalvas explícitas para decisão humana antes de uma
release:

1. **Leitura independente.** A cadeia de revisão do Codex terminou em FAIL na segunda
   confirmação restrita; os achados (1 BLOCKER, 1 MAJOR, 1 MINOR, todos em código meu deste
   lote) foram corrigidos no commit seguinte **sem** nova leitura fresh — o limite de um ciclo
   já havia sido excedido. Recomenda-se uma leitura restrita a `5bfa66e` antes de publicar.
2. **Dogfooding com `codex`, não com `claude-code`.** A CLI `claude` desta máquina está
   desatualizada (chamada falha; `claude update` resolve). O planejador e o executor reais
   foram o `codex`, com um `project.yaml` temporário (revertido). A UI foi exercitada pela
   ponte (mesmo caminho HTTP), não por cliques.
3. **Dívidas fora do MVP, registradas:** provider de teste elegível como revisor (U12);
   `agentic init` sem `.gitignore`; probes de versão/prontidão ignoram `groupTerminated`;
   run `DA-UX-001` deste repositório ainda em VERIFYING (F5); planejamento sem cancelamento
   pela UI (contrato do planner).

**NEXT: PUBLICAR PRIMEIRA GITHUB RELEASE ALPHA DO VSIX** (não publicado automaticamente).

---

## L. Release alpha (DA-VSCODE-RELEASE-ALPHA-001)

Leitura independente restrita a `5bfa66e` (Codex fresh, read-only, esforço alto), a ressalva 1
de §Z: **PASS** — nenhuma regressão de lifecycle, nenhum segundo dono possível, `specHash` e
identidade do projeto fora do diff, `git` por `execFile` sem shell (sem path escape nem
injeção). Único achado, **NOTA pré-existente** (F2 da DA-UX-001): branch de tentativa
preservada por `release(keep)` faz o segundo run da mesma missão parar em
`GUARD_FAILED:workspace-acquired` a cada tick, agora com recusa visível em vez do sequestro
silencioso do `HEAD` da worktree viva. Testes direcionados dos dois arquivos tocados: 30/30.

Publicação (sem merge em `main`, sem Marketplace):

- Branch `feature/DA-VSCODE-MVP-002` enviada ao remoto; tag anotada `vscode-v0.2.0-alpha.1`
  apontando para `736f854` (commit validado; este relatório é um commit de docs posterior).
- GitHub Release **pré-release** "Desenvolvimento Agêntico VS Code 0.2.0-alpha.1":
  <https://github.com/EwaldoAFilho/desenvolvimento-agentico/releases/tag/vscode-v0.2.0-alpha.1>
- Asset `desenvolvimento-agentico-vscode-0.2.0-alpha.1.vsix` (1.205.939 bytes, gerado por
  `npm run vscode:package` a partir de `736f854`; sha256
  `c6c5d06128cab0ddcb6020a77a6d33bcc2ef923c0efb6f3365bcfb09af12eec4`).
- Instalação documentada no README (seção "Dentro do VS Code").

**NEXT: DA-VSCODE-MVP-003 — PRODUCT POLISH & EARLY TESTER EXPERIENCE.**
