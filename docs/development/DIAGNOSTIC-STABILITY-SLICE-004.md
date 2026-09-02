# Diagnóstico — STABILITY-SLICE-004 · SERVICE LIFECYCLE (I15)

> Branch: `fix/STABILITY-SLICE-004`, a partir de `fix/STABILITY-SLICE-003C`
> (`028125fa81d7f321b37d254a37456dfe4ecfe343`). `main` (`797b8e72…`) intocada.
>
> Pergunta da fatia: **depois que o shutdown resolve, existe QUALQUER efeito pertencente ao
> antigo owner ainda capaz de mutar repo, estado ou sistema de arquivos?** A resposta medida
> antes era **sim, em seis lugares**. A decisão está em [ADR-0014](../adr/ADR-0014-ciclo-de-vida-do-servico.md).

---

## A. O lifecycle que existia (derivado do código, confirmado por medição)

### Boot — `startServer`

```text
loadProjectSources · resolveBind                      leitura pura
claimControlPlane           ──▶ BEGIN EXCLUSIVE em control-plane.lock.db      (posse, I14)
createControlPlane          ──▶ openPersistence(readwrite): WAL, migrações   (primeira escrita)
                                lease.onRelease(() => persistence.close())
attachServer                ──▶ app.listen · writeControlPlaneFile             (descoberta)
adoptRecoverableRuns        ──▶ open(runId) · orchestrator.start()            (primeiro EFEITO:
                                                                               timer + tick)
```

### Encerramento — `RunningServer.close` → `shutdownControlPlane`

```text
stopServing      running.close()  ──▶ app.close()               ⚠ pendura com SSE conectado
                                  ──▶ removeControlPlaneFile
stopEffects      plane.close()    ──▶ closed = true
                                  ──▶ orchestrator.abandon()    ⚠ não espera #chain
                                        stop() · #closed = true
                                        cancel() dos handles JÁ registrados
                                        await allSettled(retrato de #jobs)  ⚠ jobs novos escapam
                                  ──▶ persistence.close()        ⚠ com artefato em voo
releaseOwnership lease.release()  ──▶ ganchos · ROLLBACK · close do lock   ⚠ devolve void
```

`SIGINT`/`SIGTERM` na CLI resolviam `waitForShutdown()` e caíam nesse `close`. O binário
`agentic-server` tinha um caminho próprio (mesma ordem, código diferente). `mission start`
usava `withPlane` — cujo `finally` engolia a falha do `close` e soltava a posse **mesmo
assim**.

## B. Efeitos, categorizados

| Efeito | Começa em | Handle? | Cancelável? | Drenável? | Muta FS? | Muta DB? | Sobrevivia ao shutdown? | Quem esperava |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tick (`#chain`) | `start()`, timer, `#requestTick` | não | cooperativo | sim | worktree add | sim | **sim** — `abandon` não esperava a cadeia | ninguém |
| agente executor/revisor | `#dispatchExecutor`/`Reviewer` (dentro do tick) | `AgentHandle` | sim (tree-kill) | sim | worktree | não | **sim, se nasceu durante o close** | `abandon` (só handles já registrados) |
| gate de task / mission gate | `#startTaskGate`/`#startMissionGate` (job) | não | **não** | sim | artefatos | artefatos | não — mas segurava o close pelo timeout do comando | `abandon` (se no retrato) |
| integração | `#startIntegration` (job) | não | não | sim | **branch da missão** | não | resultado **descartado** (D6) | `abandon` (se no retrato) |
| workspace acquire (+ `workspaceSetup`) | dentro do tick | não | **não** | sim | worktree, processo | não | **sim** (tick) | ninguém |
| artefato (`mkdir`/`writeFile`/`INSERT`) | jobs e tick | não | não | sim | sim | sim | **sim** — release entre os dois `await` | ninguém |
| evento/estado (`withTransaction`) | tick | — | atômico | — | não | sim | não | — |
| timers | `start()`, retry, SSE heartbeat, process timeout | sim | sim | — | não | não | não (`stop()`, `unref`) | — |
| SSE | rota `/stream` | socket | sim | — | não | não | **pendurava** `app.close()` | Fastify |
| planning | não existe nesta branch | — | — | — | — | — | — | — |
| filhos do `ProcessRuntime` | provider, gate, setup | provider: sim; gate/setup: não | provider: sim | sim | worktree | não | gate/setup: **sim** | — |

## C. Reprodução (testes vermelhos, commit `7d9559a`)

Todos sobre código de produção, sem agente real, com o ponto de espera controlado:

| Sonda | Medido antes |
| --- | --- |
| B. tick dentro de `provider.start()` (provider com portão) | `plane.close()` resolveu com a cadeia em voo (`cedo: resolveu`); a cadeia seguiu e falhou sobre banco fechado (`errosDeBancoFechado: 1`) |
| C2. processo real nascido durante o close (`LocalCliAgentProvider` + executável falso) | processo **vivo** depois do close; o neto escreveu o marcador (`vivo: true, neto: true`) |
| D. mission gate em voo (comando de 3 s) | close esperou o comando (`rapido: false`); comando concluiu (`comandoConcluiu: true`); nada persistido |
| A. artefato entre `mkdir` e `writeFile` (fs injetável) | `release()` devolveu `undefined` e soltou o lock; outro processo adquiriu; a linha falhou com `database connection is not open` |
| SSE. um cliente no `/stream` | `app.close()` pendurado > 3 s (sonda isolada do Fastify: > 5 s; gancho `onClose` **nunca rodou** antes do fecho do socket) |
| E. integração em voo (`git` de mentira no PATH segurando `rebase`) | `merges: 2, integrando: [T01, T02], feitas: 0` — D6 exato |
| C1. processo com handle conhecido | já passava: `abandon` cancelava e esperava |

## D. O que mudou

- **`Orchestrator.abandon({ graceMs })`** drena: cancela handles, aborta gate/setup por
  `AbortSignal`, espera cadeia **e** jobs (em laço, até estabilizar), colhe integração e
  mission gate, e rejeita com `ShutdownTimeoutError` se o prazo vencer. `#dispatchExecutor`
  e `#dispatchReviewer` cancelam um handle que nasceu depois do close; `#startTaskGate`,
  `#startIntegration` e `#startMissionGate` não iniciam nada quando fechados; o tick verifica
  `#closed` entre fases. Ticks de timer/evento registram a rejeição em `errors`.
- **`ControlPlane.close(options)`**: recusa trabalho novo desde o primeiro instante,
  `settle()` das escritas antes de fechar, `lifecycle` observável, idempotente e
  concorrente; em falha deixa o banco aberto e permite tentar de novo.
- **Persistência**: `FileArtifactStore.pending/settle`; `Persistence.close()` recusa com
  escrita em voo (`WritesInFlightError`); `ControlPlaneLease.release(): boolean`;
  `loadGateExecution` (D12).
- **Processo/gates/workspace**: `RunSpec.signal`, `GateRunRequest.signal` (+ `ABORTED`),
  `AttemptLease.signal`, `MissionWorkspaceRequest.signal`, `runWorkspaceSetup(…, signal)`.
- **Servidor**: `closeStreams(app)` antes de `app.close()`; `shutdownControlPlane(steps,
  options)` com `OwnershipRetainedError`; `createControlPlaneService` (`start`/`stop`/
  `restart`/`status`); `agentic-server` usa o serviço.
- **CLI**: `serve` usa o serviço (SIGINT/SIGTERM → `stop()`); `mission start` encerra por
  `shutdownControlPlane` e reporta `SHUTDOWN_INCOMPLETE` em vez de soltar a posse com efeito
  vivo.

## E. Medido depois

| Sonda | Depois |
| --- | --- |
| B | `close` pendente até a cadeia terminar; nenhum commit, artefato ou erro de banco fechado; tentativa `RUNNING` para o próximo dono |
| C2 | processo cancelado (tree-kill) assim que `start()` devolve; neto nunca escreve |
| D | `close` < 2 s; gate morto; nada persistido; `reopen` refaz o gate e conclui com **uma** execução |
| A | `release()` → `false` com escrita em voo; outro processo **não** adquire; a escrita termina inteira; `release()` seguinte → `true` |
| SSE | `close` em ~150 ms com o dashboard conectado |
| E | `integrando: []`; cada merge na branch é uma task `DONE`; o próximo dono **não** refaz T01/T02 |
| D12 | queda entre gravar a `GateExecution` e concluir o run → o próximo dono conclui com a **mesma** execução |
| serviço | start idempotente e concorrente; stop idempotente e concorrente; restart troca de dono; projetos independentes; `stop` que falha → `FAILED` com posse retida e `start` recusado; `stop` seguinte devolve |
| entre processos | SIGINT/SIGTERM com run `RUNNING`: A drena, posse livre, descoberta removida, B adota, tentativa antiga `INTERRUPTED`, run anda. SIGKILL: B adota e reconcilia. Mission gate que ignora SIGTERM: a posse só fica livre **depois** de `close` de A resolver (≥ 1,5 s depois do sinal), gate morto, nada persistido, B conclui com uma execução. Fase 21 (SIGKILL com gate em voo): B refaz do zero, uma execução; o gate órfão de A termina sozinho |

## F. Problemas registrados, não corrigidos

| | Descrição |
| --- | --- |
| **D6 (parcial)** | Recovery de `INTEGRATING` está fechado para o encerramento **gracioso** (o resultado é colhido). Para `SIGKILL` no meio de um rebase, o próximo dono ainda reconcilia a task como `INTERRUPTED` e pode refazer trabalho já integrado — exige marcador durável de integração, fora desta fatia |
| **D13** *(novo)* | Sob `SIGKILL`, um comando de gate ou `workspaceSetup` iniciado pelo dono morto fica órfão até terminar sozinho. Não alcança o banco e não rouba a worktree da missão (prova de posse), mas existe. Fechar exige um supervisor de processos ou `prctl(PR_SET_PDEATHSIG)`-equivalente portátil |
| **D5, D7, D8, D9, D10, D11** | inalterados (ver DIAGNOSTIC-STABILITY-SLICE-003) |
