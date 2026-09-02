# Diagnóstico — STABILITY-SLICE-004B · CANCELLATION CONTRACT & PROCESS GROUP SETTLEMENT

> Branch: `fix/STABILITY-SLICE-004B`, a partir de `fix/STABILITY-SLICE-004`
> (`38c6c2ddf58f74ba5e8ea2145eba0b533e42e8c9`). `main` (`797b8e72…`) intocada.
>
> Decisão humana que abriu a fatia: **não** reverter a 004 (B2, B3, B4 e a parte correta de B1
> ficam); **não** abrir um quarto ciclo dentro da 004. Os achados restantes da revisão de
> confirmação viram esta micro-slice, congelada em **quatro** propriedades: C1, C2, C3 e
> B1-final. Nada além disso. A decisão está no adendo 004B de
> [ADR-0014](../adr/ADR-0014-ciclo-de-vida-do-servico.md).

---

## A. O contrato que existia (derivado do código, na cabeça `38c6c2d`)

```text
ManagedProcess.cancel(reason)   pede (SIGTERM→SIGKILL), espera exit(), sonda o grupo;
                                resolve so com o grupo morto; REJEITA ProcessGroupAliveError
ManagedProcess.exit()           resolve no assentamento; ExitStatus.groupTerminated
AbortSignal 'abort'             void this.cancel(...)              ⚠ rejeicao sem dono (C1)
timeout                         void this.#terminate()             ok (nunca rejeita)
LocalProcess.exit()             repassa ExitStatus (com groupTerminated)
LocalCliAgentHandle.#settle     ExitStatus -> AgentOutcome         ⚠ groupTerminated DESCARTADO (B1)
Orchestrator.#afterExecutor     handle.result() -> observeAttempt  ⚠ mede worktree em movimento (B1)
Orchestrator.cancel/cancelTask  handle.cancel().catch(() => undefined) -> CANCELLED   ⚠ (C2)
Orchestrator.#residual          Set<string>; abandon(): #residual.clear() no inicio  ⚠ (C3)
Orchestrator.#abandon           cancela handles em voo (re-sonda so por acidente);
                                gate/setup: residualProcess: boolean, sem pgid -> nao re-sondavel
```

Três lugares onde a mesma verdade — "sinal enviado não é processo morto" — chegava e parava.

## B. Reprodução (testes vermelhos) e fecho

Todos sobre código de produção, sem agente real. Um grupo que sobrevive a SIGKILL não se
fabrica de forma portável: a **sonda** (`probeGroup`) é injetada — e é a MESMA sonda para o
runtime do executável falso, o gate runner, o `workspaceSetup` e a re-sonda do orquestrador.
`mata()` é a prova de morte chegando para todos.

| # | Propriedade | Antes (vermelho medido) | Depois |
| --- | --- | --- | --- |
| **C1** | abort por `AbortSignal` com grupo vivo → zero `unhandledRejection`; `exit()` relata `groupTerminated=false`; `cancel()` depois ainda rejeita | `unhandledRejection` com `ProcessGroupAliveError { pgid: -514682, graceMs: 150 }` capturada pelo listener do teste (`process/cancel-contract.test.ts`) | listener de abort usa o pedido interno (`#requestCancel` + `#terminate`, nunca rejeitam); o fato sai por `exit()`; `cancel()` posterior sonda e rejeita; zero órfãs |
| **C2** | `cancel run` com grupo vivo → comando recusado, nada vira `CANCELLED`; após a prova, o mesmo comando assenta | `stopRun` resolveu: run `CANCELLED`, task `CANCELLED`, `attempt.result: CANCELLED`, eventos `run.cancelled`/`task.cancelled`/`attempt.cancelled` gravados — com o grupo vivo (`orchestrator/cancellation-contract.test.ts`) | `CANCELLATION_UNSETTLED` (HTTP 409); run/task `RUNNING`, tentativa aberta, nenhum evento; `mata()` → mesmo comando → `CANCELLED` |
| **C2** | `cancel run` recusado + `close` → posse retida; outro processo não adquire; tentativa `RUNNING` para o próximo dono | `close` resolvia (idem acima) | `ShutdownTimeoutError` com `residualProcesses: ['tentativa T01-a1-…']`; lease retido; `acquire` de outro → recusado; `mata()` → `close` resolve; task `RUNNING` no banco |
| **C2** | `cancel task` com grupo vivo → recusado, **intenção mantida** (nenhum redespacho), assenta após a prova | `cancelTask` resolveu com task `CANCELLED` | recusado; o desfecho do agente que chega depois **não** reprova/redespacha (task `RUNNING`, 1 tentativa, 1 em voo); `mata()` → `cancelTask` → `CANCELLED`, 0 em voo |
| **C3** | gate cujo grupo sobrevive: `stop #1` e `stop #2` recusam com o **mesmo** resíduo (re-sondado); `stop #3`, após a prova, libera | `close #1` **resolveu** (o resíduo do gate nem chegava a segurar: `residualProcess` sem pgid, e `#residual.clear()` na entrada) | `#1` e `#2` rejeitam com `gate T01-a1-… (pgid N)`; contagem de sondas cresce entre `#1` e `#2`; lease retido; `mata()` → `#3` resolve |
| **C3** | `workspaceSetup` cujo grupo sobrevive: idem | a sonda nem chegava ao setup (provider não repassava `SetupProcessDeps`): task foi a `RUNNING` | task fica `READY` (worktree não entregue sem prova); `#1` e `#2` rejeitam com `workspaceSetup T01-a1-…`; `#3` resolve após a prova |
| **B1-final** | agente sai `exit 0` **sozinho** + descendente vivo → tentativa **não** assenta (não vira `DONE`, worktree não medida), resíduo com o orquestrador, posse só sai com a prova | task `DONE`; worktree medida e commitada com o grupo vivo; `close` resolvia | `attempt.result: ERROR`, `failureReason.detail` cita o grupo, `observation` ausente, nenhum `attempt.observed`; `close #1` rejeita com `tentativa …`; `mata()` → `close` resolve |
| adapter | `ExitStatus → AgentOutcome` preserva `groupTerminated` em saída natural, cancel e timeout (`providers/group-settlement.test.ts`, 6 casos) | `groupTerminated: undefined` nos 5 casos de CLI local e no mock | CLI local repassa `exit.groupTerminated`; mock declara `true` |
| gates | `GateCommandRecord.pid` + `residualProcess` com sonda injetada (`gates/residual.test.ts`, 3 casos) | `pid: undefined` | `pid` do líder em todo comando que rodou; `null` no recusado |
| setup | `WorkspaceError.residualGroup` (`workspace/setup.test.ts`) | `residualGroupOf` não existia | pid do shell no erro |
| runtime | `exit()` do agent-runtime preserva `groupTerminated` | já passava em tempo de execução; a **porta do domínio** não carregava o campo (só typecheck) | campo obrigatório em `ExitStatus` e `AgentOutcome` do domínio |
| serviço | `stop()` que falha duas vezes continua `FAILED` com a posse retida; a terceira devolve | já passava (`running` era mantido) — regressão de confirmação | idem |

Vermelho medido antes da produção: **20** falhas comportamentais (process 4, providers 6,
gates 3, workspace 1, orquestrador 6) mais 2 falhas por defeito do próprio teste (os casos
SIGKILL cancelavam antes de o líder instalar o tratador; corrigidos com `pronto`), e 4
controles verdes (grupo morto com sonda real: cancel, saída natural, abort, agente in-process).

## C. Contrato final (o que o código promete agora)

- **`cancel(reason)`** — pede e **espera o assentamento**. Resolve só com o grupo confirmado
  morto. Rejeita `ProcessGroupAliveError` (`PROCESS_GROUP_ALIVE`) se o grupo existir depois
  de `groupGraceMs`. Chamado de novo — inclusive depois de o líder sair sozinho — **sonda
  outra vez**; provada a morte, resolve e `exit()` passa a dizer `groupTerminated: true`.
- **`exit()`** — resolve quando o líder assentou **e** a confirmação do grupo terminou (por
  prova ou por teto). Nunca rejeita. `ExitStatus`: `code`, `signal`, `timedOut`, `cancelled`,
  **`groupTerminated`**, **`pid`**, `durationMs`; vale para cancel, abort, timeout, sinal e
  saída natural.
- **`AbortSignal` / timeout** — pedido sem quem espere: `#requestCancel` + `#terminate`, que
  não rejeitam; o desfecho sai por `exit()`. Nenhuma rejeição órfã no runtime.
- **`AgentOutcome.groupTerminated`** (domínio, obrigatório) — o adapter não pode omitir nem
  inferir. `false` no orquestrador: tentativa reprova (`AGENT_ERROR`, detalhe explícito) **sem**
  medir a worktree; o handle vira resíduo; árvore compartilhada não recebe despacho novo até
  a prova.
- **`abandon()` / `close()` / `stop()`** — cada resíduo carrega a própria sonda (`cancel()`
  do handle; `confirmProcessGroupGone(pid)` para gate/setup) e é **re-sondado** a cada
  tentativa; só sai da lista com a prova. Rejeitam enquanto houver um. Um handle em voo é
  cancelado uma vez por tentativa (o `cancel` já é a sonda dele).
- **`cancel run` / `cancel task`** — `CANCELLED` só com **todo** grupo relevante provado morto
  (tentativas em voo + resíduos: do run inteiro, ou da task). Senão `CancellationUnsettledError`
  (`CANCELLATION_UNSETTLED`, 409), estado intocado, nenhum evento, comando repetível. Intenção
  preservada: `#closed` no run; `cancelRequested` na tentativa (o próximo desfecho dela sonda
  de novo e cumpre, ou espera).

## D. O que mudou

- **`process`**: `ExitStatus.pid`; `GroupProbeDeps` (`platform`, `groupGraceMs`,
  `probeGroup`) como base de `RuntimeDeps`; `isProcessGroupAlive`, `confirmProcessGroupGone`
  exportados; `#requestCancel`; listener de abort sem `cancel()` público.
- **`domain`**: `ExitStatus.groupTerminated` e `AgentOutcome.groupTerminated` obrigatórios.
- **`providers`**: `LocalCliAgentHandle` repassa `groupTerminated`; mock declara `true`.
- **`gates`**: `GateCommandRecord.pid`.
- **`workspace`**: `WorkspaceError.residualGroup` + `residualGroupOf`; `ShellOutcome.pid`;
  `setupProcessDeps` na config dos dois providers, repassado a `runWorkspaceSetup`.
- **`orchestrator`**: `#residual: Map<string, ResidualEffect>` (`taskId?`, `handle?`,
  `settled()`); `#rememberHandle`/`#rememberGroup`/`#forgetHandle`/`#reprobeResidual`/
  `#settleCancellation`; `abandon` re-sonda; `cancel`/`cancelTask` recusam sem prova
  (`CancellationUnsettledError`); `Inflight.cancelRequested` + `#settleRequestedCancel`;
  `#afterExecutor`/`#afterReviewer` reprovam sem medir quando `groupTerminated=false`; guarda
  de árvore compartilhada; `GateOutcome.residualGroups` (pids) no lugar de `residualProcess`;
  `EngineDeps.processProbe` e `ControlPlaneConfig.processProbe` (uma sonda para gate runner,
  workspace providers e orquestrador).
- **`server`**: `CANCELLATION_UNSETTLED → 409` explícito.
- **Fronteiras**: `orchestrator → process` permitido (uma função; ver ADR-0014).
- **Fixtures**: `createFakeCli(script, { processDeps })`; `HarnessOptions.processProbe`;
  `ProjectFixture.workspaceSetup`.

## E. Testes por propriedade (os 14 pedidos)

| # | Propriedade | Onde |
| --- | --- | --- |
| 1 | cancel awaited + grupo morto | `process/cancel-contract.test.ts` |
| 2 | cancel awaited + grupo vivo → rejeita; re-sonda resolve; `exit()` vira `true` | idem |
| 3 | cancel destacado (abort) + rejeição | idem (C1) |
| 4 | zero `unhandledRejection` | idem (C1, timeout, abort com grupo morto) |
| 5 | human cancel + grupo vivo (run, run+close, task) | `orchestrator/cancellation-contract.test.ts` |
| 6 | human cancel + grupo morto | idem (controle) + `commands.test.ts` (mock) |
| 7 | stop retry + resíduo vivo | idem (C3 gate, C3 setup: `#1` e `#2` recusam) + `server/service.test.ts` |
| 8 | stop retry + resíduo morre | idem (`#3` libera) |
| 9 | saída natural + descendente vivo | `process` (pid, `false`), `agent-runtime`, `providers`, `orchestrator` (B1-final) |
| 10 | saída natural + grupo terminado | `process`, `providers`, `orchestrator` (controle → `DONE`) |
| 11 | timeout | `process` (grupo vivo), `providers` (grupo vivo) |
| 12 | SIGTERM | `process` (grupo vivo e sonda real) |
| 13 | SIGKILL | `process` (grupo vivo e sonda real) |
| 14 | resíduo de gate/setup não some entre retries | `orchestrator` C3 ×2; `gates/residual.test.ts` (pid); `workspace/setup.test.ts` (`residualGroup`) |

Os testes existentes de B1 (`shutdown-drain.test.ts`, handle falso) continuam verdes e o
contador de `cancel` continua exatamente 2: um handle em voo é sondado **uma** vez por `close`.

## F. Gates

Suítes direcionadas (process, agent-runtime, providers, orchestrator, workspace, gates,
server, cli), antes da mudança de produção (congelamento): **116 arquivos, 1320 testes, PASS**.
Depois: ver seção H.

## G. D14

Ver seção H (três execuções completas de E2E, números exatos).

## H. Números finais (cabeça da correção, Node v22.23.1)

| Gate | Resultado |
| --- | --- |
| suítes direcionadas (process, agent-runtime, providers, orchestrator, workspace, gates, server, cli) | **120 arquivos, 1351 testes, PASS** (antes da produção: 116/1320 PASS; vermelho medido: 20) |
| `npm run build` | PASS |
| `npm run verify` (lint + fronteiras + typecheck + test) | PASS — **191 arquivos, 2286 testes** |
| `npm run test:e2e` ×3 | **3 de 3** PASS — 98 passaram, 4 pulados (`smoke-real`, sem CLI real) em cada execução; **D14 não recorreu**, nenhum órfão |
| `npm run test:browser` | PASS — 10 de 10 (Chromium) |

D14: três execuções completas consecutivas sem a intermitência de `control-plane-ownership`.
Continua registrado como dívida da suíte (harness), não como defeito de produto.

## I. Windows

O contrato (`cancel()`/`exit()`/`AgentOutcome.groupTerminated`) é portável: em Windows não há
grupo a sondar, `groupTerminated` é `true` por definição e a re-sonda por pid resolve
verdadeiro (`confirmProcessGroupGone` retorna cedo em `win32`). O comportamento específico
não pôde ser testado neste ambiente; não há PASS inventado — fica registrado em ADR-0014.

## J. Registrados, não corrigidos (fora do escopo congelado)

| | Descrição |
| --- | --- |
| **pid reaproveitado** | a re-sonda por pid pode ler "vivo" para um grupo novo com o mesmo id; conservador (retém a posse até o próximo `stop`), nunca o inverso |
| **cancel task durante gate/integração** | sem handle de agente não há grupo a provar no comando; um gate em voo da task cancelada continua até o fim (comportamento anterior, inalterado) |
| **intenção após `SIGKILL`** | um `cancel run` recusado é intenção **em memória** (`#closed`); se o processo cair, o próximo dono reconcilia a tentativa como `INTERRUPTED` e o run segue `RUNNING`. Persistir a intenção exigiria estado novo — fora desta fatia |
| **D6 parcial, D13, D14** | inalterados (ver DIAGNOSTIC-STABILITY-SLICE-004) |
