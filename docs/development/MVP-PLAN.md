# MVP PLAN — Missão DA-CORE-001

> Plano de construção do MVP, escrito no próprio formato do produto. A versão executável
> está em [`.agentic/missions/DA-CORE-001.mission.yaml`](../../.agentic/missions/DA-CORE-001.mission.yaml).
> Isso não é enfeite: é o primeiro teste do formato de missão.
>
> **Revisão 2** (patch arquitetural): dois providers reais locais, Local Agent Runtime,
> capacidade por fornecedor, revisão cruzada e START MISSION pelo dashboard. Todos os números
> deste documento foram **recalculados**; nenhum foi preservado da revisão 1.

## 1. Objetivo do MVP

Executar uma missão real de 8–15 tasks com dependências, escopos declarados, quality gates e
revisão independente, sobre um projeto real, com múltiplos executores simultâneos usando
**agentes locais já autenticados pela assinatura do usuário**, persistindo estado, eventos e
evidências, com DAG observável em tempo real e relatório final.

## 2. Escopo

**Entra**

| Área | Entrega |
| --- | --- |
| Formato | `mission.yaml`, `project.yaml`, `gates.yaml` com schema formal |
| Compilação | validação de schema e semântica, 22 diagnósticos, DAG, caminho crítico, waves, conflitos de escopo |
| Execução | orquestrador com scheduler, locks de escopo, limites globais e **capacidade por fornecedor**, retry com backoff, escalonamento |
| Agentes locais | **Process Runtime** + **Local Agent Runtime**: processo, cwd na worktree, streams, pid, timeout, cancelamento, saúde |
| Providers | porta + `MockAgentProvider` + `ClaudeCodeCliProvider` + `CodexCliProvider`, suíte de contrato única, **sem API key** |
| Revisão | independente, com política `fresh-session` / `cross-provider-preferred` / `cross-provider-required` |
| Isolamento | git worktree por tentativa + integração na branch da missão; modo `shared` sequencial |
| Qualidade | Task Gate e Mission Gate, executados pelo control plane |
| Evidência | diff, escopo, exit codes, saídas, commits — observados, não declarados |
| Estado | SQLite + event log append-only na mesma transação; recuperação após queda |
| Interfaces | CLI completa (inclui `serve`, `providers`, `doctor`) + dashboard com DAG vivo e **START MISSION** |
| Relatório | relatório final da missão com métricas e evidências |

**Não entra:** ver §9.

## 3. Tabela de tasks

17 tasks. Estimativas são relativas (unidades de trabalho) e servem ao caminho crítico — não
são compromisso de prazo. **Folga** é `LS − ES`: zero significa caminho crítico.

| ID | Fase | Título | Deps | Touches | Validação (reproduzível) | Gate | Risco | Est. | Folga |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T01 | foundation | Bootstrap do monorepo e fronteiras | — | raiz (`package.json`, `tsconfig`, `biome`, `vitest`) | `verify` verde; import de adapter em `domain` **quebra o lint** | unit | low | 2 | 0 |
| T02 | core | Domínio, máquinas de estado e portas | T01 | `packages/domain/` | toda transição testada; predicado DONE; resolução de `ReviewPolicy` nos 4 níveis; **busca por nome de fornecedor no pacote não retorna nada** | unit | medium | 6 | 0 |
| T03 | core | Schemas declarativos e contratos de API | T02 | `packages/schemas/` | fixtures válidas/inválidas; erro com linha/coluna; registry de providers com `maxConcurrent`/`roles`; contratos de saúde, aprovação e START MISSION | unit | low | 4 | 0 |
| T04 | core | Algoritmos de grafo | T01 | `packages/graph/` | grafos-fixture; ciclo descrito; determinismo | unit | low | 3 | 7 |
| T05 | compiler | Graph Compiler | T03, T04 | `packages/compiler/` | uma fixture por diagnóstico; `specHash` estável; `DA1011` e `DA2008` | unit | medium | 5 | 0 |
| T16 | infra | **Process Runtime** | T01 | `packages/process/` | timeout mata a árvore de processos (verificado por pid); cancelamento devolve status próprio; env fora da allowlist ausente; saída volumosa truncada com digest | unit | medium | 3 | 4 |
| T06 | infra | Persistência SQLite e event log | T02 | `packages/persistence/` | falha no meio da transação não grava **nada**; leitura concorrente; migrations idempotentes | unit | medium | 5 | 8 |
| T07 | infra | Gate Runner | T03, T16 | `packages/gates/` | `FAIL` com exit code; `TIMEOUT` sem filho sobrevivente; `required:false`; gate roda com `cwd` na worktree | unit | medium | 3 | 6 |
| T08 | infra | Workspace, isolamento git e integração | T02 | `packages/workspace/` | duas worktrees independentes; `SCOPE_VIOLATION`; `INTEGRATION_CONFLICT`; `workspaceSetup` | unit | **high** | 6 | 7 |
| T17 | infra | **Local Agent Runtime** | T02, T16 | `packages/agent-runtime/` | `probe` devolve installed/ready/version usando **`unknown` quando a CLI não permite apurar**; executável ausente → `installed:false` sem exceção; `spawn` recusa cwd fora de worktree; handle expõe pid/cwd/startedAt/exit; **nenhuma credencial lida ou injetada** | unit | **high** | 5 | 1 |
| T09 | infra | Agent Providers (mock, Claude Code CLI, Codex CLI) | T17 | `packages/providers/` | **uma suíte de contrato para os três**; mock determinístico sem rede; adapters reais com stubs de processo e fixtures, **sem consumir quota**; cwd informado; streaming; cancelamento e timeout distintos de erro; CLI ausente → `PROVIDER_UNAVAILABLE`; não autenticada → `PROVIDER_NOT_READY`; `maxConcurrent` respeitado; `readinessProbe` declarado sem inventar suporte | unit | **high** | 7 | 1 |
| T10 | engine | Scheduler | T05 | `orchestrator/src/scheduler/` | nunca seleciona par com touches sobreposto; respeita os 3 limites **e `maxConcurrent` por provider**; capacidade compartilhada entre execução e revisão; **revisão tem prioridade (teste de inanição)**; puro e determinístico | unit | medium | 4 | 0 |
| T11 | engine | Orchestrator | T06,T07,T08,T09,T10 | `orchestrator/src/{engine,application}/` | run completo cobrindo retry, review FAIL, BLOCKED, mission gate; `cross-provider-required` bloqueia em vez de rebaixar; `preferred` rebaixa **com registro**; nenhum despacho excede capacidade; falha de provider não incrementa `attemptCount`; **kill no meio + restart sem duplicar** | unit | **high** | 9 | 0 |
| T12 | interfaces | CLI `agentic` | T05, T11 | `apps/cli/` | exit code ≠ 0 em missão inválida; `--json` estável; `doctor`; `providers` com `unknown` visível; `task inspect` expõe worktree/branch; `serve` sobe sem run | unit | low | 4 | 1 |
| T13 | interfaces | Server: read API, SSE e comandos | T11 | `apps/server/` | reconexão SSE sem perda nem duplicata; START MISSION recusa missão não aprovada ou com `ERROR`; `WARNING` exige aceite registrado; aprovação grava `actor` | unit | medium | 5 | 0 |
| T14 | interfaces | Dashboard do DAG | T03 | `apps/web/` | componentes sobre fixture; legível com 17 nós e 7 fases com posição estável; 12 estados sem depender só de cor; **dependentes acendem READY sem reload**; painel de detalhe com provider/worktree/branch/revisor; START MISSION; `unknown` exibido como `unknown` | web | medium | 7 | 16 |
| T15 | quality | E2E, missão real e relatório | T12,T13,T14 | `tests/e2e/`, `examples/` | `test:e2e` determinístico em duas execuções; **cenário cross-provider com dois mocks distintos**; nenhum teste consome quota real; relatório com evidências citáveis | mission | **high** | 5 | 0 |

Trabalho total: **83 unidades** (era 67).

## 4. DAG

```text
T01 Bootstrap
 │
 ├──► T02 Domain ─┬──► T03 Schemas ─┬──► T05 Compiler ──► T10 Scheduler ──┐
 │                │                 │                                     │
 │                │                 ├──► T07 Gates ◄──────┐               │
 │                │                 │                     │               │
 │                │                 └──► T14 Dashboard ───┼───────┐       │
 │                │                                       │       │       │
 │                ├──► T06 Persistence ───────────────────┼───────┼───────┤
 │                ├──► T08 Workspace ─────────────────────┼───────┼───────┤
 │                │                                       │       │       │
 │                └──► T17 Agent Runtime ──► T09 Providers┼───────┼───────┤
 │                            ▲                           │       │       │
 ├──► T04 Graph ──────────────┼──► (T05)                  │       │       ▼
 │                            │                           │       │  T11 Orchestrator
 └──► T16 Process ────────────┴───────────────────────────┘       │       │
                                                                  │       ├──► T12 CLI ───┐
                                                                  │       └──► T13 Server ┤
                                                                  └──────────────────────►│
                                                                                     T15 E2E
```

`T16 Process` alimenta tanto `T07 Gates` (comandos curtos, capturados) quanto
`T17 Agent Runtime` (processos longos, transmitidos). É a razão de ele existir: o código
perigoso de sistema operacional — sinais, tree-kill, buffers — fica em **um** lugar testado.

Por fase:

```text
FOUNDATION ──────────  T01
CORE ────────────────  T02   T03   T04
COMPILER ────────────  T05
INFRA ───────────────  T16   T06   T07   T08   T17   T09
ENGINE ──────────────  T10 ─► T11
INTERFACES ──────────  T12   T13   T14
QUALITY ─────────────  T15
```

`T14` (interfaces) começa junto com `T05` (compiler): fase é agrupamento visual, o DAG é que
manda (P02).

## 5. Plano de paralelização

Ondas por *earliest start* (visualização do plano, não o modelo do scheduler):

| Onda | Tasks | Podem executar juntas porque |
| --- | --- | --- |
| 1 | T01 | — |
| 2 | T02, T04, **T16** | `graph` é genérico (ids string) e `process` é primitivo de SO — nenhum conhece o domínio |
| 3 | T03, T06, T08, **T17** | dependem de `domain` (T17 também de `process`); quatro pacotes distintos |
| 4 | T05, T07, **T09**, T14 | compiler × gates × providers × web: zero sobreposição |
| 5–8 | T10 · T11 · T12+T13 · T15 | junções reais do control plane |

**Verificado por cálculo:** 50 pares concorrentes, **zero conflito de `touches`**, nenhum
ciclo.

**O que não pode ser paralelo, e por quê**

| Par | Motivo |
| --- | --- |
| T16 × T07/T17 | ambos consomem o primitivo de processo; construí-lo depois seria retrabalho |
| T17 × T09 | os adapters são construídos **sobre** o runtime local |
| T10 × T11 | ambos em `packages/orchestrator/`; T11 consome a API do scheduler |
| T11 × adapters (T06–T09) | o orquestrador é o ponto de junção |
| T15 × tudo | é o gate final |

### Makespan por número de executores

| Executores | 1 | 2 | 3 | **4** | 5 |
| --- | --- | --- | --- | --- | --- |
| Makespan | 83 | 47 | 42 | **40** | 40 |

**O ponto ótimo mudou: era 3, agora é 4.** O patch acrescentou 16 unidades de trabalho
paralelizável (Process Runtime, Local Agent Runtime, segundo provider), alargando as ondas 2
a 4. Com 3 executores o plano custa 42 (+5%); com 4 atinge o caminho crítico; o quinto não
reduz nada.

Isso motivou atualizar `.agentic/project.yaml` para `maxExecutors: 4` e
`maxParallelTasks: 5` — teto global igual à capacidade somada dos fornecedores (3 + 2).

**Ressalva honesta do modelo:** o makespan considera apenas o trabalho de implementação de
cada task. Gate e revisão consomem tempo e **capacidade de provider** que o modelo não
representa, e a regra "revisão antes de novo despacho" reduz o paralelismo efetivo de
execução. Trate 40 como piso estrutural, não como previsão.

## 6. Caminho crítico

```text
T01(2) → T02(6) → T03(4) → T05(5) → T10(4) → T11(9) → T13(5) → T15(5)  = 40
```

Único, sem empate — diferente da revisão 1, onde CLI e Server empatavam. `T13 Server` entrou
no caminho crítico ao absorver os comandos de aprovação e START MISSION; `T12 CLI` ficou com
folga 1.

### Cadeia quase crítica — o alerta que este cálculo produziu

```text
T01(2) → T02(6) → T17(5) → T09(7) → T11(9) → T13(5) → T15(5)  = 39   (folga 1)
```

`T17 Local Agent Runtime` e `T09 Agent Providers` são as duas tasks de **risco alto** com
**folga 1**. Qualquer atraso nelas vira atraso do MVP, e são justamente as que dependem do
comportamento de CLIs externas — o território menos previsível do projeto.

Consequências para a condução:

1. **T17 e T09 começam na primeira janela possível** e recebem atenção de revisão como se
   estivessem no caminho crítico. Praticamente estão.
2. `T02` e `T11` concentram 15 das 40 unidades. São o que mais custa refazer.
3. `T08` (worktree, risco alto) tem folga 7 e `T14` (dashboard) folga 16 — não são o gargalo,
   apesar de T08 seguir sendo o maior risco técnico isolado.
4. Encurtar o MVP passa por reduzir `T11` ou por desacoplar `T13` — não por adicionar
   executores além de 4.

As análises acima (ciclos, ordem topológica, 50 pares concorrentes, conflitos, waves, caminho
crítico, folgas e makespan) foram **calculadas** sobre o arquivo da missão. É o mesmo conjunto
que o `Graph Compiler` (T05) precisa produzir: o plano do MVP é a primeira fixture de teste do
compilador.

## 7. Gates deste projeto

```yaml
unit:    npm run lint · npm run typecheck · npm run test
web:     npm run lint -w @agentic/web · npm run typecheck -w @agentic/web · npm run build -w @agentic/web
mission: npm run verify · npm run test:e2e
```

`npm run verify` = `lint && typecheck && test` na raiz. São os gates **deste** repositório;
o projeto orquestrado declara os seus em seu próprio `.agentic/gates.yaml`, em qualquer
linguagem ou ferramenta.

## 8. Sequência recomendada de execução humana

O MVP é construído **antes** de existir orquestrador — à mão ou com agente único. A ordem
segue as ondas, com uma exceção deliberada: **antecipar T16 → T17 → T09**, a cadeia quase
crítica de maior risco.

Ponto de virada: concluídos `T11` + `T12`, já é possível rodar a missão `DA-CORE-002`
(dashboard e polimento) **na própria ferramenta**, com providers mock primeiro e reais
depois. O dogfooding começa na onda 7, não depois do MVP inteiro.

## 9. Fora do escopo do MVP

Multi-tenant, billing, marketplace, Kubernetes, microserviços, filas distribuídas, cluster,
ML para scheduling, permissões corporativas, OAuth, mobile, analytics avançado, editor
visual de missões, workflow engine genérica, plataforma de CI/CD, integração GitHub, phase
gates, replanejamento em runtime, missões multi-repositório, execução remota, contabilidade
de custo/token, templates de missão, **adapters de agente por API paga** e **integração
programática com editor** (o caminho da worktree é exposto; abrir o editor é `code <path>`).

Todos são compatíveis com a arquitetura. Nenhum entra agora.

## 10. Riscos do plano

| # | Risco | Impacto | Mitigação |
| --- | --- | --- | --- |
| R1 | Contrato das CLIs externas muda (saída, flags, modo não interativo) | **Alto** | adapters finos sobre `LocalAgentRuntime`; fixtures gravadas; suíte de contrato única; `mock` como caminho de teste padrão |
| R2 | Worktree com casos de borda (hooks, submódulos, build por caminho absoluto) | Alto | T08 cedo apesar da folga; modo `shared` como saída; `workspaceSetup` |
| R3 | Revisor de IA carimbar PASS | Alto | gate mecânico decide antes; veredito sem evidência citável é inválido; **revisão cruzada entre fornecedores** em risco alto; medir taxa de reprovação por revisor e por par de fornecedores |
| R4 | **Cadeia T17→T09 com folga 1 e risco alto** | **Alto** | antecipar na sequência de execução; tratar como caminho crítico; se estourar, `codex` vira entrega incremental pós-MVP (a porta e a suíte de contrato já ficam prontas) |
| R5 | Prontidão de CLI indeterminável leva a falha só no primeiro despacho | Médio | `unknown` explícito; `PROVIDER_NOT_READY` não consome tentativa; `doctor` antes de iniciar; aviso na tela de START MISSION |
| R6 | Capacidade de provider transformar revisão em gargalo (inanição) | Médio | regra "drenar antes de encher" no scheduler + teste de inanição em T10 |
| R7 | Custo/tempo de agentes reais na validação | Médio | E2E de CI usa mocks; execução real é roteiro manual; nenhum teste consome quota |
| R8 | `T11` crescer demais (9 unidades) | Médio | scheduler já isolado em T10; se passar de 9, quebrar em "loop" e "políticas de retry/escalonamento/seleção de revisor" |
| R9 | Determinismo do E2E | Médio | `Clock` e `IdGenerator` como portas; providers mock roteirizados |
| R10 | Escopo do dashboard inflar com START MISSION | Médio | seis ações no total, todas listadas; **não** vira editor de missão |
