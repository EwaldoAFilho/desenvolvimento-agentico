# STATE MACHINES — Task e Run

> Normativo. Transição não listada aqui é **erro de sistema**: lança exceção, registra
> `policy.invalid_transition` e não altera estado (P11).

## 1. Task

### 1.1 Estados

| Estado | Significado | Quem é o dono |
| --- | --- | --- |
| `PENDING` | declarada, dependências ainda não satisfeitas | orquestrador |
| `READY` | dependências satisfeitas, aguardando capacidade/lock | scheduler |
| `RUNNING` | agente executor trabalhando no workspace | provider (execução) |
| `VERIFYING` | control plane apurando fatos: diff, escopo e task gate | control plane |
| `REVIEW` | revisor independente avaliando evidência | provider (revisão) |
| `INTEGRATING` | consolidando o resultado aprovado na branch da missão | integrator |
| `DONE` | predicado de conclusão (P06) satisfeito | terminal |
| `FAILED` | tentativa reprovada; decisão de retry pendente | orquestrador |
| `RETRY` | reprovada e reescalonada; aguardando backoff | orquestrador |
| `BLOCKED` | precisa de decisão humana; **nunca fica fingindo executar** | humano |
| `SKIPPED` | dispensada por decisão humana explícita | terminal |
| `CANCELLED` | interrompida por cancelamento do run ou da task | terminal |

`VERIFYING` e `INTEGRATING` não são ornamento: são atividades do control plane com duração,
falha e evidência próprias. Sem elas, "por que a task está há 4 minutos parada?" não tem
resposta — e `GATE_FAILED` ficaria indistinguível de `REVIEW_FAILED` na observabilidade.

### 1.2 Diagrama

```text
                         ┌──────────┐
                         │ PENDING  │◄──────────────┐ (unblock com deps pendentes)
                         └────┬─────┘               │
              deps satisfeitas│                     │
                         ┌────▼─────┐               │
              ┌─────────►│  READY   │               │
              │          └────┬─────┘               │
              │  dispatch:    │ slot + lock + workspace
              │  deps OK      │                     │
              │          ┌────▼─────┐               │
              │          │ RUNNING  │               │
              │          └────┬─────┘               │
              │               │ agente terminou     │
              │          ┌────▼──────┐              │
              │          │ VERIFYING │──scope/gate FAIL──┐
              │          └────┬──────┘              │    │
              │      gate PASS │                    │    │
              │        ┌───────┴────────┐           │    │
              │        │ requireReview? │           │    │
              │      sim│              não│         │    │
              │    ┌────▼─────┐      ┌────▼──────┐  │    │
              │    │  REVIEW  │─PASS►│INTEGRATING│  │    │
              │    └────┬─────┘      └────┬──────┘  │    │
              │    FAIL │  ESCALATE       │ merged  │    │
              │         │      │     ┌────▼─────┐   │    │
              │         │      │     │   DONE   │   │    │
              │         │      │     └──────────┘   │    │
              │         │      │  conflito ─────────┼───►│
              │         │      │                    │    │
              │         └──────┼────────────────────┼────▼
              │                │              ┌──────────┐
              │                │              │  FAILED  │
              │                │              └────┬─────┘
              │                │      attempts<max │ │ attempts esgotadas
              │           ┌────▼─────┐        ┌────▼┐│
              └───────────│  RETRY   │◄───────┘     ▼
                 backoff  └──────────┘         ┌──────────┐
                                               │ BLOCKED  │◄── humano / dependência falhou
                                               └────┬─────┘
                                     humano: unblock│ skip │ cancel
                                                    ▼      ▼
                                              READY   SKIPPED / CANCELLED
```

### 1.3 Tabela de transições

| # | De | Para | Gatilho | Guarda |
| --- | --- | --- | --- | --- |
| 1 | — | `PENDING` | criação do run | — |
| 2 | `PENDING` | `READY` | conclusão de dependência | todas as deps em `DONE` ou `SKIPPED` |
| 3 | `PENDING` | `BLOCKED` | dependência terminou em `FAILED`/`CANCELLED`, ou bloqueio humano | — |
| 4 | `READY` | `RUNNING` | despacho do scheduler | slot global e de executor livres ∧ **provider com `maxConcurrent` disponível** ∧ locks de `touches` adquiridos ∧ workspace obtido ∧ run `RUNNING` |
| 5 | `RUNNING` | `VERIFYING` | agente encerrou com `status=completed` | — |
| 6 | `RUNNING` | `FAILED` | erro, timeout, ausência de alterações, `SCOPE_VIOLATION` | — |
| 7 | `VERIFYING` | `REVIEW` | task gate `PASS` | `requireReview = true` ∧ existe revisor que satisfaça a `ReviewPolicy` resolvida (identidade ≠ executor; **fornecedor ≠ executor** se `cross-provider-required`) ∧ slot de revisor e capacidade do provider disponíveis |
| 8 | `VERIFYING` | `INTEGRATING` | task gate `PASS` | `requireReview = false` |
| 9 | `VERIFYING` | `FAILED` | task gate `FAIL`/`ERROR`/`TIMEOUT` | — |
| 10 | `REVIEW` | `INTEGRATING` | veredito `PASS` | `reviewer ≠ executor` ∧ `ReviewPolicy` satisfeita ou rebaixamento registrado (só em `cross-provider-preferred`) |
| 11 | `REVIEW` | `FAILED` | veredito `FAIL` | — |
| 12 | `REVIEW` | `BLOCKED` | veredito `ESCALATE` | — |
| 12b | `VERIFYING` | `BLOCKED` | `cross-provider-required` sem segundo fornecedor apto | `kind: POLICY`, `reason: CROSS_PROVIDER_UNAVAILABLE`. **Nunca rebaixa em silêncio** |
| 13 | `INTEGRATING` | `DONE` | merge concluído | predicado P06 satisfeito |
| 14 | `INTEGRATING` | `FAILED` | `INTEGRATION_CONFLICT` | — |
| 15 | `FAILED` | `RETRY` | política de retry | `attemptCount < maxAttempts` ∧ falha retentável ∧ run não pausado |
| 16 | `FAILED` | `BLOCKED` | tentativas esgotadas ou falha não retentável | — |
| 17 | `RETRY` | `READY` | backoff cumprido | deps ainda satisfeitas |
| 18 | `BLOCKED` | `READY` | `agentic task unblock` | deps satisfeitas; exige `--note` |
| 19 | `BLOCKED` | `PENDING` | `agentic task unblock` | deps **não** satisfeitas |
| 20 | `BLOCKED` | `SKIPPED` | `agentic task skip --reason` | — |
| 21 | qualquer não terminal | `CANCELLED` | cancelamento do run ou da task | tentativa em voo é cancelada no provider |
| 22 | `PENDING`/`READY`/`BLOCKED` | `SKIPPED` | decisão humana | — |
| 23 | `DONE` | `READY` | `agentic task reopen --reason` (operação humana formal) | nenhum dependente saiu de `PENDING`/`READY`/`BLOCKED` |

**Sobre a transição 23:** `DONE → RUNNING` não acontece "sozinho". Reabrir é operação
nomeada, auditada, e proibida se algum dependente já consumiu o resultado — nesse caso a
resposta correta é uma nova task ou uma nova missão, não reescrever a história.

**Falha retentável:** `AGENT_ERROR`, `AGENT_TIMEOUT`, `GATE_FAILED`, `REVIEW_FAILED`,
`INTEGRATION_CONFLICT`, `INTERRUPTED`, `NO_CHANGES`.
**Não retentável:** `SCOPE_VIOLATION` reincidente na mesma task (2ª ocorrência),
`POLICY_VIOLATION`, `WORKSPACE_ERROR` persistente, `PROVIDER_UNAVAILABLE` e
`PROVIDER_NOT_READY`. Vão direto para `BLOCKED` — repetir uma tentativa que violou fronteira
é desperdício com risco, e insistir contra uma CLI ausente ou não autenticada só queima
tentativa: a correção é do humano no ambiente.

**Falha de provider não consome tentativa útil.** `PROVIDER_UNAVAILABLE` e
`PROVIDER_NOT_READY` são registrados como tentativa (histórico é imutável, I5/P12) mas **não
incrementam `attemptCount`** — nada do trabalho foi julgado. Ausência **temporária** de
capacidade não é falha: a task simplesmente permanece em `READY` até haver vaga.

### 1.4 Reconciliação após queda do control plane

Ao iniciar, o orquestrador varre tentativas em `RUNNING`/`REVIEW` cujo handle de provider
não existe mais: encerra a tentativa com `INTERRUPTED`, aplica a transição 6/15 e libera
locks e workspaces órfãos. Nada é presumido concluído.

---

## 2. Run (execução da missão)

### 2.1 Estados

| Estado | Significado |
| --- | --- |
| `DRAFT` | spec existe; ainda não compilada sem erros ou não aprovada |
| `APPROVED` | compilada sem `ERROR` + aprovação humana registrada — pronta para iniciar |
| `RUNNING` | orquestração ativa |
| `PAUSED` | pausada por humano; nada novo é despachado, tentativas em voo terminam |
| `BLOCKED` | **derivado**: nenhuma task pode progredir e há ao menos uma `BLOCKED` |
| `VERIFYING` | todas as tasks encerradas; mission gate em execução |
| `COMPLETED` | mission gate `PASS` e predicado da missão satisfeito |
| `FAILED` | mission gate `FAIL`, ou encerrado com tasks reprovadas sem saída |
| `CANCELLED` | cancelado por humano |

O documento fundador propunha `APPROVED` **e** `READY`. Foram unificados: não existe
condição observável que distinga os dois — "aprovada" já significa "pronta para iniciar".
Estado sem transição própria é ornamento (P16).

### 2.2 Diagrama

```text
DRAFT ──compile OK + aprovação humana──► APPROVED ──start──► RUNNING ⇄ PAUSED
                                                                │
                                    ┌───────────────────────────┼──────────────┐
                                    │                           │              │
                              deadlock                    todas encerradas   cancel
                                    ▼                           ▼              ▼
                                 BLOCKED ──unblock──► RUNNING  VERIFYING   CANCELLED
                                                                │
                                                       ┌────────┴────────┐
                                                    PASS               FAIL
                                                       ▼                 ▼
                                                  COMPLETED           FAILED
```

### 2.3 Guardas relevantes

- `APPROVED`: `CompiledGraph.diagnostics` sem severidade `ERROR` **e** registro de aprovação
  (`human.mission_approved`, com autor e timestamp). A aprovação pode vir da CLI **ou** do
  dashboard — os dois são atos humanos e gravam o mesmo evento com `actor`; o que não existe
  é aprovação automática.
- `APPROVED → RUNNING` (**START MISSION**): disparada por CLI ou dashboard. Se houver
  diagnóstico `WARNING`, exige aceite explícito (`--accept-warnings` / confirmação na UI),
  registrado no evento `run.started`.
- `BLOCKED` (derivado a cada tick): `∄ task ∈ {READY, RUNNING, VERIFYING, REVIEW,
  INTEGRATING, RETRY}` ∧ `∃ task ∈ {BLOCKED}`.
- `VERIFYING`: `∀ task: status ∈ {DONE, SKIPPED, CANCELLED}` ∧ `∃ task: status = DONE`.
- `COMPLETED`: `∀ task: status ∈ {DONE, SKIPPED}` ∧ mission gate `PASS` ∧ branch da missão
  consolidada. Uma task `CANCELLED` impede `COMPLETED` — o run termina `FAILED` com razão
  explícita. Concluir uma entrega com pedaço cancelado seria mentir no relatório.

---

## 3. Invariantes globais

| ID | Invariante |
| --- | --- |
| I1 | Toda mutação de estado grava estado **e** evento na mesma transação |
| I2 | Duas tasks em `RUNNING` simultâneo nunca têm `touches` sobrepostos |
| I3 | `review.reviewer ≠ attempt.executor` sempre que `requireReview = true` |
| I4 | `attemptCount ≤ maxAttempts` |
| I5 | Tentativa encerrada nunca é alterada (append-only) |
| I6 | Task só chega a `DONE` com `EvidenceRef` de escopo, gate (se houver) e review (se exigida) |
| I7 | O orquestrador é o único escritor do estado do run |
| I8 | Nenhuma task em `RUNNING` sem workspace lease válido |
| I9 | Nenhum despacho excede `maxConcurrent` do provider escolhido |
| I10 | `cross-provider-required` nunca é rebaixada; `cross-provider-preferred` só rebaixa com `policyOutcome: downgraded` e evento correspondente |
| I11 | Todo processo de agente é iniciado com `cwd` na worktree da tentativa |
