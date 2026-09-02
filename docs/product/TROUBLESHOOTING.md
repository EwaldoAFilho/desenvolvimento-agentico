# TROUBLESHOOTING — problemas realmente observados

> **Regra deste documento:** só entra aqui o que já aconteceu de verdade, neste produto,
> com data e saída literal. Nada de "possíveis causas". Se um caso não foi observado, ele
> não está nesta página.
>
> Cada entrada tem a mesma forma: **sintoma observado → causa → o que fazer.**

Se você ainda não rodou nada, comece pelo [QUICKSTART.md](QUICKSTART.md).

Índice:

- Ambiente
  - [Node incompatível: NODE_MODULE_VERSION](#node-incompatível-node_module_version)
  - [Symlink da CLI do agente quebrado](#symlink-da-cli-do-agente-quebrado)
  - [Fornecedor instalado e autenticado, mas sem saldo](#fornecedor-instalado-e-autenticado-mas-sem-saldo)
- Operação
  - [Control plane não encontrado ao pausar](#control-plane-não-encontrado-ao-pausar)
  - [Run BLOCKED não volta a rodar depois de `task retry`](#run-blocked-não-volta-a-rodar-depois-de-task-retry)
  - [Worktree não é criada e o run fica parado sem erro](#worktree-não-é-criada-e-o-run-fica-parado-sem-erro)
  - [Dashboard não carregava em projeto que não fosse o produto](#dashboard-não-carregava-em-projeto-que-não-fosse-o-produto)
- Missão e execução
  - [Missão com WARNING: o que significa aceitar](#missão-com-warning-o-que-significa-aceitar)
  - [SCOPE_VIOLATION: escopo é contrato](#scope_violation-escopo-é-contrato)
  - [Gate reprovando e onde ler a evidência](#gate-reprovando-e-onde-ler-a-evidência)
  - [Gate com ERROR e "exit sem codigo"](#gate-com-error-e-exit-sem-codigo)
  - [NO_CHANGES: quando é falha e quando é acerto](#no_changes-quando-é-falha-e-quando-é-acerto)
  - [Revisor não emitiu veredito (AGENT_ERROR)](#revisor-não-emitiu-veredito-agent_error)
- [Arestas conhecidas da CLI](#arestas-conhecidas-da-cli)

---

## Ambiente

### Node incompatível: NODE_MODULE_VERSION

**Sintoma observado.** Depois de trocar a versão do Node (nvm, atualização de sistema,
outro terminal), a suíte inteira quebra — centenas de falhas com a mesma mensagem — ou o
`doctor` responde `unknown` onde antes respondia um número:

```console
$ agentic doctor
  ERRO     versao do Node                     node 20.18.1: o control plane exige >= 22
  ...
  unknown  agentes em voo                     nao apurado: The module '.../better-sqlite3/build/Release/better_sqlite3.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION 137. This version of Node.js requires
NODE_MODULE_VERSION 115. Please try re-compiling or re-installing
the module (for instance, using `npm rebuild` or `npm install`).
```

**Causa.** O estado do run vive em SQLite com módulo nativo (`better-sqlite3`). Módulo
nativo é compilado contra o ABI de **uma** versão de Node. `node_modules` compilado sob
Node 24 (ABI 137) não carrega sob Node 20 (ABI 115). O problema não é o produto: é o
binário compilado não corresponder ao interpretador.

**O que fazer.**

1. Confirme com quem você está falando: `node --version`. O produto exige **>= 22**.
2. Volte para a versão certa (`nvm use 24`) — o `node_modules` que já estava lá volta a
   funcionar sozinho.
3. Se você realmente quer instalar noutra versão suportada, reinstale as dependências:
   `rm -rf node_modules && npm ci`.

**Por que hoje é mais difícil cair nisso.** O repositório declara `engine-strict=true` em
`.npmrc`, então o próprio npm recusa **na instalação**, e não meia hora depois:

```console
$ npm install       # com Node 20
npm error code EBADENGINE
npm error engine Unsupported engine
npm error notsup Required: {"node":">=22"}
npm error notsup Actual:   {"npm":"10.8.2","node":"v20.18.1"}
```

**Como o doctor identifica.** A linha `versao do Node` compara o `major` com o mínimo e sai
`ERRO`. E a linha `agentes em voo` vira `unknown` — não `0` — porque o número sai do banco,
e o banco não pôde ser lido. `unknown` nunca é apresentado como sucesso.

---

### Symlink da CLI do agente quebrado

**Sintoma observado.** O `doctor` reprova o fornecedor com `NOT_INSTALLED`, mesmo com a CLI
"instalada" e funcionando ontem:

```console
$ agentic doctor
  ERRO     fornecedor claude-code             NOT_INSTALLED · instalacao: "/tmp/fakebin/claude" e um symlink quebrado: /tmp/fakebin/claude aponta para /opt/nao-existe/claude-2.1.220/cli.js, que nao existe; prontidao false por ausencia do executavel · conserto: recrie o link para uma instalacao existente (`ln -sfn <caminho-real> /tmp/fakebin/claude`) ou reinstale a CLI

  claude-code  NOT_INSTALLED
    instalado      nao
    executavel     /tmp/fakebin/claude
    caminho        unknown
    versao         unknown
    pronto         nao · origem: prontidao false por ausencia do executavel
    diagnostico    [broken-symlink] "/tmp/fakebin/claude" e um symlink quebrado: /tmp/fakebin/claude aponta para /opt/nao-existe/claude-2.1.220/cli.js, que nao existe
    alvo           /opt/nao-existe/claude-2.1.220/cli.js (nao existe)
    conserto       recrie o link para uma instalacao existente (`ln -sfn <caminho-real> /tmp/fakebin/claude`) ou reinstale a CLI
```

**Causa.** O caso real (missão DA-CORE-002, 2026-08-30): `~/.local/bin/claude` apontava
para a revisão **snap 252**, que havia sido removida numa atualização. O link continuava
existindo; o alvo, não. Para o shell isso é `command not found`; para o `doctor` é
`broken-symlink` — que é diagnóstico diferente de "não instalado", porque o conserto é
diferente.

**O que fazer.** O `doctor` já entrega a linha de comando. Encontre uma instalação viva e
repare o link. Foi exatamente isto que resolveu o caso real:

```sh
ls -d ~/snap/code/*/.local/share/claude/versions/*      # ache uma revisão que existe
ln -sfn /home/<user>/snap/code/current/.local/share/claude/versions/2.1.220 \
        /home/<user>/.local/bin/claude
agentic doctor                                          # confirme READY antes de gastar quota
```

Nada foi baixado, instalado, removido, nem exigiu `sudo`. E repare no que o `doctor`
mostra **depois** do conserto — a diferença entre "responde" e "está pronto":

```console
  ok       fornecedor claude-code             READY · executavel em /home/.../claude; versao via `claude --version`; sonda `claude auth status` saiu 0 e declarou sessao autenticada
```

`--version` respondendo prova instalação. `READY` só sai de uma sonda de **sessão** que
saiu 0.

---

### Fornecedor instalado e autenticado, mas sem saldo

**Sintoma observado.** `doctor` diz `READY`. `providers` diz `pronto: sim`. E o despacho
falha assim mesmo. Saída literal da sonda direta ao Codex, em 2026-08-30:

```text
OpenAI Codex v0.151.0-alpha.7.2
workdir: /tmp/codex-probe-1
model: gpt-5.6-sol
approval: never
sandbox: read-only
ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage
       to purchase more credits or try again at Sep 5th, 2026 6:28 PM.
```

**Causa.** **Autenticado não é o mesmo que com saldo.** `codex login status` sai 0 porque a
sessão existe — e essa é a única coisa que a sonda de prontidão pode medir. A ausência de
crédito só se manifesta no **despacho**, quando o trabalho é pedido. O produto não tem como
saber antes, e não inventa: dizer `NOT_READY` por suspeita seria tão errado quanto dizer
`READY` por otimismo.

**O que fazer.**

1. Antes de uma missão longa com fornecedor novo, faça um smoke de **uma task**
   (`requireReview: false`, `maxAttempts: 1`). Custa segundos e descobre o que a sonda não
   descobre.
2. Se o despacho falhar por limite de uso, a task vai acumular tentativas à toa. Pare o run
   (`agentic mission stop --actor <você> --reason "sem saldo em <fornecedor>"`) em vez de
   deixar o `maxAttempts` queimar.
3. Retire o fornecedor do `registry` enquanto ele não tiver saldo, ou reduza o
   `maxConcurrent` dele para não competir por vagas com quem funciona.

**Isto muda sem aviso.** O mesmo Codex, sondado em 2026-08-31, respondeu normalmente:

```console
$ codex login status
Logged in using ChatGPT
$ codex exec --sandbox read-only "diga apenas: ok"
codex
ok
tokens used
3.724
```

Ou seja: saldo é estado externo e volátil. Não trate "sem quota" como propriedade fixa de
um fornecedor — nem "com quota".

---

## Operação

### Control plane não encontrado ao pausar

**Sintoma observado.**

```console
$ agentic mission pause --actor ewaldo
erro [NO_CONTROL_PLANE]: Nenhum control plane ativo.
  Suba:    agentic serve
  Depois:  agentic mission pause <run>

nenhum control plane respondendo em http://127.0.0.1:4317 (server do project.yaml).
comando de mutacao nao escreve no banco por fora do orquestrador (I7), entao ele precisa
de um processo publicando HTTP. Duas causas comuns:
  1. nao ha control plane no ar        -> `agentic serve`
  2. ha um run em primeiro plano iniciado com `--no-serve` (ou, numa versao anterior,
     SEM `--serve`): esse modo orquestra mas NAO publica HTTP, entao pause, resume, stop,
     retry, unblock e skip ficam inalcancaveis ate ele terminar (Ctrl+C encerra o run).
     `agentic mission start <arquivo>` ja publica a API por padrao;
     `agentic mission start <arquivo> --serve` ainda mantem o control plane no ar depois
     que o run termina.
```

**Causa.** O control plane é o **único escritor** do estado. Comandos de mutação (`pause`,
`resume`, `stop`, `task retry`, `task unblock`, `task skip`) vão por HTTP local para esse
processo. Sem processo no ar, a CLI recusa — em vez de abrir o banco por fora, que é o que
quebraria o invariante.

Leitura continua funcionando sem processo nenhum: `mission status`, `task inspect`,
`events tail` e `run report` abrem o SQLite em modo leitura.

**O que fazer.** Num segundo terminal, no diretório do projeto:

```sh
agentic serve
```

```console
control plane no ar em http://127.0.0.1:4317
host/porta vem de `server` em /tmp/demo-somador/.agentic/project.yaml
endereco publicado em .agentic/control-plane.json enquanto este processo viver
```

E então, no primeiro terminal, o comando que falhou:

```console
$ agentic mission pause --actor ewaldo --reason "conferir T01 antes de liberar T03"
mission pause enviado para run 01M1BVYAFTS6EY023K931PPVFG via http://127.0.0.1:4317
```

**Para não passar por isso de novo.** Inicie com `agentic mission start <arquivo> --serve`:
o control plane fica no ar mesmo depois que o run termina, e todo comando de mutação
alcança o run. Evite `--no-serve` a menos que você queira mesmo um run incomandável.

O endereço **real** (que pode não ser o do `project.yaml`, se a porta estava ocupada) fica
publicado enquanto o processo vive:

```console
$ cat .agentic/control-plane.json
{ "host": "127.0.0.1", "port": 4317, "pid": 390436, "url": "http://127.0.0.1:4317", "startedAt": "..." }
```

> Detalhe da mensagem: a linha `Depois:` mostra sempre `agentic mission pause <run>`, mesmo
> quando o comando que falhou foi `task unblock`. Leia como "repita o comando que você
> tentou", não como instrução literal.

---

### Run BLOCKED não volta a rodar depois de `task retry`

**Sintoma observado.** Um run terminou `BLOCKED`. Você corrigiu a causa, subiu o control
plane e destravou a task. A task volta para `READY`… e nada acontece. Para sempre.

```console
$ agentic serve &
$ agentic task retry T03 --actor ewaldo --reason "mock removido do registry"
task retry enviado para task T03 do run 01M1BVYAFTS6EY023K931PPVFG via http://127.0.0.1:4317

$ agentic mission status
run 01M1BVYAFTS6EY023K931PPVFG · DEMO-001 · BLOCKED
tasks (3): READY 1 · DONE 2
  T03   READY   2      -
```

As duas saídas sugeridas pela própria mensagem de bloqueio também são recusadas:

```console
$ agentic mission resume --actor ewaldo
erro [CONTROL_PLANE_REFUSED]: transicao nao declarada na maquina run: BLOCKED -> RUNNING via HUMAN_RESUME

$ agentic mission start .agentic/missions/DEMO-001.mission.yaml --actor ewaldo
erro [CONTROL_PLANE_REFUSED]: missao DEMO-001 nao tem run APPROVED: o run 01M1BVYAFTS6EY023K931PPVFG deste spec esta BLOCKED. Aprovar de novo cria um NOVO run do mesmo spec.
```

**Causa.** O laço de orquestração de um run só é ligado pelo START MISSION
(`agentic mission start`, ou o botão no dashboard). Um `agentic serve` que apenas recebeu o
`task retry` registra o destravamento — o evento `task.unblocked` está lá — mas nunca abriu
o laço daquele run, então ninguém despacha a task pronta. `mission resume` não resolve
porque a máquina de estados do run não declara `BLOCKED -> RUNNING` por comando humano: a
saída de `BLOCKED` é derivada, e depende de um tick que não está acontecendo.

**Isto é uma aresta real do produto**, e a mensagem impressa quando o run bloqueia sugere
justamente o caminho que não funciona:

```text
para comanda-lo de novo: `agentic serve` e depois `agentic task unblock`,
`agentic mission resume` ou `agentic mission stop`.
```

**O que fazer.**

- **Destrave antes do run bloquear.** Enquanto o run está `RUNNING` — com outra task ainda
  em voo —, `task unblock` funciona perfeitamente e a task volta a ser despachada:

  ```console
  $ agentic task unblock T01 --actor ewaldo --note "T03 cobre o teste; o glob do lint e decisao consciente"
  task unblock enviado para task T01 do run 01M1BWDXHFSH9JZ7ZRXJNWAYMC via http://127.0.0.1:4317
  $ agentic mission status
  tasks (3): PENDING 1 · RUNNING 1 · REVIEW 1
  ```

  Na prática: mantenha um `agentic events tail --follow` aberto e reaja ao `task.blocked`,
  em vez de descobrir no fim.

- **Se o run já está `BLOCKED`**, encerre e recomece. Nada do que já foi integrado se
  perde — a branch da missão continua lá:

  ```sh
  agentic mission stop --actor <você> --reason "recomeco com a causa corrigida"
  # corrija a causa (registry, gates.yaml, touches, o que for)
  agentic mission approve <arquivo> --actor <você>   # cria um NOVO run
  agentic mission start   <arquivo> --actor <você> --serve
  ```

  Lembre que o novo run reexecuta as tasks — inclusive as que já estavam `DONE` — e isso
  **consome assinatura de novo**. Se o trabalho já integrado for suficiente, considere
  `agentic task skip` no novo run em vez de refazer.

---

### Worktree não é criada e o run fica parado sem erro

**Sintoma observado.** O run entra em `RUNNING`, a task chega a `READY`… e para. Sem falha,
sem bloqueio, sem mensagem. Depois de 200 segundos, o event log tinha **sete** eventos:

```console
$ agentic events tail --limit 30
    5  2026-08-31T12:27:11.432Z  run.started  [human:ewaldo]
    6  2026-08-31T12:27:11.508Z  task.ready T01  [orchestrator]
    7  2026-08-31T12:27:11.510Z  policy.invalid_transition T01  [orchestrator]
```

O detalhe só aparece no payload (`--json`):

```json
{"machine":"task","from":"READY","to":"RUNNING","trigger":"SCHEDULER_DISPATCH",
 "reason":"GUARD_FAILED:workspace-acquired (caminho ja existe na worktree e nao e o link esperado: node_modules)"}
```

**Causa.** `execution.workspaceSetup.link` liga `node_modules` (e o que mais você declarar)
dentro da worktree de cada tentativa — sem isso a worktree nova não tem dependência
instalada e **todo** gate falha. Mas se `node_modules` estiver **rastreado pelo git**, o
`git worktree` já materializa o diretório de verdade nesse caminho; o link não pode ser
criado; a guarda de aquisição de workspace reprova; e nenhuma task em `RUNNING` pode existir
sem workspace válido. O run fica correto e parado ao mesmo tempo.

**O que fazer.** Pare de versionar `node_modules` (é o que se espera de qualquer jeito):

```sh
printf 'node_modules/\n.agentic/state.db\n.agentic/runs/\n.agentic/worktrees/\n.agentic/control-plane.json\n' >> .gitignore
git rm -r --cached node_modules
git commit -m "para de versionar node_modules"
```

Verificado depois da correção — a mesma missão, mesmo projeto, o workspace é adquirido e a
tentativa segue:

```console
    6  2026-08-31T12:27:42.617Z  task.ready T01  [orchestrator]
    7  2026-08-31T12:27:42.620Z  workspace.acquired T01  [orchestrator]
    8  2026-08-31T12:27:42.620Z  attempt.started T01  [orchestrator]
    9  2026-08-31T12:27:42.620Z  task.dispatched T01  [orchestrator]
```

Alternativa, se você **precisa** versionar o diretório: tire-o de `workspaceSetup.link`.

Sintoma parecido, causa diferente: se a worktree é criada mas o gate falha com "módulo não
encontrado", é o contrário — falta declarar o caminho em `workspaceSetup.link`.

---

### Dashboard não carregava em projeto que não fosse o produto

**Status: resolvido nesta missão (DA-PRODUCT-001, task P05).**

**Sintoma observado.** `agentic serve` subia normalmente dentro do repositório do próprio
produto, mas num projeto-alvo qualquer a raiz não servia o dashboard: o control plane
procurava o build da web relativo ao **projeto orquestrado**, que obviamente não tem um.

**Causa.** A resolução do diretório do dashboard só considerava o caminho relativo ao alvo.
A correção passou a resolver, em ordem: o caminho explicitamente pedido pelo chamador, o
dashboard da **instalação do produto**, e só então o caminho relativo ao alvo (que continua
útil quando o alvo é o próprio produto).

**Verificação em 2026-08-31, em projetos-alvo criados do zero em `/tmp`** — nenhum deles é
o repositório do produto:

```console
$ cd /tmp/demo-somador && agentic serve
control plane no ar em http://127.0.0.1:4317

$ curl -s -o /dev/null -w "GET / -> %{http_code} %{content_type}\n" http://127.0.0.1:4317/
GET / -> 200 text/html; charset=utf-8

$ curl -s http://127.0.0.1:4317/ | head -c 120
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=devic

$ curl -s http://127.0.0.1:4317/api/runs/01M1BWDXHFSH9JZ7ZRXJNWAYMC/snapshot | head -c 100
{"run":{"id":"01M1BWDXHFSH9JZ7ZRXJNWAYMC","missionId":"DEMO-001","status":"COMPLETED","timestamps":{
```

**O que fazer se ainda acontecer.** A causa mais provável hoje é outra: **o dashboard nunca
foi construído**. `npm run build` na raiz é `tsc --build` e **não** gera `apps/web/dist` —
o build do dashboard é Vite e roda à parte:

```sh
npm run build -w @agentic/web
ls apps/web/dist/index.html
```

Depois disso, confirme que o `agentic` que você chama é o dessa instalação
(`command -v agentic`). E lembre que, na mesma missão, `attachServer` passou a publicar a
porta **real** em `.agentic/control-plane.json`, em vez da configurada — então
`cat .agentic/control-plane.json` é a fonte confiável do endereço.

### `agentic serve` diz que o control plane já está no ar

**Sintoma.** O segundo terminal não sobe nada:

```console
$ agentic serve
control plane ja no ar em http://127.0.0.1:4317 (pid 12345)
nada a fazer: START MISSION pelo dashboard ou `agentic mission start`.
```

**Isto é o comportamento correto, não uma falha.** Um projeto tem **um** control plane owner
(I14, ADR-0013). O segundo processo descobre o dono e termina com sucesso — abra o endereço
informado, ou use `agentic mission start`, que entrega o START ao dono.

A garantia é por projeto, não por porta:

```console
$ agentic serve --port 4401
control plane ja no ar em http://127.0.0.1:4317 (pid 12345)
este projeto ja tem dono: `--port` nao cria um segundo control plane.
```

Isso é deliberado. Antes, `--port` criava um segundo control plane sobre o **mesmo**
`state.db`: os dois adotavam o mesmo run, disputavam a mesma worktree e o trabalho de um deles
era descartado sem aviso.

Projetos diferentes continuam podendo rodar ao mesmo tempo — a chave é o diretório do
projeto, resolvido com `realpath` (então um link simbólico para o mesmo repositório também
não cria um segundo dono).

**Se o dono não existe mais.** Não existe lock a limpar: a posse morre com o processo,
inclusive sob `kill -9` ou queda de energia. Se o `serve` insiste que há dono, existe um
processo vivo — encontre-o pelo pid que a mensagem informa:

```sh
cat .agentic/control-plane.json     # endereco e pid do dono
ps -p "$(node -e "console.log(require('./.agentic/control-plane.json').pid)")"
```

`.agentic/control-plane.lock.db` é um arquivo de zero byte e **não guarda estado nenhum** —
apagá-lo não libera nada enquanto o dono vive, e não é o caminho para resolver problema algum.

---

### Ctrl+C demora, ou o control plane diz que não encerrou limpo

**Sintoma.** Depois do Ctrl+C, `agentic serve` leva alguns segundos para sair — ou termina
com:

```console
o control plane nao encerrou limpo:
run 01M1...: encerramento excedeu 30000ms com efeito ainda em voo (2 efeito(s)
assincrono(s); tentativas T03-a2-...); a posse do projeto NAO e devolvida enquanto isso durar (I15)
```

**A demora é o encerramento gracioso fazendo o trabalho dele** (ADR-0014). Ele para de
atender, cancela os processos de agente e de gate (SIGTERM, e SIGKILL dois segundos depois
se ignorarem — e o que sobrar no grupo de processos deles recebe SIGKILL junto), espera uma
integração em curso terminar, grava o que já chegou e só então devolve o projeto. Um agente
que ignora SIGTERM custa esses dois segundos; um `git rebase` em andamento custa o tempo
dele.

**A mensagem de "não encerrou limpo" é rara e é honesta.** Algum efeito não parou dentro do
prazo, e o control plane preferiu **segurar a posse** a entregar o projeto com efeito vivo —
que era o dano medido em D4. O processo sai logo depois, e o sistema operacional solta o lock
no mesmo instante; o próximo `agentic serve` adota o run e reconcilia a tentativa que ficou
em voo como `INTERRUPTED`. Nada precisa ser limpo à mão. Se acontecer com frequência, o
detalhe da mensagem diz qual efeito não parou — é isso que vale relatar.

**A mensagem de "não encerrou limpo" não encerra o processo.** Ele fica no ar, dono do
projeto, e o próximo Ctrl+C tenta o encerramento outra vez — sair soltaria a posse com o
efeito vivo, que é o que a regra proíbe. Quando o efeito termina (a integração acaba, o gate
morre), o Ctrl+C seguinte devolve o projeto e o processo sai.

**Um segundo Ctrl+C durante o encerramento não mata o processo.** Ele é registrado (a CLI
avisa em stderr) e, se o encerramento em curso falhar, dispara a nova tentativa sozinho. Isso
é deliberado: o tratador padrão do Node mataria o processo no meio da drenagem e a posse
sairia com efeito vivo.

**Derrubar à força é `kill -9`.** Nada é drenado, a posse morre com o processo e um comando
de gate ou de `workspaceSetup` que estava rodando fica órfão até terminar sozinho — sem
alcançar o banco. Funciona, mas é queda, não encerramento; o próximo `agentic serve` adota
o run e reconcilia.

---

## Missão e execução

### Missão com WARNING: o que significa aceitar

**Sintoma observado.** A missão compila (`0 ERROR`), mas `start` recusa:

```console
$ agentic mission start .agentic/missions/DEMO-002.mission.yaml --actor ewaldo
  DA2001  WARNING  T01            T01 e T02 podem rodar juntas e escrevem no mesmo escopo (src/ × src/) [T02] (linha 28, coluna 14)
          separe os escopos ou declare dependencia entre as duas tasks
  DA2005  WARNING  T01            task T01 declara src/, um diretorio de topo inteiro [src/] (linha 28, coluna 14)
          aponte para o subdiretorio realmente alterado
  DA2005  WARNING  T02            task T02 declara src/, um diretorio de topo inteiro [src/] (linha 39, coluna 14)
          aponte para o subdiretorio realmente alterado
  DA2006  WARNING  T01            task T01 nao tem dependentes e nao e coberta pelo mission gate (linha 23, coluna 5)
          ligue a task ao restante do plano ou cubra-a pelo mission gate
  DA2006  WARNING  T02            task T02 nao tem dependentes e nao e coberta pelo mission gate (linha 34, coluna 5)
          ligue a task ao restante do plano ou cubra-a pelo mission gate
  DA2008  WARNING  T01            1 task(s) exigem cross-provider-required e o projeto tem 1 provider(s) apto(s) a revisar (linha 23, coluna 5)
          declare um segundo provider apto a revisar no registry
erro [WARNINGS_NOT_ACCEPTED]: 6 WARNING pendente(s): a partida exige --accept-warnings
```

**Causa.** `WARNING` não é erro de forma: o plano é executável. É um risco que o compilador
sabe nomear e que só uma pessoa pode assumir. Por isso a partida exige o aceite explícito,
e o aceite fica **registrado no run** (`warnings aceitos: sim`) — não é um flag que some.

**O catálogo de WARNING, e o risco que cada um representa.** Os quatro códigos do exemplo
acima estão marcados com × (`DA2005` e `DA2006` apareceram duas vezes cada, uma por task):

| Código | O risco que você está assumindo | No exemplo |
| --- | --- | --- |
| `DA2001` | duas tasks podem rodar juntas e escrever no mesmo escopo — na prática, uma vai esperar pelo lock ou reprovar por escopo | × |
| `DA2002` | conclusão não verificável: a task não declara `validation` nem `gate` | |
| `DA2003` | task grande demais para uma tentativa | |
| `DA2004` | fragmentação excessiva: cadeia de tasks pequenas demais | |
| `DA2005` | `touches` é um diretório de topo inteiro: quase nada será considerado fora do escopo, e a proteção que o `touches` dá some | × |
| `DA2006` | trabalho órfão: a task não tem dependentes e não é coberta pelo mission gate; nada valida a integração dela | × |
| `DA2007` | task de risco alto sem revisão | |
| `DA2008` | há task exigindo revisão cruzada e só um fornecedor apto a revisar | × |

**O que fazer.**

- **O caminho normal é corrigir**, não aceitar. `DA2001` e `DA2005` costumam se resolver
  com um `touches` mais preciso (arquivo em vez de diretório); `DA2006`, ligando a task a
  um dependente ou ao mission gate.
- **Aceitar conscientemente é legítimo** quando você sabe por quê. Caso real (missão de
  smoke com fornecedor real): a missão foi reduzida a uma task para economizar quota, o
  `DA2006` avisou que ela não seria coberta, e o aviso foi aceito de propósito. O run
  terminou `FAILED` — corretamente, porque o mission gate reprovou mesmo com 1/1 task
  `DONE`. O produto recusou-se a declarar a missão completa.

  ```sh
  agentic mission start <arquivo> --actor <você> --accept-warnings
  ```

- **`DA2008` é diferente dos outros.** Ele avisa que a política `cross-provider-required`
  não terá com quem ser satisfeita. Aceitar não a rebaixa: a task de risco alto vai
  **bloquear** na hora da revisão. Isso é o comportamento correto — política de revisão
  cruzada nunca é rebaixada em silêncio. `cross-provider-preferred`, sim, é rebaixada — e
  o rebaixamento aparece no `task inspect`:

  ```console
  revisao
    politica      cross-provider-preferred downgraded
    veredito      PASS
  ```

---

### SCOPE_VIOLATION: escopo é contrato

**Sintoma.** A tentativa reprova com `SCOPE_VIOLATION` com o código bom — e sem nenhuma
linha de gate na evidência: a checagem de escopo acontece na observação da tentativa,
**antes** do gate, que nem chega a rodar.

> **Honestidade sobre esta entrada.** Ao contrário das outras desta página, a reprovação
> em si **não foi reproduzida** na rodada de 2026-08-31: na tentativa em que a task foi
> escrita de propósito para forçar escrita fora do escopo, o agente **recusou-se** a sair
> do `touches` (ver abaixo). O que está documentado aqui é a regra do produto e o que foi
> observado ao redor dela.

**Causa.** `touches` é o escopo de **escrita** declarado da task. O control plane não
confina o agente por sandbox de sistema de arquivos: ele o contém na worktree da tentativa
e **verifica por diff, depois**, quais caminhos foram tocados. Caminho fora de `touches`
entra em `outOfScopePaths` na observação da tentativa e reprova — independentemente da
qualidade do código.

Não é rigor decorativo: é o que permite duas tasks rodarem em paralelo sem se
sobrescreverem, e é o que impede que uma task "aproveite a viagem" e mexa em algo que outra
task, outro revisor ou outro humano estava responsável por.

**O que fazer.** Decida qual dos dois está errado:

- **O `touches` está errado** (o mais comum): a task realmente precisa daquele caminho.
  Corrija o `mission.yaml`, recompile e reaprove. Corrigir o escopo é a resposta certa —
  contorná-lo, não.
- **A task está errada**: o trabalho extra é de outra task. Deixe fora e crie/ajuste a task
  que tem o escopo.

**O agente também vê o contrato.** Numa execução real de 2026-08-31, a task pedia dois
arquivos mas declarava só um em `touches`. O agente escreveu o que estava no escopo,
recusou o resto e explicou no log em vez de "resolver" por conta própria:

```text
Não criei `src/raiz.js`: ele está fora do escopo de escrita permitido (`touches` lista
apenas `src/potencia.js`). Se `raiz` faz parte da entrega esperada, o escopo da task
precisa incluir esse caminho ou ele deve ir para uma task separada.
```

A tentativa passou (o que estava no escopo foi feito e o gate saiu 0), e o **relatório do
agente** é onde ficou registrado que a definição da task estava incompleta. Repare que quem
descobriu o problema de plano não foi um erro do produto: foi o produto funcionando.

**Onde olhar.** `agentic task inspect <T>` mostra a seção `escopo` com `touches`, `reads` e
`fora do escopo`; e `fatos → diff` com o que realmente mudou. Em `--json`, o evento
`attempt.observed` traz `filesChanged` e `outOfScopePaths`.

Antes de culpar o agente, confira se o que entrou no diff é ruído de workspace — arquivo
gerado, link de setup, artefato de build que o `.gitignore` do projeto não cobre. O diff é
medido sobre a worktree inteira; o que o `.gitignore` não exclui, entra. O sintoma vizinho
está em [worktree](#worktree-não-é-criada-e-o-run-fica-parado-sem-erro).

---

### Gate reprovando e onde ler a evidência

**Sintoma observado.**

```console
$ agentic task inspect T01
qualidade
  gate          estrito FAIL
  validacao     node --check sai 0
  comando       npm run lint (exit 0) em /tmp/scope-proj/.agentic/worktrees/01M1BWNC1ZT07MYXHYY360E1TR/T01-a1
  comando       node -e "require('node:assert').ok(require('node:fs').existsSync('src/raiz.js'), 'src/raiz.js ausente')" (exit 1) em /tmp/scope-proj/.agentic/worktrees/01M1BWNC1ZT07MYXHYY360E1TR/T01-a1

fatos
  diff          1 arquivos +1 -0

falha: GATE_FAILED gate estrito terminou FAIL

bloqueio: [ATTEMPTS_EXHAUSTED] GATE_FAILED: gate estrito terminou FAIL — precisa: decisao humana: ajustar a task, destravar ou pular (tentativas 1/1)
```

**Causa.** Um comando do perfil de gate saiu com código diferente de 0, na worktree da
tentativa. `GATE_FAILED` significa que o gate **rodou e reprovou** — não que ele quebrou.

**O que fazer. A evidência é reproduzível, e essa é a graça.** `agentic run report --md`
entrega cada execução de comando já no formato de colar no terminal:

````markdown
## Evidencia citavel

- T01 · estrito · exit 0
  ```sh
  cd /tmp/scope-proj/.agentic/worktrees/01M1BWNC1ZT07MYXHYY360E1TR/T01-a1 && npm run lint
  ```
- T01 · estrito · exit 1
  ```sh
  cd /tmp/scope-proj/.agentic/worktrees/01M1BWNC1ZT07MYXHYY360E1TR/T01-a1 && node -e "require('node:assert').ok(require('node:fs').existsSync('src/raiz.js'), 'src/raiz.js ausente')"
  ```
````

Colando a segunda linha, o mesmo resultado:

```console
$ cd /tmp/scope-proj/.agentic/worktrees/01M1BWNC1ZT07MYXHYY360E1TR/T01-a1 && node -e "..."
AssertionError [ERR_ASSERTION]: src/raiz.js ausente
```

**Onde ficam os artefatos.** Cada tentativa guarda a saída bruta de cada comando de gate,
mais o diff e o log do agente:

```console
$ ls .agentic/runs/<run>/attempts/T01-a1/
agent.log.jsonl        # relato do agente (nunca decide)
gate-estrito-0.stdout  # saída do comando 0 do perfil
gate-estrito-1.stderr  # saída do comando 1 — o que reprovou
patch.diff             # o diff medido pelo control plane
```

Depois de entender: corrija a task (novo `objective`, novo `touches`, gate mais realista) e
`agentic task retry`, ou `agentic task skip --reason` se a task não vai acontecer. E lembre
que a worktree **continua no disco**: `code <worktree>` abre exatamente o estado que
reprovou.

---

### Gate com ERROR e "exit sem codigo"

**Sintoma observado.** O gate não reprova — ele **erra**, e o resumo não diz por quê:

```console
qualidade
  gate          unit ERROR
  comando       npm run lint && npm run test (exit sem codigo) em /tmp/sh-proj/.agentic/worktrees/.../T01-a1

falha: GATE_FAILED gate unit terminou ERROR
```

```console
$ agentic run report
evidencia citavel
  T01 · unit · exit sem codigo · npm run lint && npm run test
```

**Causa.** O comando nem chegou a rodar. O control plane executa cada linha de gate **sem
shell**, com as regras de aspas do POSIX, mas sem interpretar operadores: fora de aspas,
`|`, `&`, `;`, `<`, `>`, `` ` ``, `$`, `(` e `)` são **recusados** na análise da linha.
Curingas (`*`) não são recusados, mas também não são expandidos — chegam ao processo como
texto. `exit sem codigo` (`exitCode: null`) é a assinatura desse caso: `FAIL` é gate que
reprovou, `ERROR` é gate que não conseguiu rodar.

O motivo literal está no artefato de stderr da tentativa:

```console
$ cat .agentic/runs/<run>/attempts/T01-a1/gate-unit-0.stderr
GATE_COMMAND_SYNTAX: comando de gate invalido: operador de shell "&" fora de aspas; use sh -c '...'
```

**O que fazer.** Duas formas, ambas verificadas:

```yaml
profiles:
  unit:
    commands:
      - run: npm run lint          # preferível: um comando por linha
      - run: npm run test
```

```yaml
profiles:
  unit:
    commands:
      - run: sh -c 'npm run lint && npm run test'   # quando você quer mesmo o shell
```

Com `sh -c`, o mesmo projeto passou:

```console
qualidade
  gate          unit PASS
  comando       sh -c 'npm run lint && npm run test' (exit 0) em /tmp/sh-proj/.agentic/worktrees/.../T01-a1
```

`npm run verify` continua valendo mesmo que o script contenha `&&`: quem interpreta o `&&`
é o npm, dentro do processo dele — a linha do gate é só `npm run verify`.

---

### NO_CHANGES: quando é falha e quando é acerto

**Sintoma observado.** A tentativa termina sem alterar arquivo nenhum, e o control plane
reprova mesmo com o agente relatando sucesso:

```console
$ agentic task inspect T01
fatos
  diff          0 arquivos +0 -0

falha: NO_CHANGES a tentativa nao alterou nenhum arquivo

bloqueio: [ATTEMPTS_EXHAUSTED] NO_CHANGES: a tentativa nao alterou nenhum arquivo — precisa: decisao humana: ajustar a task, destravar ou pular (tentativas 3/3)
```

**Causa (e a distinção que importa).** `NO_CHANGES` é sempre a mesma medição — diff vazio —
mas tem duas origens completamente diferentes:

**1. O agente não trabalhou.** É o que acontece, por construção, com o provider `mock`: ele
é in-process, determinístico e **não escreve arquivo**. Rodar uma missão real com
`providers.default: mock` termina assim, sempre, e isso é o ensaio funcionando: prova que o
DAG dispara, que as worktrees são criadas e que o relato do agente não decide. O mock
relatou `completed`; o produto mediu zero e reprovou.

**2. O agente investigou e concluiu que não havia o que fazer — e estava certo.** Caso real
(missão DA-DOGFOOD-001, T02, 2026-08-30). O log do agente:

> *"Nenhuma alteração entregue: `apps/cli/src/redact.ts` já importa `redactSecrets` de
> `@agentic/process` e não contém cópia — a duplicação real é
> `packages/orchestrator/src/engine/redact.ts`, fora do escopo."*

**O agente estava certo e a definição da task estava errada.** A premissa era falsa, e o
caminho que precisava de trabalho não estava em `touches`. O agente (a) investigou,
(b) recusou-se a inventar trabalho fora do escopo declarado, (c) recomendou a correção do
plano — e o produto registrou `NO_CHANGES` em vez de fingir sucesso.

**Como distinguir na prática.** O tamanho do log do agente resolve na primeira olhada (o
comentário à direita é anotação desta página, não saída do comando):

```console
$ agentic task inspect T01
log do agente
  agent-log  runs/.../attempts/T01-a1/agent.log.jsonl  0 bytes  sha256:e3b0c442...   # mock: nada a dizer
```

```console
log do agente
  agent-log  runs/.../attempts/T02-a1/agent.log.jsonl  1019 bytes  sha256:df4bcc92... # leia
```

Log vazio (`0 bytes`, digest do vazio `e3b0c442...`) = não houve narrativa; provavelmente é
o mock, ou um agente que morreu antes de falar. Log com conteúdo = **leia antes de mandar
retry**, porque a resposta costuma estar lá.

**O que fazer.**

- Log vazio e provider `mock`: esperado. Troque o provider para trabalho real.
- Log com conteúdo: leia. Se o agente apontou que a premissa da task é falsa, **corrija a
  task** — `agentic task retry` vai falhar identicamente e queimar quota. Foi exatamente a
  decisão tomada no caso real: o run foi encerrado após a segunda tentativa, porque a causa
  era a definição da task, não o agente.
- Se o trabalho realmente já estava feito, `agentic task skip <T> --reason "<por quê>"`.

---

### Revisor não emitiu veredito (AGENT_ERROR)

**Sintoma observado.** A task executa bem, o gate passa — e a tentativa termina em `ERROR`,
duas vezes, até esgotar o orçamento:

```console
$ agentic task inspect T03
qualidade
  gate          mission PASS
  comando       npm run verify (exit 0) em .../T03-a2

fatos
  diff          1 arquivos +24 -0

falha: AGENT_ERROR revisor nao emitiu veredito; revisao nao concluiu

bloqueio: [ATTEMPTS_EXHAUSTED] AGENT_ERROR: revisor nao emitiu veredito; revisao nao concluiu — precisa: decisao humana: ajustar a task, destravar ou pular (tentativas 2/2)

log do agente
  agent-log   runs/.../attempts/T03-a2/agent.log.jsonl   300 bytes  sha256:d016e75a...
  review-log  runs/.../attempts/T03-a2/review.log.jsonl  0 bytes    sha256:e3b0c442...
```

O `review-log` com **0 bytes** é a pista: ninguém revisou.

**Causa.** O evento diz quem foi escolhido como revisor:

```json
{"policy":"cross-provider-preferred",
 "reviewer":{"profileId":"mock.reviewer","providerId":"mock", ...}}
```

O projeto tinha `mock` no `registry` com `roles: [executor, reviewer]`. A task era de risco
médio, cuja política é `cross-provider-preferred`: o scheduler procura um revisor de
**outro** fornecedor — e o `mock` se qualifica, porque ele é, de fato, outro fornecedor. O
`mock` é determinístico e não emite veredito, então a revisão nunca conclui.

**O que fazer.** Não deixe o `mock` disponível como revisor num projeto real:

```yaml
providers:
  default: claude-code
  registry:
    claude-code:
      kind: local-cli
      command: claude
      versionArgs: ["--version"]
      maxConcurrent: 2
      roles: [executor, reviewer]
    # sem `mock` aqui. Se você quiser mantê-lo para ensaios, use um project.yaml separado.
```

Cuidado com o padrão: **`roles` omitido vale por `[executor, reviewer]`**. Declarar

```yaml
    mock:
      kind: inprocess
      maxConcurrent: 4
```

deixa o mock apto a revisar do mesmo jeito.

Depois de retirar o `mock`, a mesma missão rodou até `COMPLETED`, com a revisão indo para
uma sessão nova do fornecedor real e o rebaixamento registrado:

```console
revisao
  revisor       claude-code.reviewer
  fornecedor    claude-code
  politica      cross-provider-preferred downgraded
  veredito      PASS
```

> Se você corrigir o `registry` **depois** de o run ter bloqueado, veja
> [Run BLOCKED não volta a rodar](#run-blocked-não-volta-a-rodar-depois-de-task-retry):
> o caminho é `mission stop` e um run novo.

---

## Arestas conhecidas da CLI

Coisas observadas nesta missão que não impedem o trabalho, mas assustam quem não sabe.
Nenhuma delas perde dado: o estado está no banco e nos artefatos da tentativa.

**`mission status | head` explode com EPIPE.** Qualquer pipe que fecha cedo (`head`, `less`
com `q`) derruba o comando com stack trace do Node:

```console
$ agentic mission status | head -1
run 01M1BWNC1ZT07MYXHYY360E1TR · GATE-001 · BLOCKED
node:events:487
      throw er; // Unhandled 'error' event
Error: write EPIPE
    ...
```

É uma corrida, não uma certeza: em 15 execuções seguidas do mesmo comando, 13 explodiram e
2 saíram limpas — depende de o processo ainda estar escrevendo quando o leitor fecha o
pipe. O stack trace vai para o **stderr**, então `agentic mission status 2>&1 | head -1` o
esconde (o `head` já fechou o pipe) e dá a falsa impressão de que não acontece.

O que a saída mostrou antes do erro está correto. Para filtrar sem susto, use `--json` com
um processador que consome tudo, ou redirecione para arquivo e filtre depois:

```console
$ agentic mission status --json | jq -r '.data.tasks[] | "\(.id) \(.status)"'
T01 DONE
T02 DONE
T03 DONE
```

**`events tail --follow` sai com código 13 ao interromper.** Ctrl+C encerra o `--follow`,
mas o processo imprime um aviso do Node e não sai com 0:

```console
$ agentic events tail --since 30 --follow
   ...
   77  2026-08-31T12:28:24.054Z  workspace.released T01  [orchestrator]
^C
Warning: Detected unsettled top-level await at .../apps/cli/bin/agentic.mjs:8
$ echo $?
13
```

Nada foi perdido — o log é append-only e já está gravado. Só não interprete o `$?` de um
`--follow` interrompido como sinal de falha do run.

**Duração pode sair como `3m60s`.** O arredondamento dos segundos pode chegar a 60 em vez
de virar o minuto:

```console
  T03   CANCELLED  2      3m60s
```

Leia como "4m0s". A duração exata está nos timestamps dos eventos (`events tail --json`).

**`mission gate: nao declarado` nem sempre quer dizer isso.** No `run report`, essa linha
aparece quando o mission gate **não chegou a executar** — inclusive quando a missão declara
`missionGate:` normalmente. Num run que terminou `BLOCKED` ou `CANCELLED`, leia como "não
executou". Quando ele executa, a linha vira `mission gate: mission PASS`.

---

## Não achou seu caso aqui?

Isso é proposital: esta página só registra o que foi observado. Antes de concluir que é
defeito do produto, junte a evidência que o próprio produto guarda:

```sh
agentic doctor                       # o ambiente ainda é o que você pensa que é?
agentic mission status               # em que estado o run e as tasks estão
agentic task inspect <T>             # escopo, gate, revisão, worktree, log do agente
agentic events tail --json           # a sequência exata, com quem agiu em cada passo
agentic run report --md              # evidência citável, com o comando reproduzível
ls .agentic/runs/<run>/attempts/<T-aN>/   # diff, saída de cada gate, logs
```

Um relato útil tem: a saída do `doctor`, o `runId`, o `task inspect` da task afetada e a
linha do event log onde o comportamento diverge do esperado.
