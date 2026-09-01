# ARCHITECTURE — Desenvolvimento Agêntico

> Escopo: arquitetura alvo do MVP e as fronteiras que precisam estar certas desde o início.
> Complementos: [DOMAIN-MODEL.md](DOMAIN-MODEL.md), [STATE-MACHINES.md](STATE-MACHINES.md),
> [MISSION-FORMAT.md](MISSION-FORMAT.md), [ADRs](../adr/).

## 1. Visão em uma tela

```text
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  INTERFACES                                                              │
   │    apps/cli  (agentic ...)          apps/web (dashboard SPA)             │
   └───────────────┬──────────────────────────────────┬───────────────────────┘
                   │                                  │ HTTP + SSE
                   │                    ┌─────────────▼───────────────┐
                   │                    │  apps/server                │
                   │                    │  read API + SSE + comandos  │
                   └──────────┬─────────┴─────────────┬───────────────┘
                              │  casos de uso         │
   ┌──────────────────────────▼───────────────────────▼───────────────────────┐
   │  APPLICATION                                                             │
   │    ValidateMission · CompileMission · ApproveMission · StartRun          │
   │    PauseRun · UnblockTask · RetryTask · SkipTask · GetRunSnapshot        │
   │    GenerateMissionReport                                                 │
   └──────────────────────────┬───────────────────────────────────────────────┘
                              │
   ┌──────────────────────────▼───────────────────────────────────────────────┐
   │  ENGINE                                                                  │
   │            ORCHESTRATOR  (única autoridade de transição de estado)       │
   │                 │            │             │            │                │
   │            SCHEDULER   GATE RUNNER    INTEGRATOR   REVIEW COORDINATOR    │
   │                 │                                                        │
   │            GRAPH COMPILER ──► CompiledGraph ──► GRAPH ALGORITHMS         │
   └───────┬─────────────────┬──────────────┬──────────────┬─────────────────-┘
           │ portas          │              │              │
   ┌───────▼───────┐ ┌───────▼──────┐ ┌─────▼──────┐ ┌─────▼────────┐
   │ RunStore      │ │AgentProvider │ │ Workspace  │ │ ProcessRunner│
   │ EventStore    │ │              │ │ Provider   │ │              │
   └───────┬───────┘ └───────┬──────┘ └─────┬──────┘ └─────┬────────┘
           │                 │              │              │
   ┌───────▼───────┐ ┌───────▼──────────────────┐ ┌─▼──────────┐ ┌─▼────────────┐
   │ SQLite +      │ │ PROVIDER REGISTRY        │ │ git        │ │ GATE RUNNER  │
   │ artefatos fs  │ │  ├ MockAgentProvider     │ │ worktree / │ │              │
   │               │ │  ├ ClaudeCodeCliProvider │ │ shared     │ │              │
   │               │ │  └ CodexCliProvider      │ │            │ │              │
   └───────────────┘ └───────────┬──────────────┘ └────────────┘ └─────┬────────┘
                                 │                                     │
                     ┌───────────▼───────────┐                         │
                     │  LOCAL AGENT RUNTIME  │  processos locais:      │
                     │  probe · spawn · cancel│ pid, cwd, streams,     │
                     └───────────┬───────────┘  exit, timeout          │
                                 │                                     │
                     ┌───────────▼─────────────────────────────────────▼──┐
                     │  PROCESS RUNTIME  (spawn, tree-kill, env allowlist)│
                     └───────────┬───────────────────────────────────────-┘
                                 │
                        ┌────────▼─────────┐
                        │  AGENT WORKSPACE │  ← agentes vivem aqui. Só arquivos.
                        │  (worktree git)  │    Sem acesso ao estado do run.
                        └──────────────────┘
```

## 2. Regra de dependência

```text
        interfaces  ──►  application  ──►  domain  ◄──  adapters
```

- `domain` não importa nada de infraestrutura. Não conhece Fastify, React, SQLite, git,
  Claude, Codex ou GitHub.
- Portas (`AgentProvider`, `WorkspaceProvider`, `RunStore`, `EventStore`, `ProcessRunner`,
  `Clock`, `IdGenerator`) são **declaradas no domínio** e implementadas fora.
- `Clock` e `IdGenerator` como portas parecem exagero até o primeiro teste de máquina de
  estados: tornam o engine determinístico e testável sem relógio real.
- O dashboard não tem lógica de domínio; consome snapshot + eventos.

Verificação automatizada (task T01 do MVP): regra de lint de import boundaries — um import
de `@agentic/domain` para qualquer pacote de adapter quebra o build.

## 3. Componentes

### 3.1 Graph Compiler

`MissionSpec` → `CompiledGraph`. **Função pura**: entra texto YAML, sai grafo + diagnósticos.
Sem I/O além da leitura do arquivo, sem rede, sem banco. É o componente mais fácil de testar
e o que mais valor entrega no minuto zero. Detalhado em §7.

### 3.2 Scheduler

Função pura de decisão:

```ts
select(graph, runState, policies, now) => DispatchDecision[]
```

Não despacha nada; **decide**. Sem I/O, sem efeitos. O orquestrador executa as decisões.
Isso permite testar política de paralelismo com tabelas de estado, sem agentes.

Critérios do MVP, nesta ordem:

1. **Drenar antes de encher**: tasks aguardando revisão têm prioridade sobre novo despacho
   de execução. Sem essa regra, todos os slots viram executores, ninguém revisa e o run
   estrangula sozinho.
2. filtra candidatas (`READY` para execução, `VERIFYING`→revisão pendente para revisão);
3. descarta as cujo lock de `touches` conflita com task em voo;
4. respeita, em conjunto: `maxParallelTasks` (global), `maxExecutors`, `maxReviewers` **e
   `maxConcurrent` de cada provider** — capacidade de provider é compartilhada entre
   execução e revisão;
5. para revisão, resolve a `ReviewPolicy` da task e só seleciona um revisor que a satisfaça
   (identidade diferente; fornecedor diferente quando `cross-provider-required`);
6. ordena por: (a) está no caminho crítico, (b) número de dependentes que destrava,
   (c) risco alto primeiro, (d) ordem topológica canônica (desempate determinístico).

O item (d) garante que a mesma entrada produz sempre a mesma decisão — requisito para teste.
A capacidade entra como **dado de entrada** (`CapacitySnapshot`), não como consulta: o
scheduler continua função pura. Nada de scheduling por custo ou ML no MVP (P16).

### 3.3 Orchestrator

Loop de reconciliação, **single-writer**:

```text
tick:
  1. reconcilia tentativas órfãs (crash recovery)
  2. coleta resultados prontos (agentes, gates, integrações)
  3. aplica transições de estado + eventos (transacional)
  4. recalcula tasks READY
  5. pede decisões ao Scheduler
  6. adquire locks e workspaces; despacha
  7. avalia estado derivado do run (BLOCKED / VERIFYING / COMPLETED)
```

O tick é acionado por evento (término de agente, gate, comando humano) e por timer de
segurança. Não há concorrência de escrita: efeitos assíncronos rodam fora, mas retornam ao
loop para virar estado. É a implementação concreta de P10 e I7.

### 3.4 Gate Runner

Executa perfis de gate via `ProcessRunner`: comando, cwd, timeout, allowlist de env,
captura de stdout/stderr (truncada em disco com digest). Produz `GateExecution`.
Regra: **gate roda no workspace da tentativa**, não na árvore principal — é isso que torna a
evidência atribuível quando há paralelismo.

### 3.5 Review Coordinator

Monta o `Assignment` de revisão: contrato da task, diff, resultados de gate, `validation`.
**Não repassa a narrativa do executor** (P07/anti-viés). Seleciona identidade de revisor
distinta e valida a invariante I3 antes e depois.

### 3.6 Integrator

Consolida tentativa aprovada na branch da missão (`mission/<ID>`), a partir da branch da
tentativa (`task/<ID>/<TaskId>/a<N>`). Estratégia MVP: rebase da branch da task sobre a
branch da missão e merge fast-forward; conflito vira `INTEGRATION_CONFLICT` retentável (a
nova tentativa parte da base atualizada, o que costuma resolver).

### 3.6.1 Provider Registry, saúde e capacidade

Mantém os providers configurados, responde `health()` (com `unknown` onde a CLI não permite
apurar) e `capacity()` (contabilidade nossa: sempre conhecida). É o que alimenta
`agentic doctor`, o painel de providers do dashboard e o scheduler.

```text
Claude Code                     Codex
  installed  true                 installed  true
  ready      unknown              ready      unknown
  version    2.1.4                version    0.9.2
  running    2                     running    1
  capacity   3                     capacity   2
```

`ready: unknown` não é falha do nosso código: é a resposta honesta quando a CLI não expõe
estado de autenticação de forma confiável. A prontidão real aparece no primeiro despacho, e
uma falha por não-autenticação é classificada como `PROVIDER_NOT_READY` — que **não** consome
tentativa útil nem é retentada no mesmo provider sem ação humana.

### 3.6.2 Local Agent Runtime

Ciclo de vida de processos locais de agente: descoberta do executável, versão, prontidão,
`spawn` **sempre com `cwd` na worktree da tentativa**, streaming de stdout/stderr,
cancelamento com encerramento da árvore de processos, timeout e status de saída
normalizado. É a materialização do P17 — o agente é um programa local já autenticado pelo
usuário; não injetamos credencial nenhuma.

Abaixo dele, `Process Runtime` concentra a parte perigosa e específica de sistema
operacional (spawn, sinais, tree-kill, allowlist de ambiente, buffers) em um único lugar
testado. `Gate Runner` usa o mesmo primitivo para comandos curtos e capturados; `Local Agent
Runtime` usa para processos longos e transmitidos.

### 3.7 Persistence

SQLite embarcado (WAL) para estado + event log; artefatos volumosos (patches, logs de agente,
saídas de gate) em arquivos sob `.agentic/runs/<runId>/`, referenciados por caminho + digest.
Detalhado em §6.

### 3.8 Server e Dashboard

`apps/server`: Fastify. Endpoints de leitura (`/api/runs`, `/api/runs/:id/snapshot`,
`/api/runs/:id/tasks/:taskId`, `/api/runs/:id/events?since=`), stream `GET /api/runs/:id/stream`
(SSE) e um punhado de comandos (`pause`, `resume`, `task/:id/unblock|retry|skip`).
`apps/web`: SPA Vite + React, DAG com `@xyflow/react` + layout `dagre`.

## 4. Modelo de processo

```text
$ agentic serve                    # control plane no ar, sem run ativo
$ agentic mission start <arquivo>  # inicia um run (também disponível pelo dashboard)

┌─ processo control plane ───────────────────────────────────────┐
│  orchestrator loop  │  http+sse :4317  │  writer único do DB    │
└──────┬───────────────────────┬──────────────────┬──────────────┘
       │ spawn                 │ spawn            │ spawn
   agente executor         gate/comando        agente revisor
   (worktree A)            (worktree A)        (worktree A, sessão nova,
                                                possivelmente outro provider)
```

- **Um processo é o control plane** e o único escritor do banco.
- `agentic serve` sobe o control plane **sem** run ativo — é o que torna possível dar
  START MISSION pelo dashboard.
- `agentic mission start` inicia um run; se já houver control plane no ar, delega a ele.
- Comandos de leitura (`status`, `task inspect`, `events tail`) abrem o SQLite em modo
  leitura — funcionam com o run parado, sem daemon.
- Comandos de mutação exigem o control plane no ar e vão por HTTP local. Se não houver
  processo, o CLI diz isso em vez de escrever no banco por fora (I7).

### 4.1 Fluxo START MISSION

```text
  Dashboard (ou CLI)
        │  POST /api/missions/{id}/approve   ← ato humano, com actor registrado
        │  POST /api/runs                    ← START MISSION
        ▼
  Application  StartRun
        │   • compila (ou reusa CompiledGraph), recusa se houver ERROR
        │   • exige APPROVED; exige aceite explícito se houver WARNING
        │   • cria Run, congela o grafo, emite run.started
        ▼
  Orchestrator  tick
        │   • descobre TODAS as tasks READY (não é clique task a task)
        ▼
  Scheduler  select(graph, state, capacity, policies)
        │   • locks de touches · limites globais · capacidade por provider
        ▼
  Provider Registry ──► Local Agent Runtime ──► processos na worktree de cada tentativa
        │
        └──► eventos ──► SSE ──► DAG atualiza sozinho
```

O usuário clica **uma vez**. A descoberta do que pode rodar agora é do orquestrador — é
exatamente o produto. O dashboard **não** vira editor de missão: o YAML continua sendo o
contrato versionado, e aprovar/iniciar não altera uma linha dele.

## 5. Isolamento de trabalho

### 5.1 Por que worktree não é opcional para paralelismo real

Com dois agentes na mesma working tree, mesmo com `touches` disjuntos:

- `git diff` não atribui alteração a uma task específica de forma confiável;
- o gate da task A executa sobre código meio-escrito da task B → evidência não reproduzível;
- um `git checkout`/`stash` de um agente afeta o outro.

Logo: **paralelismo de escrita exige isolamento físico**. O MVP oferece dois modos:

| Modo | Quando | Paralelismo de escrita |
| --- | --- | --- |
| `git-worktree` (default se o alvo é repositório git) | uso normal | até `maxParallelTasks` |
| `shared` | repositório não-git ou projeto que não tolera worktree | forçado a 1 escritor |

Escolher `shared` com `maxParallelTasks > 1` é erro de configuração e falha no `doctor`.

### 5.2 Ciclo do workspace

```text
acquire(attempt) → worktree em .agentic/worktrees/<runId>/<taskId>-a<N>
                   branch task/<missionId>/<taskId>/a<N> a partir de mission/<missionId>
                   ──► workspaceSetup: link/instalação de dependências
      agente trabalha ──► commit ──► diff/scope check ──► gate ──► review (mesma worktree,
                                                                  sessão nova, leitura)
                                                                    │
                                              integrate: rebase + merge em mission/<missionId>
                                                                    │
                                   release(keep se falhou p/ perícia, discard se DONE)
```

**`workspaceSetup` não é detalhe de conveniência.** Uma worktree recém-criada não tem
`node_modules`, `.env` nem artefatos de build: sem essa etapa, *todo* task gate falharia por
motivo que nada tem a ver com o trabalho do agente. É declarado em `project.yaml` (link de
diretórios a partir da raiz, ou comandos de instalação), executado pelo `WorkspaceProvider`,
e sua falha é `WORKSPACE_ERROR` — nunca confundida com falha de gate.

O **mission gate** roda em uma worktree própria da branch `mission/<missionId>`, com o mesmo
`workspaceSetup`: valida a entrega integrada, não a última tentativa.

O que ele julga é um **commit**, não um ref. Quando a branch da missão já está em check-out
em outra worktree — o caso normal quando o repositório orquestrado é o próprio projeto — o
git recusa uma segunda worktree na mesma branch, e a aquisição passa a usar `--detach` sobre
o mesmo SHA: a mesma árvore, sem disputar o ref nem mexer em quem já o segura. Com a branch
livre, nada muda. Falhar em adquirir essa worktree é `WORKSPACE_ERROR` e **encerra o run**
com razão observável (I12) — nunca deixa o run parado em `VERIFYING`.

Ao final do run, a branch da missão fica pronta para PR. O control plane **não** faz push
nem abre PR no MVP: operação externa é decisão humana (P15).

### 5.3 Lock de escopo

Além do isolamento físico, o scheduler mantém locks lógicos por prefixo de caminho. Isolar
fisicamente evita corrupção; o lock evita duas tentativas produzindo alterações concorrentes
no mesmo arquivo que só colidiriam na integração. Os dois mecanismos são complementares:
worktree protege a execução, lock protege a convergência.

## 6. Persistência e eventos

### 6.1 Esquema (SQLite)

```text
runs(id, mission_id, spec_hash, status, policies_json, graph_json,
     created_at, approved_at, started_at, finished_at, integration_branch)

task_runs(run_id, task_id, status, attempt_count, current_attempt_id,
          unblocked_by_json, ready_at, started_at, finished_at,
          outcome, blockage_json, PRIMARY KEY(run_id, task_id))

attempts(id, run_id, task_id, attempt_number, executor_json, dispatch_reason_json,
         workspace_json, started_at, finished_at, result, failure_code, failure_detail,
         claims_json, observation_json, usage_json)

gate_executions(id, run_id, scope, gate_id, attempt_id, status,
                started_at, finished_at, results_json)

reviews(id, attempt_id, reviewer_json, verdict, findings_json, rationale, duration_ms)

events(seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id, ts, type, actor,
       task_id, attempt_id, payload_json)

locks(run_id, path_prefix, attempt_id, acquired_at)
artifacts(id, run_id, kind, path, digest, bytes, created_at)
```

Artefatos em disco:

```text
.agentic/
  state.db
  runs/<runId>/
    attempts/<taskId>-a<N>/{agent.log.jsonl, patch.diff, gate-<id>.stdout, review.json}
    report.json
  worktrees/<runId>/<taskId>-a<N>/
```

`.agentic/state.db`, `runs/` e `worktrees/` são gitignored. O que é versionado: missões,
gates, políticas e o relatório final em `docs/missions/`.

### 6.2 Estado materializado + event log (não event sourcing)

Adotamos o híbrido: tabelas de estado corrente **e** log append-only, gravados na mesma
transação.

- Consulta operacional é `SELECT` direto — o dashboard não replica um log para saber que a
  T04 está em REVIEW.
- Auditoria e timeline vêm do log.
- Divergência é impossível por construção (uma transação).

Event sourcing puro exigiria projeções, versionamento de eventos e replay — custo alto sem
caso de uso presente (P16, ADR-0004).

### 6.3 Streaming para o dashboard

`GET /api/runs/:id/stream` (SSE) envia eventos a partir de `since=seq`. Cliente aplica sobre
o snapshot inicial. Reconexão pede `since=último seq visto` — sem perda, sem polling.

## 7. Graph Compiler — pipeline

```text
arquivo.yaml
   │ parse YAML (falha → DA1000 PARSE_ERROR, com linha/coluna)
   ▼
documento
   │ validação de schema (zod): tipos, obrigatoriedade, formatos
   ▼
MissionSpec
   │ validação semântica
   ▼
grafo
   │ análises
   ▼
CompiledGraph + Diagnostic[]
```

### 7.1 Catálogo de diagnósticos

| Código | Severidade | Verificação |
| --- | --- | --- |
| `DA1000` | ERROR | YAML inválido |
| `DA1001` | ERROR | Falha de schema (campo obrigatório, tipo, formato de id) |
| `DA1002` | ERROR | `TaskId` duplicado |
| `DA1003` | ERROR | Dependência inexistente (`T05 → T99`) |
| `DA1004` | ERROR | Auto-dependência (`T01 → T01`) |
| `DA1005` | ERROR | Ciclo detectado (mensagem lista o ciclo completo) |
| `DA1006` | ERROR | `phase` referenciada não declarada |
| `DA1007` | ERROR | `gate` referenciado não existe em `gates.yaml` |
| `DA1008` | ERROR | `touches` fora do repositório, vazio ou dentro de `denyPaths` |
| `DA1009` | ERROR | `objective` ausente/vazio em task que altera código |
| `DA1010` | ERROR | `maxParallelTasks > 1` com workspace `shared` |
| `DA1011` | ERROR | `agentProfile`/provider referenciado não existe no registry do projeto |
| `DA2001` | WARNING | Conflito de `touches` entre tasks concorrentes (par listado) |
| `DA2002` | WARNING | Task sem `validation` e sem `gate` — conclusão não verificável |
| `DA2003` | WARNING | Task grande demais (heurística: `touches` amplo + muitos objetivos + estimativa alta) |
| `DA2004` | WARNING | Fragmentação excessiva (heurística: task sem gate, escopo mínimo, cadeia linear de microtasks) |
| `DA2005` | WARNING | `touches` amplo demais (raiz do repo, `src/` inteiro) |
| `DA2006` | WARNING | Task terminal sem dependentes e fora do mission gate — trabalho órfão |
| `DA2007` | WARNING | `requireReview: false` em task com `risk: high` |
| `DA2008` | WARNING | Missão exige `cross-provider-required` e o projeto tem menos de dois providers aptos a revisar |
| `DA3001` | INFO | Task de fase posterior sem dependência de fase anterior |
| `DA3002` | INFO | Grafo sem paralelismo real (cadeia linear) |

`ERROR` impede compilar. `WARNING` compila, aparece no relatório e no dashboard, e o start
exige `--accept-warnings` — atrito deliberado.

### 7.2 Análises produzidas

- **Ordem topológica** (Kahn, desempate por ordem de declaração → determinismo).
- **Ciclos** (Tarjan SCC; erro cita o ciclo inteiro, não "há um ciclo").
- **Alcançabilidade** (fecho transitivo; base para concorrência).
- **Concorrência potencial**: pares sem relação de ordem em nenhuma direção.
- **Conflitos de touches**: pares concorrentes com prefixos sobrepostos.
- **Caminho crítico**: maior caminho ponderado por `estimate` (default 1).
- **Waves**: agrupamento por *earliest start* — visualização do plano, **não** o modelo do
  scheduler (o scheduler é orientado a evento, não a onda).

### 7.3 Heurísticas (DA2003/DA2004) — postura

O compilador **sinaliza**, não corrige. Não decompõe task automaticamente nem funde
microtasks. Decisão de granularidade é humana (P15).

## 8. Agent Provider

O domínio define a porta (ver DOMAIN-MODEL §4.1). Dois adapters no MVP:

| Adapter | Uso |
| --- | --- |
| `mock` | testes determinísticos: roteiro de resultados por task, sem LLM, sem custo |
| `claude-code` | execução real via CLI headless em modo não interativo, cwd = worktree |

O `mock` não é brinquedo: sem ele, testar o orquestrador exigiria agentes reais — caros,
lentos e não determinísticos. É o que torna o gate de qualidade do próprio produto viável.

O que atravessa a fronteira:

```text
Assignment  ──►  provider  ──►  AgentOutcome { status, claims, usage?, logsRef }
                                                    │
                              control plane ignora `claims` para decidir;
                              calcula Observation a partir do git e dos gates.
```

Trocar de fornecedor é escrever um adapter. Nenhuma linha do domínio muda. Se um dia um
provider "não devolver diff", tanto faz: o diff nunca veio dele.

## 9. Segurança

| Superfície | Postura no MVP |
| --- | --- |
| Comandos de gate | vêm de `.agentic/gates.yaml`, versionado e humano; agente nunca define gate |
| `.agentic/` | em `denyPaths` por padrão: agente que altera política comete `SCOPE_VIOLATION` |
| Segredos | `env` do gate é allowlist explícita; `.env` em `denyPaths`; saídas passam por redator de padrões sensíveis antes de virar artefato |
| Credenciais de IA | **não gerenciamos nenhuma** (P17). A autenticação é do CLI local do usuário; não pedimos, não guardamos e não injetamos chave no ambiente do processo do agente |
| Rede do servidor | bind em `127.0.0.1` por padrão; sem autenticação porque não há superfície remota. Expor exige flag e, aí sim, token |
| Sandbox do agente | responsabilidade do provider; o control plane limita **escopo verificado a posteriori**, não confinamento do processo. Limitação assumida e documentada |
| Push / PR | não automatizados no MVP |

## 10. Observabilidade

- **Eventos** são a espinha: toda transição gera evento tipado.
- **Métricas derivadas do log** (sem coletor externo no MVP): duração por task, tempo de
  review, tentativas, taxa de reprovação, tempo em `BLOCKED`, razão de paralelismo
  (`Σ duração de tasks / wall time`), caminho crítico real.
- **Logs de agente** viram artefatos por tentativa, nunca ruído no terminal do orquestrador.

## 11. Estrutura do repositório

```text
apps/
  cli/            # binário `agentic`
  server/         # HTTP + SSE + serve o build do dashboard
  web/            # dashboard (Vite + React)
packages/
  domain/         # entidades, máquinas de estado, portas, políticas puras
  schemas/        # zod: mission.yaml, project.yaml, gates.yaml, contratos da API
  graph/          # algoritmos de grafo genéricos (sem domínio)
  compiler/       # graph compiler (schemas + graph → CompiledGraph)
  persistence/    # SQLite: RunStore, EventStore, artifacts
  process/        # primitivo de SO: spawn, timeout, tree-kill, env allowlist, streams
  gates/          # GateRunner (comandos curtos, capturados) sobre `process`
  agent-runtime/  # LocalAgentRuntime: probe, spawn, streaming, cancel sobre `process`
  workspace/      # WorkspaceProvider (shared, git-worktree) + Integrator + diff/scope
  providers/      # AgentProvider: mock, claude-code-cli, codex-cli + ProviderRegistry
  orchestrator/   # scheduler + orchestrator + casos de uso (application)
docs/             # produto, arquitetura, ADRs, método, missões
.agentic/         # project.yaml, gates.yaml, missions/
```

**Pacotes que decidimos NÃO criar** (e por quê): `events` (o EventStore mora em
`persistence`), `metrics` (derivadas do log, sem componente próprio), `common/utils` (lixeira
disfarçada), `api-client` (o dashboard usa os tipos de `schemas` direto), `logger`
(dependência fina no server). Cada pacote existente corresponde a uma fronteira de teste e
substituição real (ADR-0001, ADR-0012).

## 12. O que a arquitetura deliberadamente não faz

Multi-tenant, autenticação de usuários, fila distribuída, execução remota, múltiplos
repositórios por missão, editor visual de missão, replanejamento em tempo de execução,
integração com GitHub, contabilidade de custo, **adapters de agente por API paga** e
**integração com editor** (ver abaixo). Nenhum deles é impedido pelo desenho — todos entram
por adapter, política ou nova aplicação, sem tocar o domínio.

**Afordância deixada pronta (sem implementação agora):** o caminho da worktree de cada
tentativa é dado de primeira classe, exposto na API de detalhe da task, no `agentic task
inspect` e no painel do dashboard. Com isso, `code <path>` já resolve hoje o caso "quero
abrir essa task no meu editor", e um futuro botão *Open Workspace in VS Code* é uma ação de
UI sobre um dado que já existe — não uma mudança de arquitetura. O princípio: a plataforma
orquestra agentes via runtime local, **não impede** o desenvolvedor de abrir o editor e
trabalhar na mesma árvore.
