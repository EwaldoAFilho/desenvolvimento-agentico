# DOMAIN MODEL — Desenvolvimento Agêntico

> Linguagem ubíqua e responsabilidades. Este documento é normativo: código do domínio deve
> refletir estes nomes.

## 0. A separação que estrutura tudo: Definição × Execução

O documento fundador tratava `status` como atributo da Mission. O discovery mostrou que isso
mistura duas coisas com ciclos de vida diferentes:

| | **Definição (spec)** | **Execução (run)** |
| --- | --- | --- |
| Onde vive | arquivo YAML no repositório do projeto | banco do control plane |
| Quem escreve | humano (e futuramente agente planejador) | apenas o orquestrador |
| Muda | por commit | por evento, em tempo real |
| Quantidade | uma definição | N execuções da mesma definição |
| Versionamento | git | append-only event log |

Portanto:

```text
MissionSpec (arquivo, imutável por versão, identificada por hash)
      │  compilação
      ▼
CompiledGraph (DAG validado, determinístico, hasheável)
      │  instanciação
      ▼
Run (execução) ──► TaskRun ──► Attempt ──► Review / GateExecution / Evidence
```

Isso torna trivial: reexecutar uma missão, comparar duas execuções da mesma missão, e
provar que a execução X corresponde exatamente à definição Y (`specHash`).

---

## 1. Mapa de entidades

```text
                        ┌─────────────────┐
                        │   MissionSpec   │  (arquivo .mission.yaml)
                        │  id, objective  │
                        └───┬──────────┬──┘
                     1..*   │          │  1..*
                 ┌──────────▼──┐    ┌──▼──────────┐
                 │    Phase    │    │  TaskSpec   │
                 └─────────────┘    └──┬───┬──────┘
                                       │   │ dependencies (TaskSpec.id[])
                                       │   └───────────────┐
                                       │ touches           │
                                  ┌────▼─────┐        ┌────▼────────┐
                                  │ PathScope│        │  Dependency │ (aresta do DAG)
                                  └──────────┘        └─────────────┘

   compilação ──► CompiledGraph { nodes, edges, order, waves, criticalPath, conflicts }

                        ┌─────────────────┐
                        │       Run       │  specHash, status, policies, timestamps
                        └───┬─────────────┘
                       1..* │
                        ┌───▼─────────────┐        ┌──────────────┐
                        │     TaskRun     │───────►│  Blockage    │
                        │ status, attempts│        └──────────────┘
                        └───┬─────────────┘
                       1..* │
                        ┌───▼─────────────┐
                        │     Attempt     │ executor, workspace, dispatchReason
                        └─┬────┬────┬─────┘
                          │    │    │
             ┌────────────▼┐ ┌─▼──────────────┐ ┌▼───────────────┐
             │ Observation │ │ GateExecution  │ │     Review     │
             │ (diff/scope)│ │ (comandos)     │ │ verdict+findings│
             └──────┬──────┘ └───────┬────────┘ └───────┬────────┘
                    └────────────────┴──────────────────┘
                                     ▼
                                 Evidence  (registro citável e reproduzível)

   Transversal:  Event (append-only)  ·  AgentProvider  ·  Workspace  ·  AgentProfile
```

---

## 2. Entidades de definição

### 2.1 MissionSpec

Uma entrega de engenharia declarada.

| Campo | Tipo | Notas |
| --- | --- | --- |
| `id` | `MissionId` | identidade permanente, ex. `DA-BPM-021`. Regex `^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\d{3,}$` |
| `title` | string | |
| `objective` | string | resultado esperado, uma frase verificável |
| `description` | string? | |
| `scope` / `outOfScope` | string[] | fronteiras narrativas para os agentes |
| `constraints` | string[] | restrições técnicas obrigatórias |
| `acceptanceCriteria` | string[] | critérios da missão (avaliados no mission gate + review final) |
| `defaults` | `MissionDefaults` | `gate`, `requireReview`, `maxAttempts`, `agentProfile` |
| `phases` | `Phase[]` | |
| `tasks` | `TaskSpec[]` | |
| `missionGate` | `GateRef?` | gate final da missão |

**Responsabilidade:** representar a intenção. Não conhece estado de execução, provider,
banco ou agente.

### 2.2 Phase

Agrupamento lógico e visual (`DISCOVERY`, `BACKEND`, `QUALITY`...).

| Campo | Tipo |
| --- | --- |
| `id` | `PhaseId` |
| `title` | string |
| `order` | number (opcional; default = ordem de declaração) |

**Responsabilidade:** organizar leitura e visualização.
**Não é responsabilidade:** ordenar execução. Phase **não cria dependência**. Se uma task de
`FRONTEND` precisa de uma de `BACKEND`, isso é uma aresta no grafo, não a fase.
O compilador emite `INFO` quando uma fase posterior tem task sem nenhuma dependência de fase
anterior — só para revelar dependências esquecidas, nunca para inferi-las.

### 2.3 TaskSpec

Menor unidade operacional.

| Campo | Tipo | Notas |
| --- | --- | --- |
| `id` | `TaskId` | único na missão, ex. `T04` |
| `phase` | `PhaseId` | |
| `title` | string | |
| `objective` | string | **obrigatório** — o que precisa ser verdade ao final |
| `description` | string? | contexto adicional |
| `dependencies` | `TaskId[]` | arestas de entrada |
| `touches` | `PathScope[]` | caminhos de escrita permitidos |
| `reads` | `PathScope[]?` | leitura relevante (contexto, não trava) |
| `validation` | string[] | critérios verificáveis para o revisor |
| `gate` | `GateRef?` | perfil de gate a executar |
| `requireReview` | boolean | default do `MissionDefaults` |
| `maxAttempts` | number | default do `MissionDefaults` |
| `risk` | `low \| medium \| high` | usado em priorização e política de escalonamento |
| `estimate` | number? | unidade relativa; alimenta caminho crítico ponderado |
| `agentProfile` | `AgentProfileId?` | especialização desejada |

**Invariantes:** `objective` não vazio; `dependencies` sem auto-referência; `touches` não
vazio para task que altera código; `maxAttempts ≥ 1`.

### 2.4 PathScope

Caminho POSIX relativo à raiz do repositório, normalizado. Prefixo de diretório (terminado
em `/`) ou arquivo específico. Sem globs no MVP — um prefixo de diretório já cobre o caso.

**Semântica:** `A` conflita com `B` se um é prefixo do outro.

### 2.5 Dependency

Aresta dirigida `from → to` significando "`to` não pode iniciar antes de `from` estar
`DONE`". Existe um único tipo (`finish-to-start`) e **não há campo `kind` no formato**:
adicionar um discriminador para tipos que não existem seria abstração sem caso de uso.
Se um dia houver dependência fraca, ela entra como campo novo — o schema é versionado.

### 2.6 CompiledGraph

Produto do Graph Compiler. Imutável, determinístico, serializável, hasheável.

| Campo | Conteúdo |
| --- | --- |
| `specHash` | hash do conteúdo normalizado da MissionSpec |
| `nodes` | TaskSpec + índices derivados (dependents, depth) |
| `edges` | dependências |
| `topologicalOrder` | ordem canônica determinística |
| `waves` | agrupamento por *earliest start* (visualização e plano) |
| `criticalPath` | sequência que limita o tempo mínimo |
| `concurrencyMatrix` | pares sem relação de ordem (candidatos a simultaneidade) |
| `touchConflicts` | pares concorrentes com escopo sobreposto |
| `diagnostics` | `Diagnostic[]` com código, severidade, alvo, mensagem |

---

## 3. Entidades de execução

### 3.1 Run

Uma execução de uma MissionSpec compilada.

| Campo | Notas |
| --- | --- |
| `id` | `RunId` (ULID) |
| `missionId`, `specHash` | vínculo com a definição |
| `graph` | CompiledGraph serializado (congelado no início) |
| `status` | ver STATE-MACHINES |
| `policies` | limites efetivos no momento do start (paralelismo, timeouts, workspace mode) |
| `createdAt`, `approvedAt`, `startedAt`, `finishedAt` | |
| `missionGateExecutionId` | resultado do gate final |
| `integrationBranch` | branch de missão, se houver isolamento git |

**Congelar o grafo no início é decisão deliberada:** alterar `mission.yaml` durante a
execução não muda o run corrente. Mudança de plano exige operação explícita
(`agentic mission replan`, fora do MVP) — evita divergência silenciosa entre plano e
execução.

### 3.2 TaskRun

Estado de uma task dentro de um run.

| Campo | Notas |
| --- | --- |
| `runId`, `taskId` | |
| `status` | `TaskStatus` |
| `attemptCount` | número de tentativas consumidas |
| `currentAttemptId` | |
| `unblockedBy` | dependências cuja conclusão liberou esta task (auditoria: "por que agora?") |
| `readyAt`, `startedAt`, `finishedAt` | |
| `blockage` | motivo/ escalonamento quando `BLOCKED` |
| `outcome` | `DONE`, `FAILED`, `SKIPPED`, `CANCELLED` + razão |

### 3.3 Attempt

Uma execução concreta da task por um agente. **Append-only. Nunca sobrescrita.**

| Campo | Notas |
| --- | --- |
| `id`, `taskRunId`, `attemptNumber` | |
| `executor` | `AgentIdentity`: profile, **provider**, model, sessionRef, runtime handle |
| `dispatchReason` | por que foi despachada agora: deps satisfeitas, lock adquirido, slot livre, prioridade |
| `workspace` | `WorkspaceRef` (path, tipo, branch, baseCommit) |
| `startedAt`, `finishedAt`, `durationMs` | |
| `claims` | `AgentOutcome.claims` — relato do agente. Armazenado como **informação operacional** (depuração, relatório, análise de processo). **Nunca é evidência suficiente para `DONE`.** |
| `observation` | `Observation` — fatos medidos pelo control plane |
| `gateExecutions` | resultados de gate desta tentativa |
| `review` | revisão desta tentativa, se houver |
| `result` | `PASS \| FAIL \| ERROR \| TIMEOUT \| CANCELLED` |
| `failureReason` | `FailureCode` + detalhe |
| `usage` | tokens/custo/modelo quando o provider reportar (opcional) |

`FailureCode` (fechado): `AGENT_ERROR`, `AGENT_TIMEOUT`, `NO_CHANGES`, `SCOPE_VIOLATION`,
`GATE_FAILED`, `REVIEW_FAILED`, `INTEGRATION_CONFLICT`, `WORKSPACE_ERROR`, `INTERRUPTED`,
`POLICY_VIOLATION`, `PROVIDER_UNAVAILABLE`, `PROVIDER_NOT_READY`.

`PROVIDER_UNAVAILABLE` (CLI não encontrada / sem capacidade após espera) e
`PROVIDER_NOT_READY` (CLI presente mas não autenticada) existem separados de `AGENT_ERROR`
porque a ação corretiva é do humano no ambiente, não do agente no código: retentar na mesma
condição só queima tentativa.

### 3.4 Observation

O contraponto factual do `claims`. Produzida pelo control plane após a tentativa.

| Campo | Como é obtido |
| --- | --- |
| `filesChanged` | `git diff --name-status` no workspace da tentativa |
| `diffStat` | linhas +/− por arquivo |
| `diffRef` | patch salvo em artefato, referenciável |
| `outOfScopePaths` | `filesChanged` − `touches` − permitidos |
| `commit` | sha do commit da tentativa |
| `scopeCheck` | `PASS \| VIOLATION` |

### 3.5 Executor e Reviewer

Não são entidades separadas: são **papéis** de `AgentIdentity` dentro de uma Attempt.
Modelar "Executor" como entidade própria criaria tabela sem comportamento. Um mesmo perfil
pode ser executor em uma task e revisor em outra — o que a regra proíbe é ser os dois **na
mesma tentativa**.

`AgentIdentity`: `{ profileId, providerId, model?, sessionRef, startedAt }`.

### 3.6 Review

| Campo | Notas |
| --- | --- |
| `id`, `attemptId` | |
| `reviewer` | `AgentIdentity` |
| `input` | o que foi entregue: contrato da task, diff, resultados de gate, validation |
| `verdict` | `PASS \| FAIL \| ESCALATE` |
| `findings` | `[{ severity, path?, line?, message, evidenceRef? }]` |
| `rationale` | texto curto |
| `durationMs` | |
| `policy` | `ReviewPolicy` efetivamente exigida para esta task |
| `policyOutcome` | `satisfied \| downgraded` + motivo (ver §3.6.1) |

**Invariante:** `reviewer.sessionRef ≠ attempt.executor.sessionRef` e, quando houver perfis
distintos disponíveis, `reviewer.profileId ≠ executor.profileId`.

`ESCALATE` existe para o caso honesto: o revisor identifica ambiguidade arquitetural que não
é falha do executor. Leva a task para `BLOCKED`, não para `FAILED` — o retry não resolveria.

### 3.6.1 ReviewPolicy

```ts
type ReviewPolicy =
  | 'fresh-session'             // revisor com contexto zero (pode ser o mesmo provider)
  | 'cross-provider-preferred'  // tenta outro fornecedor; se não houver, rebaixa e registra
  | 'cross-provider-required'   // outro fornecedor é obrigatório
```

Regra universal, em todas as políticas: `reviewer.identity ≠ executor.identity`.
Em `cross-provider-required` acrescenta-se `reviewer.providerId ≠ executor.providerId`.

**A política é resolvida por configuração, não codificada no domínio.** O domínio recebe uma
`ReviewPolicy` já resolvida por task; ele não sabe que "risco alto" costuma mapear para
`cross-provider-required` — isso é decisão de projeto, sujeita a mudança sem tocar código.
Ordem de resolução (mais específico vence):

```text
task.reviewPolicy  >  mission.defaults.reviewPolicy  >  project.policies.review.byRisk[task.risk]  >  project.policies.review.default
```

**Quando a política não pode ser satisfeita:**

| Política | Sem segundo fornecedor disponível |
| --- | --- |
| `fresh-session` | não se aplica |
| `cross-provider-preferred` | rebaixa para `fresh-session`, grava `policyOutcome: downgraded` e emite `review.policy_downgraded` |
| `cross-provider-required` | task vai para `BLOCKED` (`kind: POLICY`, `reason: CROSS_PROVIDER_UNAVAILABLE`). **Nunca rebaixa em silêncio** |

O compilador avisa antes (`DA2008`) quando a missão exige revisão cruzada e o projeto tem
menos de dois fornecedores aptos a revisar.

### 3.7 Gate e GateExecution

**Gate** (definição, em `.agentic/gates.yaml`): perfil nomeado com lista ordenada de
comandos.

| Campo | Notas |
| --- | --- |
| `id` | ex. `backend`, `web`, `mission` |
| `commands` | `[{ run, cwd?, timeoutMs?, required }]` |
| `env` | allowlist de variáveis repassadas |

**GateExecution** (execução): `{ id, gateId, scope: task|mission, attemptId?, runId,
startedAt, finishedAt, status: PASS|FAIL|ERROR|TIMEOUT, results: CommandResult[] }`.

`CommandResult`: `{ command, cwd, exitCode, durationMs, stdoutRef, stderrRef, truncated }`.

**Responsabilidade:** produzir fato reproduzível. Quem executa é o control plane, nunca o
agente.

### 3.8 Evidence

Evidência não é uma tabela paralela: é a **visão citável** sobre `Observation`,
`GateExecution` e `Review`. Um `EvidenceRef` é `{ kind, sourceId, artifactPath?, digest }`.

Regra: toda transição para `DONE` referencia ao menos um `EvidenceRef` de cada tipo exigido
pelo predicado de conclusão (P06).

### 3.9 Blockage

`{ reason, kind: ARCHITECTURAL|DEPENDENCY|POLICY|ATTEMPTS_EXHAUSTED|EXTERNAL, raisedBy,
raisedAt, needs, resolvedAt?, resolution? }`.

### 3.10 Event

Registro append-only de tudo que aconteceu.

`{ seq, runId, ts, type, actor, taskId?, attemptId?, payload }`

Tipos (namespace estável): `run.*`, `task.*`, `attempt.*`, `gate.*`, `review.*`,
`workspace.*`, `policy.*`, `human.*`.

**Regra de ouro:** toda mutação de estado grava estado **e** evento na mesma transação.

---

## 4. Entidades de infraestrutura (portas do domínio)

O domínio declara as **portas**; os adapters vivem fora e dependem do domínio — nunca o
contrário.

### 4.1 AgentProvider (porta)

```ts
interface AgentProvider {
  readonly id: ProviderId
  capabilities(): ProviderCapabilities        // suporta review? streaming? cancelamento?
  start(assignment: Assignment, ctx: DispatchContext): Promise<AgentHandle>
}

interface AgentHandle {
  readonly ref: string
  status(): AgentRunStatus
  cancel(reason: string): Promise<void>
  result(): Promise<AgentOutcome>             // resolve ao término
  logs(): AsyncIterable<AgentLogEvent>        // persistidos como artefato
}
```

`Assignment` é um contrato fechado (`kind: 'execute' | 'review'`) com objetivo, escopo
permitido, dependências satisfeitas, caminho do workspace, contrato de validação e — no caso
de review — diff e resultados de gate. **O provider não recebe acesso ao banco de estado.**

`AgentOutcome = { status, claims, usage?, logsRef }`. O campo se chama `claims`
deliberadamente: o tipo carrega a semântica de "relato, não fato".

#### ProviderCapabilities

```ts
interface ProviderCapabilities {
  roles: ('executor' | 'reviewer')[]
  streaming: boolean                 // stdout/stderr incremental
  cancellation: boolean
  readinessProbe: 'supported' | 'unsupported'   // dá para saber se está autenticado?
  reportsUsage: boolean              // devolve tokens/custo?
}
```

`readinessProbe: 'unsupported'` é uma resposta legítima e frequente: nem toda CLI expõe
estado de autenticação de forma confiável. Ver `ProviderHealth`.

#### ProviderHealth

```ts
interface ProviderHealth {
  providerId: ProviderId
  installed: boolean | 'unknown'
  ready:     boolean | 'unknown'     // autenticado / apto a executar
  version:   string  | 'unknown'
  detail:    string                  // como foi apurado, ou por que não foi
  probedAt:  Date
  running:   number                  // contabilizado por nós — sempre conhecido
  capacity:  number | null           // maxConcurrent configurado
}
```

**Regra de honestidade:** `unknown` é um valor de primeira classe. Quando a CLI não permite
observar instalação, versão ou autenticação de forma confiável, reportamos `unknown` — nunca
inferimos. Em particular, `--version` respondendo **não** prova que o usuário está
autenticado: isso é `installed: true, ready: unknown`.

`running` e `capacity` são exceção: vêm da nossa própria contabilidade, então são sempre
conhecidos.

### 4.2 WorkspaceProvider (porta)

```ts
interface WorkspaceProvider {
  acquire(lease: WorkspaceLeaseRequest): Promise<Workspace>
  diff(ws: Workspace): Promise<Observation>
  commit(ws: Workspace, message: string): Promise<CommitRef>
  release(ws: Workspace, disposition: 'keep' | 'discard'): Promise<void>
}
```

Adapters: `shared` (uma árvore, exige execução sequencial de escritores) e `git-worktree`
(uma árvore por tentativa, branch `task/<mission>/<taskId>/a<N>`).

`Workspace`: `{ id, kind, path, branch?, baseCommit?, leasedBy: AttemptId }`.

### 4.3 Integrator (porta)

Consolida o resultado aprovado de uma tentativa na branch da missão.
`integrate(attempt): Promise<IntegrationResult>` → `MERGED | CONFLICT | SKIPPED`.
Conflito não é exceção: é `FailureCode.INTEGRATION_CONFLICT`, com retry possível.

### 4.4 RunStore / EventStore (portas de persistência)

`RunStore` expõe operações transacionais de leitura/gravação do estado; `EventStore` é
append-only. A regra "estado + evento na mesma transação" é garantida por uma unidade de
trabalho única (`withTransaction`).

### 4.5 LocalAgentRuntime (porta)

Responsável pelo **ciclo de vida de processos locais de agente**. É o que permite
`subscription-first` (P17): o agente é um programa que o usuário já tem instalado e
autenticado, executado por nós dentro da worktree da tentativa.

```ts
interface LocalAgentRuntime {
  probe(spec: LocalAgentSpec): Promise<ProviderHealth>
  spawn(spec: LocalAgentSpec, opts: SpawnOptions): Promise<LocalAgentProcess>
}

interface LocalAgentSpec {
  providerId: ProviderId
  executable: string                  // nome ou caminho do binário
  args: string[]
  versionArgs?: string[]              // como perguntar a versão
  readinessArgs?: string[]            // como perguntar prontidão, se a CLI permitir
}

interface SpawnOptions {
  cwd: string                         // SEMPRE a worktree da tentativa
  env: Record<string, string>         // allowlist; sem credencial injetada por nós
  timeoutMs: number
  stdin?: string
}

interface LocalAgentProcess {
  readonly handle: string             // id nosso, estável e logável
  readonly pid: number | null         // quando aplicável ao runtime
  readonly cwd: string
  readonly startedAt: Date
  stdout: AsyncIterable<string>
  stderr: AsyncIterable<string>
  exit(): Promise<ExitStatus>         // { code, signal, timedOut, cancelled, durationMs }
  cancel(reason: string): Promise<void>   // encerra a árvore de processos
}
```

**Fronteira deliberada:** este tipo não conhece Mission, Task, Attempt nem estado de run. Ele
sabe iniciar, observar, cancelar e encerrar um processo local. Quem traduz isso em
`AgentOutcome` é o adapter de provider; quem traduz `AgentOutcome` em transição de estado é o
orquestrador. Três responsabilidades, três camadas.

**Evolução prevista pela mesma porta:** runtime em container, runtime remoto. Nenhum deles
altera o domínio.

### 4.6 ProviderRegistry e capacidade

```ts
interface ProviderRegistry {
  get(id: ProviderId): AgentProvider
  list(): ProviderId[]
  health(): Promise<ProviderHealth[]>
  capacity(): CapacitySnapshot
}

interface CapacitySnapshot {
  global:   { maxParallelTasks: number; active: number }
  executor: { max: number; active: number }
  reviewer: { max: number; active: number }
  byProvider: Record<ProviderId, { maxConcurrent: number; running: number }>
}
```

`CapacitySnapshot` é **entrada** do scheduler (função pura). O scheduler não consulta nada:
recebe o retrato e decide. Capacidade de um provider é compartilhada entre execução e
revisão — um `codex` com `maxConcurrent: 2` rodando 1 execução tem 1 vaga, seja para
executar ou revisar.

### 4.7 AgentProfile

`{ id, role: 'executor'|'reviewer', providerId, model?, systemContextRef?, tags: string[] }`.
No MVP bastam `executor` e `reviewer` por provider; o modelo permite `backend-executor`,
`security-reviewer` etc. sem mudança estrutural. O `providerId` vem de configuração — o
domínio nunca contém o nome de uma CLI ou de um fornecedor.

---

## 5. Como o domínio responde à pergunta central

| Pergunta | Onde está a resposta |
| --- | --- |
| O que está sendo desenvolvido? | `MissionSpec.objective` + `TaskSpec.objective` |
| Por quem? | `Attempt.executor` (perfil, provider, modelo, sessão) |
| Por que está executando **agora**? | `Attempt.dispatchReason` + `TaskRun.unblockedBy` |
| Do que depende? | arestas do `CompiledGraph` + `TaskRun.status` das predecessoras |
| O que foi validado? | `GateExecution.results` + `Review.verdict` e `findings` |
| Qual evidência permite considerar concluído? | `EvidenceRef[]` exigidos pelo predicado P06 |
| O que já falhou antes e por quê? | `Attempt[]` anteriores + `failureReason` |
| Quem revisou, e com qual fornecedor? | `Review.reviewer` (inclui `providerId`) + `Review.policy` |
| A política de revisão foi cumprida ou rebaixada? | `Review.policyOutcome` + evento `review.policy_downgraded` |
| Em qual worktree e branch o trabalho aconteceu? | `Attempt.workspace` (`path`, `branch`, `baseCommit`) |
| Qual processo local executou, e por quanto tempo? | `AgentIdentity.runtime` (`handle`, `pid`, `cwd`, `startedAt`) + `ExitStatus` |

Nenhuma dessas respostas depende de ler log de agente.

---

## 6. Decisões de modelagem que recusamos

| Recusado | Motivo |
| --- | --- |
| `status` na MissionSpec | mistura definição com execução; impede reexecução e comparação |
| Executor/Reviewer como entidades | tabelas sem comportamento; são papéis de `AgentIdentity` |
| Evidence como tabela genérica separada | duplicaria dados de gate/review; é visão citável |
| Phase como restrição de ordem | ordem é do DAG; fase é agrupamento (P02) |
| Dependência inferida de texto | viola P02 |
| Estado de task no arquivo YAML | arquivo é definição; estado é do control plane (P10) |
| Mapa risco→política de revisão dentro do domínio | é decisão de projeto; o domínio recebe a política já resolvida |
| `ready: false` quando a CLI não permite saber | mentira operacional; o valor correto é `unknown` |
| Credencial de fornecedor no modelo | autenticação é do CLI local, nunca nossa (P17) |
