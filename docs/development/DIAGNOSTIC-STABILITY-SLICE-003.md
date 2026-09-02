# Diagnóstico — STABILITY-SLICE-003 · SINGLE CONTROL PLANE OWNERSHIP (D4)

> Branch: `diagnostic/STABILITY-SLICE-003`, a partir de `fix/STABILITY-SLICE-002`
> (`a4e6ffdedd42c8df6896fc7bbfa9b212aabffd7a`). `main` (`797b8e72…`) intocada.
> **Nenhum código de produção foi alterado nesta sessão.**
>
> **Veredito: `READY_FOR_SMALL_FIX`.**

---

## A. Reprodução cross-process

Dois **processos de sistema operacional distintos**, cada um executando o caminho de
produção (`startServer` — o que `agentic serve` chama por dentro), sobre o **mesmo
`repoRoot`**, com **portas efêmeras** (nenhuma prova aqui se apoia em `EADDRINUSE`).
Fornecedores in-process no `project.yaml` do fixture: nenhuma CLI real, zero quota.

```
Processo A   pid 3648568   http://127.0.0.1:45247   /tmp/…/.agentic/state.db
Processo B   pid 3648597   http://127.0.0.1:37857   /tmp/…/.agentic/state.db   ← MESMO banco
ambos vivos (kill -0)

A.adopted = [ { runId: 01M1EXW41PSZS213A41PHGYWJS, status: PAUSED, alreadyOwned: false } ]
B.adopted = [ { runId: 01M1EXW41PSZS213A41PHGYWJS, status: PAUSED, alreadyOwned: false } ]

.agentic/control-plane.json = { "port": 37857, "pid": 3648597, … }   ← só B
```

Os dois adotaram o **mesmo run**, os dois se declararam donos (`alreadyOwned: false` em
ambos) e o registro de descoberta ficou apontando só para o último a gravar — **o processo A
continuou dono de um run e sumiu do mapa**.

### A.1 O dano, medido

Com um run em `RUNNING` e os dois processos nascendo **ao mesmo tempo**, o event log do run
guarda a colisão (nenhum desses eventos aparece quando só há um dono):

```
policy.invalid_transition  task READY→RUNNING  SCHEDULER_DISPATCH
    GUARD_FAILED:workspace-acquired (caminho de worktree ja existe)
policy.invalid_transition  task BLOCKED→FAILED  ATTEMPT_FAILED  NOT_LISTED   (×2)
policy.invalid_transition  task READY→FAILED    ATTEMPT_FAILED  NOT_LISTED
```

Duas leituras diretas:

1. **`caminho de worktree ja existe`** — os dois donos calcularam a MESMA worktree. O caminho
   é `<worktreeRoot>/<runId>/<taskId>-a<N>` e a branch é `task/<mission>/<task>/a<N>`
   ([naming.ts:29](../../packages/workspace/src/naming.ts#L29)): derivados do
   `attemptCount + 1` **persistido**, não do `attemptId` único. Dois processos que leem o
   mesmo `attemptCount` disputam o mesmo diretório e a mesma branch — I8 e I2 dependem de
   estruturas em memória que cada processo tem só para si.
2. **`ATTEMPT_FAILED … NOT_LISTED`** — o segundo dono terminou uma tentativa contra uma task
   que o primeiro já havia movido. `attempt.finished` foi gravado e a transição foi recusada:
   **o trabalho do perdedor foi descartado em silêncio**, e o estado do run passou a ser o de
   quem escreveu por último.

### A.2 A porta não é a defesa (§5, §12)

Pelo comando real, no mesmo `repoRoot`:

```
$ agentic serve --port 4400      → control plane no ar em http://127.0.0.1:4400   (pid 3651540)
$ agentic serve --port 4401      → control plane no ar em http://127.0.0.1:4401   (pid 3651644)
                                   ambos vivos; control-plane.json = apenas 4401
$ agentic serve                  → control plane ja no ar em http://127.0.0.1:4410 (reutiliza)
```

A reutilização só acontece **sem `--port`**: `resolveEndpoint`
([discovery.ts:56](../../apps/cli/src/discovery.ts#L56)) devolve a flag antes de olhar o
registro de runtime, então `--port` nunca consulta a descoberta. E mesmo o caminho bom é um
TOCTOU: entre `deps.connect(endpoint)` e o `listen`, outro processo pode subir.

### A.3 Harness usado

`tests/e2e/support/owner-process.ts` (o filho: um control plane por processo) e
`tests/e2e/support/cross-process.ts` (spawn via `vite-node` sobre o fonte, com
`process.execPath` para não trocar de versão de Node). Nenhum agente real é invocado.

---

## B. Teste vermelho

`tests/e2e/control-plane-ownership.test.ts` — **5 casos, 3 vermelhos hoje**:

| Caso | O que prova | Hoje |
| --- | --- | --- |
| A. dois processos, mesmo projeto | um dono, o outro recusado | ❌ `['A','B']` |
| B. portas explicitamente diferentes | porta não compra posse | ❌ `['A','B']` |
| C. dono morto por `SIGKILL` | o próximo consegue assumir | ✅ guarda (§21) |
| D. partida SIMULTÂNEA | exatamente um vencedor + descoberta aponta pro dono | ❌ `['A','B']` |
| E. projetos diferentes | dois donos são legítimos | ✅ guarda (§4) |

```
Test Files  1 failed (1)
     Tests  3 failed | 2 passed (5)      8.2s
```

C e E **passam hoje e precisam continuar passando**: uma correção que feche A/B/D quebrando
C trocou o defeito por um lock que nunca se solta depois de uma queda; quebrando E, por um
lock global que impede trabalhar em dois projetos ao mesmo tempo.

`npm run verify` continua **PASS** (171 arquivos, 2130 testes) — o vermelho vive só no
projeto `e2e`, que o `verify` exclui por desenho.

---

## C. Causa raiz

**Não existe, em lugar nenhum do código, uma operação que responda "eu posso ser o dono deste
`repoRoot`?".** O boot pergunta outra coisa — "há alguém atendendo neste endereço?" — e essa
pergunta é sobre socket, não sobre projeto.

Três camadas falham juntas, e nenhuma delas foi desenhada para isto:

1. **Descoberta ≠ posse.** `control-plane.json` é escrito *depois* do `listen`
   ([server.ts:106](../../apps/server/src/server.ts#L106)), com `writeFile` não-atômico, sem
   `wx`, sem `repoRoot`, sem identidade além do pid. Último a escrever vence.
2. **A checagem de reuso é conselho, não guarda.** Vive só na CLI (`serveCommand`), é TOCTOU,
   e `--port` a desliga. Quem chama `startServer` direto (pacote `@agentic/server`,
   `npm start -w @agentic/server`, futura extensão) nunca passa por ela.
3. **Nada no núcleo cobra posse.** `createControlPlane` abre o banco em `readwrite` e
   `adoptRecoverableRuns()` liga loops sem perguntar a ninguém
   ([control-plane.ts:377](../../packages/orchestrator/src/engine/control-plane.ts#L377)).

E o estado não se defende sozinho: `#load()` lê fora da transação e `#write()` grava com
`upsert` incondicional ([writes.ts:33](../../packages/persistence/src/writes.ts#L33)) — **não
há compare-and-swap nem versão de linha**. Dois processos que leem `READY` e escrevem
`RUNNING` ambos "vencem"; o segundo apaga o primeiro.

A STABILITY-SLICE-002 não criou o defeito — ela **removeu o último atrito humano**. Antes, o
segundo processo precisava de um comando para começar a operar o run; agora a adoção acontece
sozinha no boot. Por isso D4 tem de fechar **antes** da promoção de D3.

---

## D. Papel atual de `.agentic/control-plane.json`

Arquivo: [apps/server/src/control-plane-file.ts](../../apps/server/src/control-plane-file.ts).

| Pergunta | Resposta medida |
| --- | --- |
| Quem escreve | `attachServer` — logo, `agentic serve`, `mission start` (default) e qualquer `startServer` |
| Quando escreve | **depois** do `listen`, com a porta REAL do socket; **antes** da adoção |
| Quando remove | `RunningServer.close()`, e só se pid+porta ainda forem os nossos |
| SIGINT / SIGTERM | `defaultShutdown` ([deps.ts:99](../../apps/cli/src/deps.ts#L99)) resolve → `close()` → registro removido. Só vale enquanto um comando está esperando |
| Crash / SIGKILL | arquivo **fica**; ninguém limpa |
| Stale pid | `discoverControlPlane` sonda `kill(pid, 0)` e, se morto, faz `rm` **incondicional** — pode apagar um registro fresco que outro processo acabou de gravar |
| Valida `repoRoot`? | **Não.** O registro não tem `repoRoot`, nem `instanceId`, nem hostname |
| Descobre porta? | `--port` > registro de runtime vivo > `server:` do `project.yaml` |
| Escrita atômica? | **Não.** `writeFile` direto, sem `tmp`+`rename`, sem `wx` |
| Dois processos sobrescrevem? | **Sim — medido.** Um dono vivo desaparece do registro |
| Serve como posse? | **Não.** Publicação tardia, não-atômica, sem exclusividade, sem identidade estável, apagável por terceiros |

Ele responde bem à pergunta para a qual foi feito — *"com quem eu falo?"*. Não responde
*"quem pode agir?"*, e transformá-lo em lock sem mudar a semântica converteria toda limpeza
de registro stale já existente num caminho de roubo de posse.

---

## E. Alternativas de posse

Cada linha abaixo tem medição própria nesta sessão quando marcada **medido**.

| | A. lock file `wx`/O_EXCL | B1. `BEGIN EXCLUSIVE` no `state.db` | **B2. lock em SQLite dedicado** | C. pid/runtime file reforçado | D. socket/named pipe | E. `flock` nativo |
| --- | --- | --- | --- | --- | --- | --- |
| Atomicidade | ✅ **medido**: 8 processos × 15 rodadas → 1 vencedor sempre | ✅ | ✅ **medido**: 8 processos × 12 rodadas → 1 vencedor sempre | ❌ último a escrever vence | ✅ `bind` é atômico | ✅ |
| Stale lock | ⚠️ lógica explícita (heartbeat + sonda) | ✅ SO libera | ✅ **medido**: `SIGKILL` → próximo adquire na hora | ⚠️ heurística | ⚠️ arquivo de socket sobrevive no Linux | ✅ SO libera |
| Crash / release falho | ⚠️ depende da heurística | ✅ | ✅ **não existe cleanup a falhar** | ⚠️ | ⚠️ | ✅ |
| PID reuse | ⚠️ precisa de `instanceId` + sonda de endpoint | ✅ irrelevante | ✅ **pid deixa de ser autoridade** | ❌ o problema é esse | ✅ | ✅ |
| Windows | ✅ | ✅ `LockFileEx` | ✅ `LockFileEx` | ✅ | ⚠️ named pipe: outro mecanismo, nome global da máquina | ⚠️ API diferente |
| Linux / WSL | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Remote SSH / Dev Containers | ✅ (limite: FS de rede) | ✅ (mesmo limite) | ✅ (mesmo limite) | ✅ | ❌ pipe não atravessa o FS montado | ✅ (mesmo limite) |
| Múltiplos projetos | ✅ por `.agentic/` | ✅ | ✅ por `.agentic/` | ✅ | ⚠️ exige hash do path no nome | ✅ |
| Teste determinístico | ✅ | ⚠️ conflita com as escritas reais | ✅ | ✅ | ⚠️ | ⚠️ |
| Dependência nova | nenhuma | nenhuma | **nenhuma** (`better-sqlite3` já é núcleo) | nenhuma | nenhuma | ❌ addon nativo (`fs-ext`) |
| Risco principal | inventar heurística de vivacidade | trava as escritas legítimas do próprio produto | FS de rede; `unlink` do arquivo derruba a exclusividade | não resolve nada | dois mecanismos, isolamento errado | dependência pesada |

**B1 está desqualificada** e vale dizer por quê: manter `BEGIN EXCLUSIVE` aberto no
`state.db` pela vida do processo bloqueia as escritas do **próprio** orquestrador
(`withTransaction` não pode aninhar `BEGIN`), impede checkpoint do WAL e faz o arquivo
crescer sem limite. Foi o alerta do §18 — e ele procede.

**E está desqualificada** porque Node não expõe `flock` sem addon nativo. O detalhe elegante
é que **não precisamos**: `SQLite` já usa `fcntl`/`LockFileEx` por baixo. B2 é lock de SO
obtido através de uma dependência que já está no núcleo.

---

## F. Escolha recomendada

> **B2 + descoberta atual, ligadas por `instanceId`.**
>
> Posse = uma transação `BEGIN EXCLUSIVE` mantida sobre `.agentic/control-plane.lock.db`,
> um banco SQLite **dedicado e minúsculo**, em WAL, com uma única linha commitada
> (`instanceId`, `pid`, `hostname`, `repoRoot`, `startedAt`, `endpoint`).
> Descoberta = `control-plane.json`, **inalterado**, ganhando um campo `instanceId`.

O comportamento inteiro, medido:

```
dono VIVO      → challenger: BEGIN EXCLUSIVE = SQLITE_BUSY
                 challenger: SELECT owner     = { instance, pid, endpoint }   ← sabe a quem falar
dono SIGKILL   → challenger: BEGIN EXCLUSIVE = OK                            ← assume na hora
8 processos simultâneos, 12 rodadas → exatamente 1 vencedor em todas
```

Por que esta e não a A (`wx`), que também é atômica:

- **A pergunta mais difícil desta fatia deixa de existir.** §9 (stale owner), §21 (release que
  falha) e §22 (PID reuse) são todos o mesmo problema — "como sei que o dono do arquivo morreu
  de verdade?" — e nenhuma resposta baseada em arquivo é honesta: `pid` mente sob reuso,
  heartbeat mente sob pausa do SO, `os.uptime()` mente em container. Com B2 **o sistema
  operacional responde**: o lock morre com o processo, sempre, sem cleanup e sem heurística.
- **WAL é obrigatório** no banco de lock — é o que permite ao perdedor **ler quem ganhou**
  enquanto o vencedor segura a transação. Com journal de rollback, `BEGIN EXCLUSIVE` bloquearia
  leitores e o perdedor ficaria sem saber a quem se conectar.
- **Um banco separado**, não o `state.db`: o lock não pode competir com as escritas reais.
- **Zero dependência nova, zero código de SO nosso.** `packages/persistence` já é dono do
  `better-sqlite3` e do layout de `.agentic/` — o módulo cai lá dentro sem criar pacote nem
  mexer em `scripts/boundaries.config.mjs`.

Descoberta e posse **continuam sendo dois arquivos**, de propósito (§6, §23): as semânticas
são opostas — o de descoberta é publicado tarde, removido no encerramento e limpo por
terceiros quando stale; o de posse é adquirido primeiro e **nunca** removido por terceiros.
Fundir os dois transformaria cada limpeza existente num roubo de posse.

---

## G. Comportamento em crash

| Situação | Hoje | Com B2 |
| --- | --- | --- |
| `SIGINT`/`SIGTERM` | `close()` remove `control-plane.json` | idem, e o SO libera o lock no exit |
| `SIGKILL` / OOM / queda | registro fica stale; próximo processo o apaga | **lock livre no mesmo instante** — medido |
| Máquina reiniciou | registro stale no disco | lock livre; nenhum estado sobrevive ao reboot |
| `release()` lança exceção (§21) | — | irrelevante: o lock é do processo, não do arquivo |

O produto nunca fica trancado por um dono morto, e isso **não depende de encerramento
gracioso** — que é exatamente o que o `Stop / Restart Agentic` da extensão vai precisar.

---

## H. Startup race (§10)

`BEGIN EXCLUSIVE` é serializado pelo lock de arquivo do SO. Medido com 8 processos reais
soltos no mesmo milissegundo, 12 rodadas: **1 vencedor em 12/12**. O perdedor recebe
`SQLITE_BUSY` — determinístico, sem `sleep`, sem retry cego — e no mesmo fôlego lê a linha
do vencedor para saber a quem se conectar.

O perdedor **não chega** a abrir banco mutável, não adota, não liga scheduler e não escreve:
a aquisição acontece antes de `createControlPlane` (ver L).

## I. Stale lock (§9)

Deixa de ser uma categoria de problema. Os seis casos do §9 colapsam em dois:

| Caso | Resposta |
| --- | --- |
| A. dono vivo | `SQLITE_BUSY` → conecta no endpoint da linha |
| B. morte normal | lock liberado no exit |
| C. morte abrupta | lock liberado pelo SO — **medido** |
| D. reboot | lock liberado |
| E. arquivo "stale" | não existe: o arquivo sem processo vivo não segura nada |
| F. PID reutilizado | irrelevante — `pid` é só informação para o humano |

"Quando é seguro reivindicar posse que parece stale?" — **quando `BEGIN EXCLUSIVE` devolve
`OK`, e só então.** Nenhum processo apaga nada de ninguém.

## J. PID reuse (§22)

`pid` sai da cadeia de autoridade e vira campo de diagnóstico ("control plane já no ar em
http://127.0.0.1:4317, pid 12345"). A identidade estável é `instanceId` (ULID gerado no boot),
e a autoridade é o lock. Contraste com hoje, onde `processAlive(pid)` é a única prova de vida
que a descoberta tem.

## K. Cross-platform

`fcntl` (Linux, macOS, WSL) e `LockFileEx` (Windows) — os dois usados pelo SQLite, sem código
nosso e sem `flock`/`/proc`/bash/sinal Unix. **Limite a documentar:** locks de arquivo POSIX
não são confiáveis em NFS/SMB. `.agentic/` é local por desenho (ADR-0003), e o mesmo limite
atinge qualquer mecanismo baseado em arquivo — inclusive `wx`. Um repositório montado
simultaneamente no host e dentro de um Dev Container por um FS que não propaga locks pode
render dois donos; isso precisa de uma linha no TROUBLESHOOTING, não de outro mecanismo.

---

## L. Ordem correta de boot

**Derivada do código, não assumida.** A pergunta do §11 — *qual é a primeira operação que
pode escrever estado ou despachar efeito?* — tem duas respostas:

- **Primeira escrita em disco:** `createControlPlane` → `openPersistence` → `openDatabase`.
  Ele faz `mkdirSync`, liga WAL (cria `-wal`/`-shm`) e roda `applyMigrations`, que executa
  `CREATE TABLE IF NOT EXISTS` numa transação
  ([database.ts:38](../../packages/persistence/src/database.ts#L38)).
- **Primeiro efeito:** `plane.adoptRecoverableRuns()`, que liga loops que despacham agentes e
  criam worktrees ([server.ts:171](../../apps/server/src/server.ts#L171)).

Ordem atual (`serveCommand` → `startServer` → `attachServer`):

```
loadProjectContext → resolveEndpoint → connect?  ← conselho TOCTOU, desligado por --port
loadProjectSources → resolveBind
createControlPlane                               ← ❶ PRIMEIRA ESCRITA
listen → writeControlPlaneFile
adoptRecoverableRuns                             ← ❷ PRIMEIRO EFEITO
READY
```

Ordem proposta:

```
resolve repoRoot (realpath canônico)
loadProjectSources  ·  resolveBind        ← leitura pura; recusa de bind não cria nada
acquireOwnership(repoRoot)  ─────────────► perdeu: devolve { endpoint, pid, instanceId }
        │                                          NÃO abre banco · NÃO serve · NÃO adota
        ▼ ganhou
createControlPlane  (banco mutável)
listen
publica control-plane.json (+ instanceId)
adoptRecoverableRuns
READY
```

`resolveBind` continua antes da aquisição de propósito: o comentário em
[server.ts:134](../../apps/server/src/server.ts#L134) diz que um endereço proibido não pode
criar nada, e criar o arquivo de lock seria criar algo.

## M. Posse × adoção (§19)

A regra tem de estar **no objeto, não no chamador**: `adoptRecoverableRuns()` e `open()` de um
plane declarado `ownership: 'required'` recusam sem lease vivo. Assim, nenhum caminho futuro
(rota HTTP, extensão, comando novo) pode esquecer de perguntar. O perdedor idealmente nem
chega lá: `startServer` devolve `ControlPlaneBusyError` antes de `createControlPlane`.

A STABILITY-SLICE-002 **não muda**. Ela ganha a pré-condição que faltava: I13 continua
dizendo "um dono por run naquela instância", e I14 passa a garantir que só existe uma
instância com direito a instâncias.

## N. Posse × descoberta (§23)

Dois arquivos, um `instanceId` em comum:

```
.agentic/control-plane.lock.db   POSSE       adquirido antes de tudo · liberado pelo SO
                                             ninguém remove por terceiros
.agentic/control-plane.json      DESCOBERTA  publicado depois do listen · removido no close
                                             + campo instanceId (novo)
```

`ensureAgenticRunning(repoRoot)` fica assim, sem `ps`, sem `kill`, sem porta fixa, sem `sleep`:

```
lê control-plane.json → GET /api/health         ✅ responde → conecta, fim
                                                ❌ silêncio → spawn `agentic serve`
o processo spawnado tenta adquirir a posse:
   ganhou  → vira o dono e publica o endpoint
   BUSY    → lê a linha do dono, imprime "control plane ja no ar em <url> (pid N)", sai 0
```

Duas janelas do editor podem chamar isso **ao mesmo tempo**: no pior caso dois processos são
lançados, exatamente um vence a aquisição e o outro sai limpo informando o endpoint. As duas
janelas terminam apontando para o mesmo control plane. É o §13 satisfeito sem race.

## O. Impacto futuro no VS Code

- `VS Code A` + `VS Code B` no mesmo workspace → um control plane, duas conexões. ✅
- Projetos A/B/C abertos ao mesmo tempo → um dono cada, porque a chave é o `repoRoot`. ✅
- `Stop Agentic` → `Restart Agentic` → a posse é do processo; matar e subir de novo funciona
  mesmo se o `stop` for abrupto. ✅
- Portas dinâmicas por projeto continuam possíveis: a posse não é a porta. ✅

**Se a arquitetura escolhida não suportasse `ensureAgenticRunning` concorrente sem `ps`/`kill`
/porta fixa/`sleep`, ela deveria ser rejeitada (§13).** B2 suporta.

## P. Invariante proposta

A redação do enunciado (`I14 — para um repoRoot, existe no máximo um Control Plane autorizado
a possuir Orchestrators e executar efeitos`) está quase certa. Duas correções que o domínio
real exige:

1. **"Control Plane" é ambíguo no código.** Hoje a palavra nomeia três coisas: o processo, o
   objeto `ControlPlane` de `@agentic/orchestrator`, e o endereço HTTP. A invariante é sobre
   posse, não sobre processo — e vários processos podem legitimamente ter um objeto
   `ControlPlane` em modo somente-leitura.
2. **A garantia é de exclusão, não de existência.** "No máximo um" está certo; não pode virar
   "exatamente um", porque um projeto sem nada rodando é o estado normal.

Vocabulário que o código precisa passar a distinguir:

| Termo | O que é | Quantos por `repoRoot` |
| --- | --- | --- |
| **Control Plane Owner** | quem detém o lease e pode possuir `Orchestrator`, adotar runs e produzir efeitos | **no máximo 1** |
| Control Plane Process | processo que executa código do produto sobre o projeto | vários |
| Client | CLI, dashboard, extensão — fala HTTP com o owner | vários |
| Dashboard / VS Code Window | um Client com tela | vários |

> **I14 — Para um `repoRoot`, existe no máximo um *Control Plane Owner*: o processo que
> detém o lease de posse do projeto. Só ele pode abrir `Orchestrator`, adotar runs
> recuperáveis, reconciliar e despachar agente. Todo outro processo é *Client* — lê, exibe e
> comanda por HTTP — ou recusa iniciar, com o endpoint do owner vivo no motivo.**

I13 então perde a nota de rodapé que hoje a esvazia: com I14, "naquela instância" passa a ser
"naquele projeto", porque só existe uma instância com direito a possuir.

## Q. Menor correção possível

1. **`packages/persistence/src/control-plane-lock.ts`** (novo, ~120 linhas):
   `acquireControlPlaneLock(baseDir, info)` → `{ held: true, release() }` ou
   `{ held: false, owner }`; `readControlPlaneOwner(baseDir)`. Banco dedicado, WAL,
   `busy_timeout = 0`, uma linha commitada antes do `BEGIN EXCLUSIVE`.
2. **`packages/orchestrator/…/control-plane.ts`**: `ControlPlaneConfig.lease?` +
   `ownership: 'required' | 'none'`; `open()`/`adoptRecoverableRuns()` recusam sem lease;
   `close()` libera.
3. **`apps/server/src/server.ts`**: `startServer` adquire **antes** de `createControlPlane`;
   `ControlPlaneBusyError` com `{ url, pid, instanceId }`; `close()` libera.
4. **`apps/cli/src/commands/serve.ts`**: transformar `Busy` na mensagem que já existe
   (`control plane ja no ar em …`) — agora **também quando `--port` foi passado**.
5. **`apps/cli/src/commands/mission-start.ts`**: o ramo de plane local adquire ou recusa
   apontando o owner.
6. **`control-plane.json`**: ganha `instanceId`. Nada mais muda nele.
7. **Docs no mesmo commit** (regra do repositório): `ADR-0013-ownership-do-control-plane.md`,
   `STATE-MACHINES.md` (I14 + reescrever o parágrafo do limite de I13), `CLAUDE.md`
   (tabela de invariantes + o texto que hoje diz que D4 está aberto), `TROUBLESHOOTING.md`.
8. **Testes**: `tests/e2e/control-plane-ownership.test.ts` fica verde; unitários do lock em
   `packages/persistence`; **`tests/e2e/run-adoption-cross-process.test.ts` precisa ser
   reescrito** — ele hoje *afirma* o defeito e o próprio comentário dele diz que a próxima
   fatia o encontraria falhando de forma barulhenta.

O que **não** entra: `withPlane` dos comandos de leitura continua abrindo plane sem posse.
Eles não possuem orquestrador nem despacham — mas hoje abrem em `readwrite`, e isso vira
follow-up (D9), não escopo desta fatia.

## R. Arquivos / touches

```
packages/persistence/src/control-plane-lock.ts            (novo)
packages/persistence/src/control-plane-lock.test.ts       (novo)
packages/persistence/src/index.ts
packages/orchestrator/src/engine/control-plane.ts
apps/server/src/server.ts
apps/server/src/control-plane-file.ts                     (+ instanceId)
apps/server/src/index.ts
apps/cli/src/commands/serve.ts
apps/cli/src/commands/mission-start.ts
tests/e2e/control-plane-ownership.test.ts                 (vermelho → verde)
tests/e2e/run-adoption-cross-process.test.ts              (reescrever)
docs/adr/ADR-0013-ownership-do-control-plane.md           (novo)
docs/architecture/STATE-MACHINES.md
docs/product/TROUBLESHOOTING.md
CLAUDE.md
```

Sem novo pacote. Sem mudança em `scripts/boundaries.config.mjs`. Sem dependência nova.

## S. Estimativa

Uma fatia pequena: ~250–350 linhas de produção, ~200 de teste, 4 documentos. O trabalho
difícil — descobrir *qual* primitiva cria exclusividade durável e provar que ela sobrevive a
`SIGKILL`, a corrida de partida e a múltiplos projetos — já está feito e medido nesta sessão.

## T. Riscos

| Risco | Mitigação |
| --- | --- |
| FS de rede (NFS/SMB, alguns mounts de Dev Container) não propaga locks POSIX | documentar o limite; vale para qualquer mecanismo de arquivo |
| `rm .agentic/control-plane.lock.db` com o dono vivo derruba a exclusividade em silêncio | dentro do threat model declarado (§15): o lock é cooperativo, não defende contra operador hostil |
| Uma conexão SQLite a mais aberta pela vida do processo | banco dedicado, uma tabela, uma linha; nenhum efeito sobre `state.db` |
| Esquecer um caminho que abre plane mutável | por isso a recusa vive em `adoptRecoverableRuns`/`open`, não só no chamador |
| Mensagem ruim quando o segundo processo é recusado | é metade da fatia: `Busy` tem de virar "control plane ja no ar em <url>, pid N", nunca stack trace |

## U. Problemas fora de escopo (registrados, não corrigidos)

| | Descrição |
| --- | --- |
| **D5** | cleanup de worktrees órfãs de attempts |
| **D6** | recovery de `INTEGRATING` |
| **D7** | `resolveEndpoint --port` ignora a descoberta — **confirmado nesta sessão** ([discovery.ts:60](../../apps/cli/src/discovery.ts#L60)); a correção de D4 o torna inofensivo para posse, mas ele continua errado para descoberta |
| **D8** | todas as tasks `SKIPPED` |
| **D9** *(novo)* | comandos de leitura (`mission status`, `task inspect`, `run report`, `events tail`) abrem persistência em `readwrite` via `withPlane`; e `mission approve` escreve estado fora de qualquer posse |
| **D10** *(novo)* | `discoverControlPlane` remove o registro stale sem verificar se ainda é o que leu — pode apagar um registro fresco de outro processo |
| **D11** *(novo)* | caminho e branch da worktree derivam de `attemptCount + 1`, não do `attemptId`: duas tentativas concorrentes colidem por construção ([naming.ts:29](../../packages/workspace/src/naming.ts#L29)) |
| — | UX de `agentic stop/status/restart`; portas dinâmicas por projeto; extensão VS Code |

## V. Git status

```
branch: diagnostic/STABILITY-SLICE-003
main:                       797b8e72e3ceaf8974d9a492764d328827e32901   (intocada)
fix/STABILITY-SLICE-002:    a4e6ffdedd42c8df6896fc7bbfa9b212aabffd7a   (intocada)

git diff --name-status fix/STABILITY-SLICE-002   → vazio
não rastreados:
  tests/e2e/control-plane-ownership.test.ts
  tests/e2e/support/cross-process.ts
  tests/e2e/support/owner-process.ts
  docs/development/DIAGNOSTIC-STABILITY-SLICE-003.md
```

## W. Código de produção

**Nenhum arquivo de produção foi alterado.** `git diff` contra `fix/STABILITY-SLICE-002` é
vazio; só há arquivos novos, todos em `tests/e2e/` e `docs/`. `npm run verify` continua PASS
(171 arquivos, 2130 testes).

## X. Veredito

> ## `READY_FOR_SMALL_FIX`

O mecanismo está escolhido e **medido**, não deduzido: atomicidade sob corrida real de 8
processos, liberação automática sob `SIGKILL`, leitura da identidade do dono pelo perdedor, e
isolamento por projeto. A correção é pequena, cabe em um pacote que já existe, não adiciona
dependência e não muda a STABILITY-SLICE-002.

Exige ADR (`ADR-0013`) e uma invariante nova (I14) porque é mudança estrutural — que é o
processo normal deste repositório, não um bloqueio de arquitetura.

Depois de D4 fechado: validar `main` + STABILITY-SLICE-002 + STABILITY-SLICE-003 **como
conjunto**, e só então promover D3.
