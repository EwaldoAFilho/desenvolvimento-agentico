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

## F. Revisão independente — ciclo 1 (Codex, somente leitura)

Veredito inicial: **FAIL**, com dois BLOCKER e três MAJOR. Todos reais, todos fechados no
mesmo ciclo, cada um com prova:

| Achado | Onde estava | Fecho | Prova |
| --- | --- | --- | --- |
| **BLOCKER** — descendente que ignora SIGTERM sobrevive a `cancel()`: o runtime só escalava a SIGKILL se o *líder* não tivesse assentado, e o líder assenta pelo `close` dos pipes mesmo com um neto vivo em `stdio: ignore` | `packages/process/src/runtime.ts` `#terminate` | depois de o líder sair, o resto do grupo recebe SIGKILL (`-pid`, nunca `pid`); `workspaceSetup` derruba a árvore e espera o `close` (teto de 2 s) antes de responder | `tree-kill.test.ts`: líder sai no SIGTERM, neto ignora — grupo morto, marcador nunca escrito; `setup.test.ts`: o pid do comando está morto quando a recusa chega |
| **BLOCKER** — `mission start` só assinava SIGINT/SIGTERM quando o run pausava; com agente, gate ou setup em voo o Node matava o processo, o SO soltava a posse e o efeito continuava | `apps/cli/src/foreground.ts` | o supervisor assina desde o início e corre o sinal contra o `drain`; ao vencer, para o loop e devolve ao `shutdownControlPlane` | `foreground-signal.test.ts` (e2e, CLI real, processo separado): SIGINT e SIGTERM com `workspaceSetup` em voo — CLI termina, setup morto, posse livre, nenhuma task `RUNNING` |
| **MAJOR** — requisição HTTP em voo ainda chegava a `createRun`/`approveMission` durante `app.close()`, antes de o plane recusar | `apps/server/src/ownership.ts` | passo 0, `stopAccepting` → `plane.quiesce()` antes de `stopServing` | `ownership.test.ts` (ordem `aceitar, servidor, efeitos, posse`); `shutdown-drain.test.ts` (`quiesce` recusa `open`/`startRun`, leitura segue, `close` termina) |
| **MAJOR** — falha ao gravar a integração colhida era engolida por `#guard`: merge na branch, task `INTEGRATING` no banco, posse devolvida | `Orchestrator.#collect` | uma mensagem por vez, sem `#guard`; falha propaga, a mensagem fica na caixa, `close` rejeita, posse retida, o próximo `close` grava | `integration-in-flight.test.ts`: `saveTaskRun(DONE)` falha uma vez — `close` rejeita, lease retido, outro processo não adquire, o `close` seguinte grava `DONE` |
| **MAJOR** — colher a última integração levava o run a `VERIFYING` sem gate em voo nem resultado (I12) | `Orchestrator.#collect` | `#derive` só roda no collect quando o run já está em `VERIFYING`; `RUNNING` com todas as tasks `DONE` fica assim para o próximo dono derivar | `integration-in-flight.test.ts`: task `DONE`, run `RUNNING` depois do close; o próximo dono deriva, o mission gate roda uma vez, T01 não é refeita |
| MINOR — `graceMs` não cobria os `cancel()` nem a colheita | `Orchestrator.#abandon` | cancelamentos em paralelo sob `withDeadline`; colheita sob `withDeadline`; vencer o prazo é `ShutdownTimeoutError` | `shutdown-drain.test.ts` continua verde; a semântica do timeout está em ADR-0014 |
| NOTA — colheita grava artefato e descarta worktree | — | documentado: são efeitos aguardados dentro da cadeia, não trabalho novo | — |

Limite novo registrado (Windows): o abort do `workspaceSetup` mata só o shell, e o SIGKILL ao
grupo remanescente é POSIX (ADR-0014).

### Ciclo 2

Veredito: **FAIL** de novo — dois BLOCKER e três MAJOR, todos reais, todos fechados:

| Achado | Fecho | Prova |
| --- | --- | --- |
| **BLOCKER** — descendente cujo líder já terminou **normalmente** ficava fora do alcance (o SIGKILL ao grupo só acontecia dentro do cancelamento) | o grupo termina com o líder em **toda** saída: `#settle` do runtime e o `close` do shell de setup matam o resto do grupo | `tree-kill.test.ts`: pai sai sozinho aos 200 ms, neto em `stdio: ignore` escreveria aos 1,5 s — nunca escreve; `setup.test.ts`: daemon deixado por comando de setup morre com ele |
| **BLOCKER** — `agentic-server` respondia a um `stop` que falhou com `process.exit(1)`, soltando o lock pelo SO com o efeito vivo | nenhum entrypoint sai com a posse retida: `agentic-server`, `agentic serve` e `mission start` dizem o que houve e esperam o **próximo sinal** para tentar de novo | `init.test.ts` (serve) e `mission-start-serve.test.ts`: `close` falha uma vez, o comando espera o segundo sinal, encerra e devolve `ok`; nunca termina com a posse retida |
| **MAJOR** — `serve` e `agentic-server` assinavam os sinais depois do boot/adoção | assinados antes de `start()`; sinal durante o boot é atendido logo depois pelo mesmo `stop` | `init.test.ts`: ordem `sinal-assinado, boot-comecou, boot-terminou, close` |
| **MAJOR** — o adaptador da worktree do mission gate descartava `signal` | passa `signal` a `acquireMissionWorkspace` | typecheck; caminho coberto por `service-lifecycle` (gate teimoso cancelado) |
| **MAJOR** — na colheita, uma falha na derivação (ERROR do mission gate → `FAILED`) era engolida pelo `#guard`; a mensagem já tinha saído da caixa | a derivação da colheita propaga falha nova; um `close` repetido deriva de novo mesmo com a caixa vazia (`derivacaoPendente`) | `mission-gate-persisted.test.ts`: `saveRun(COMPLETED)` falha uma vez — `close` rejeita, posse fica, o `close` seguinte conclui o run com a execução |

### Ciclo 3 — fechado em ciclo excepcional autorizado pelo operador

Veredito da terceira revisão: **FAIL**, quatro BLOCKER e um MINOR. O operador autorizou UM
ciclo excepcional restrito a esses quatro (B1–B4). Cada um foi reproduzido por teste
vermelho antes da correção (9 testes vermelhos medidos: 4 de B1, 2 de B2, 2 de B3, 1 de B4) e
fechado:

| Achado | Fecho | Prova |
| --- | --- | --- |
| **B1** — SIGKILL enviado sem confirmar a morte do grupo | o runtime sonda `kill(-pgid, 0)` até ESRCH com teto (`groupGraceMs` 2 s); `ExitStatus.groupTerminated`; `cancel()` rejeita com `ProcessGroupAliveError`; gates relatam `residualProcess`; `workspaceSetup` lança com `residualProcess`; o orquestrador guarda efeitos não provados mortos e `abandon` rejeita (posse retida) enquanto houver um, sondando de novo na tentativa seguinte | `group-confirmation.test.ts` (grupo confirmado espera; grupo imortal → rejeita no teto, sem loop); `shutdown-drain.test.ts` B1: handle cujo grupo sobrevive → `close` rejeita, lease retido, outro processo não adquire; morto o grupo, o `close` seguinte devolve |
| **B2** — `mission start` adquiria a posse antes de assinar sinais | `waitForShutdown()` é assinado antes de `acquireControlPlaneOwnership`; o supervisor e o `--serve` usam a mesma promessa | `mission-start-serve.test.ts` B2: ordem `sinal-assinado` antes de `plane`; sinal durante o bootstrap → mesmo lifecycle, posse livre depois |
| **B3** — tratadores `once`: segundo Ctrl+C matava o processo no drain | hub de sinais permanente em `deps.ts`: primeiro sinal resolve a espera; sinal durante o encerramento é absorvido e registrado; sinal pendente dispara a próxima espera na hora | `deps.test.ts` (tratador permanece; sinal absorvido dispara o retry; sem pendente, espera sinal novo); `foreground-signal.test.ts` B3 (CLI real, dois SIGINT, setup morto, posse livre, saída graciosa) |
| **B4** — caminho excepcional de `mission start` descartava a falha do encerramento | o mesmo laço de nova tentativa cobre o caminho excepcional; o erro original só sobe depois de o projeto ser devolvido | `mission-start-serve.test.ts` B4: `startRun` quebra, `close` falha uma vez, espera o segundo sinal, encerra, e só então rejeita com o erro original |

### Revisão de confirmação (quarta leitura) — **FAIL**, sem quarto ciclo

Gates na cabeça `22dfad6`: build PASS; verify PASS (187 arquivos, 2255 testes); E2E PASS em
**4 de 4** execuções completas consecutivas (98 passaram, 4 pulados cada; D14 não recorreu,
nenhum órfão); browser PASS (10). Suítes direcionadas: 19 arquivos, 172 testes.

A revisão de confirmação, classificada como o operador pediu:

| Classe | Achado | Avaliação |
| --- | --- | --- |
| A | **B2, B3, B4 fechados** (com arquivo:linha e teste citados pelo revisor) | confirmado |
| A | **B1 não fechado de ponta a ponta**: `groupTerminated=false` na saída **natural** de um agente é descartado pelo adapter (o contrato do domínio não carrega o campo; `local-cli` só traduz código, timeout e cancelamento); e a prova de orquestração usa um handle falso, não cobre gate, setup nem saída natural | legítimo; caso estreito (descendente sobrevive a SIGKILL além do teto após saída normal), mas o contrato exige |
| C1 | **BLOCKER novo** — o listener de abort faz `void this.cancel(...)` sem `catch`; com `cancel()` agora rejeitando quando o grupo sobrevive, vira `unhandledRejection` — em Node ≥ 22 pode terminar o processo e soltar a posse pelo SO com o grupo vivo | legítimo e **regressão** introduzida por este ciclo |
| C2 | **BLOCKER novo** — `cancel run` e `cancel task` (comandos humanos) mantêm `.catch(() => undefined)`: grupo vivo, estado oficial `CANCELLED`, worktree liberada para reutilização | legítimo |
| C3 | **BLOCKER novo** — `#residual.clear()` no início de cada `abandon()` apaga resíduos de gate/setup sem guardar pgid nem função de nova sonda; o segundo Stop pode devolver a posse sem prova de morte | legítimo |
| D | D6 pós-crash, D13, D14 | não se tornaram alcançáveis automaticamente; não bloqueiam |
| E | Windows e `setsid`: limites declarados. A prova E2E de B3 usa o `waitForShutdown` injetado do harness (`cli-process.ts`), não o hub de produção, e o segundo sinal é enviado a 150 ms sem prova de que o drain estava ativo | lacuna de evidência, não defeito |

Nada foi corrigido depois desta leitura: a autorização era de UM ciclo. **Decisão humana:**
não reverter; C1, C2, C3 e o ramo de saída natural de B1 viraram a micro-slice
[STABILITY-SLICE-004B](DIAGNOSTIC-STABILITY-SLICE-004B.md). Duas saídas possíveis, ambas
pequenas, que estavam na mesa:

1. **Ciclo restrito a C1–C3 e ao ramo de saída natural de B1.** `catch` no listener de abort
   (registrando o resíduo); propagar `ProcessGroupAliveError` nos cancelamentos humanos (a
   task não vira `CANCELLED` sem prova de morte); guardar, por resíduo, o pgid e a sonda para
   o `abandon` seguinte revalidar em vez de apagar; levar `groupTerminated` pelo adapter até
   o orquestrador (campo no contrato de `LocalAgentProcess`/`AgentOutcome`) e registrá-lo
   como resíduo. Estimativa: uma sessão curta, mais uma leitura de confirmação.
2. **Reverter `22dfad6`** (a cabeça volta a `1973691`): sem as regressões C1–C3, com os
   quatro blockers B1–B4 em aberto como registrados acima.

Tabela original da revisão, mantida para registro:

| Achado | Onde | O que faltaria | Tamanho |
| --- | --- | --- | --- |
| **BLOCKER** — o SIGKILL ao grupo é enviado, mas o processo assenta sem confirmar que o grupo parou: um descendente no meio de uma syscall de escrita pode concluí-la microssegundos depois de o `close` resolver | `packages/process/src/runtime.ts` `#settle`; `packages/workspace/src/setup.ts` `close` | sondar `kill(-pid, 0)` até `ESRCH` (com teto) antes de assentar; no setup, idem antes de `settle` | pequeno |
| **BLOCKER** — `mission start` adquire a posse antes de assinar os sinais: entre `acquireControlPlaneOwnership` e o supervisor há `openPlane`, `startRun` e `plane.open()` (que roda `git branch`); um SIGTERM ali cai no tratador padrão | `apps/cli/src/commands/mission-start.ts` | assinar `waitForShutdown()` logo após adquirir a posse e correr o sinal contra essa preparação | pequeno |
| **BLOCKER** — `defaultShutdown` da CLI usa `once`: consumido o primeiro sinal, um segundo Ctrl+C durante o drain mata o processo pelo padrão do Node (o `agentic-server` não tem o defeito: tratadores permanentes) | `apps/cli/src/deps.ts` | tratador permanente com fila de resolvedores, ou reassinar antes de iniciar o `stop` | pequeno |
| **BLOCKER** — o caminho excepcional de `mission start` (`orquestrar()` lança) faz `encerrar().catch(() => undefined)` e relança: uma falha de encerramento com posse retida é descartada e o processo sai | `apps/cli/src/commands/mission-start.ts` | o mesmo laço de nova tentativa do caminho normal | pequeno |
| MINOR — ADR-0014 se contradizia sobre sair com posse retida (consequências ainda diziam que o processo sai) | `docs/adr/ADR-0014` | corrigido neste commit de documentação | — |

O que os três ciclos **confirmaram** como fechado (pela revisão, com evidência): artefato em
voo, cadeia e jobs do orquestrador, `restart` sem dois donos, `quiesce` antes de parar de
atender, colheita sem engolir falha, I12 na colheita, readonly/readwrite da 003C, I13 e I14.
O que segue aberto é I15 **na passagem de posse pelos entrypoints da CLI** e a confirmação
da morte do grupo de processos.

## G. Problemas registrados, não corrigidos

| | Descrição |
| --- | --- |
| **D6 (parcial)** | Recovery de `INTEGRATING` está fechado para o encerramento **gracioso** (o resultado é colhido). Para `SIGKILL` no meio de um rebase, o próximo dono ainda reconcilia a task como `INTERRUPTED` e pode refazer trabalho já integrado — exige marcador durável de integração, fora desta fatia |
| **D13** *(novo)* | Sob `SIGKILL`, um comando de gate ou `workspaceSetup` iniciado pelo dono morto fica órfão até terminar sozinho. Não alcança o banco e não rouba a worktree da missão (prova de posse), mas existe. Fechar exige um supervisor de processos ou `prctl(PR_SET_PDEATHSIG)`-equivalente portátil |
| **D14** *(novo, suíte)* | Intermitência em `tests/e2e/control-plane-ownership.test.ts` (D ou E) só com a suíte E2E inteira em paralelo: em 2 de 6 execuções completas o dono **B** ficou vivo e o teste estourou 120 s. Inspecionado ao vivo (inspector do Node): B saudável, porta aberta, **um** tratador de SIGTERM e um de SIGINT ainda registrados — ou seja, B **nunca recebeu o sinal**; enviado à mão depois, encerrou limpo em < 100 ms. Passa 11/11 em isolamento e 3/3 com o arquivo sozinho. Não reproduzido com rastreamento ligado. O harness ganhou prazo com SIGKILL e erro descritivo no `stop()`, para uma recorrência produzir dado em vez de órfão. Não é defeito do produto conhecido; fica registrado como dívida da suíte |
| **D5, D7, D8, D9, D10, D11** | inalterados (ver DIAGNOSTIC-STABILITY-SLICE-003) |
