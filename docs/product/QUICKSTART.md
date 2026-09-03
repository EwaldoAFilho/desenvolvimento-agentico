# QUICKSTART — do zero a uma missão executada

> **Regra deste documento:** toda saída em bloco foi copiada de uma execução real, feita
> em 2026-08-31 num projeto-alvo criado do zero (`/tmp/demo-somador`). Nada aqui é
> exemplo hipotético. Onde a saída real contraria o que seria "bonito documentar", o
> documento cede — o produto é a fonte. As únicas edições nas saídas são elisões marcadas
> com `...`: caminhos de `$HOME` e blocos repetitivos.

Para entender **por que** o produto existe, leia [VISION.md](VISION.md). Este guia é sobre
**usar**: em cerca de 20 minutos você sai de um repositório qualquer para uma missão
executada por agentes, com evidência gravada.

Índice:

1. [Requisitos](#1-requisitos)
2. [Instalar e compilar](#2-instalar-e-compilar)
3. [`agentic doctor`: antes de gastar tempo de agente](#3-agentic-doctor-antes-de-gastar-tempo-de-agente)
4. [`agentic init` no seu projeto](#4-agentic-init-no-seu-projeto)
5. [Escrever, validar e compilar a missão](#5-escrever-validar-e-compilar-a-missão)
6. [Ensaio grátis com o provider `mock`](#6-ensaio-grátis-com-o-provider-mock)
7. [Aprovar e iniciar (aqui começa a gastar assinatura)](#7-aprovar-e-iniciar-aqui-começa-a-gastar-assinatura)
8. [`agentic serve` e o dashboard](#8-agentic-serve-e-o-dashboard)
9. [Acompanhar: status, task inspect, events tail](#9-acompanhar-status-task-inspect-events-tail)
10. [Pausar e retomar](#10-pausar-e-retomar)
11. [Quando uma task trava](#11-quando-uma-task-trava)
12. [Relatório final e onde foi parar o código](#12-relatório-final-e-onde-foi-parar-o-código)
13. [O que você precisa saber para não se surpreender](#13-o-que-você-precisa-saber-para-não-se-surpreender)

---

## 1. Requisitos

| Item | Como conferir | Por que é obrigatório |
| --- | --- | --- |
| **Node >= 22** | `node --version` | o control plane persiste estado em SQLite com **módulo nativo** (`better-sqlite3`). Módulo nativo é compilado contra o ABI de uma versão de Node (`NODE_MODULE_VERSION`); rodar em outra versão não degrada — quebra |
| **git** | `git --version` | cada tentativa roda numa **git worktree** própria. Sem git, só o modo `shared`, sequencial |
| **Uma CLI de agente instalada e autenticada** | seção 3 | o produto é *subscription-first*: ele executa a CLI que **você** já instalou e autenticou. Nenhuma API key é lida, pedida, guardada ou injetada |
| **O projeto-alvo é um repositório git** | `git -C <projeto> rev-parse --git-dir` | isolamento por worktree e diff medido pelo control plane |
| **Os quality gates do projeto já funcionam como comandos de shell** | rode-os no terminal | o control plane **executa** seus gates, não os substitui. Gate que não passa na sua mão não vai passar na dele |

Linguagem, framework, gerenciador de pacotes e CI são irrelevantes: a fronteira é sempre
**comandos e git**.

### Por que Node 22+ é levado a sério

Com Node 20 o próprio `npm install` recusa antes de instalar (o repositório declara
`engine-strict=true`):

```console
$ npm install
npm error code EBADENGINE
npm error engine Unsupported engine
npm error engine Not compatible with your version of node/npm: desenvolvimento-agentico@0.1.0
npm error notsup Not compatible with your version of node/npm: desenvolvimento-agentico@0.1.0
npm error notsup Required: {"node":">=22"}
npm error notsup Actual:   {"npm":"10.8.2","node":"v20.18.1"}
```

Essa recusa é intencional: sem ela, a instalação compila o módulo nativo contra o ABI
errado e o erro só aparece **depois**, como `NODE_MODULE_VERSION` em centenas de lugares.
Ver [TROUBLESHOOTING.md](TROUBLESHOOTING.md#node-incompatível-node_module_version).

---

## 2. Instalar e compilar

Na raiz do produto:

```sh
npm install
npm run build                    # control plane e CLI (tsc)
npm run build -w @agentic/web    # dashboard (vite) — o build acima não faz este
npm link                         # deixa `agentic` no PATH
agentic --version
```

Os **dois** builds são necessários: `npm run build` é `tsc --build` e compila o control
plane, a CLI e o servidor; o dashboard é Vite e sai em `apps/web/dist`, que é o que
`agentic serve` publica na raiz. Sem o segundo, a API funciona e a página `/` não.
`npm link` é reversível com `npm unlink -g desenvolvimento-agentico`.

```console
$ agentic --version
0.1.0
```

`npm link` é opcional. Sem ele, use o entrypoint direto — é exatamente o mesmo programa:

```sh
node /caminho/para/o/produto/apps/cli/bin/agentic.mjs --version
```

O mapa dos comandos:

```console
$ agentic --help
Usage: agentic [options] [command]

Control plane para engenharia de software agentica

Options:
  -v, --version         mostra a versao
  -h, --help            display help for command

Commands:
  init [options] [dir]  cria .agentic/ com project.yaml, gates.yaml e uma missao
                        de exemplo
  mission               ciclo de vida de uma missao
  serve [options]       sobe o control plane sem run ativo
  task                  operacao sobre uma task do run
  run                   consultas sobre um run
  events                log append-only do run
  providers [options]   instalado / pronto / versao / em uso / capacidade por
                        fornecedor
  doctor [options]      diagnostico do ambiente: node, git, workspace e
                        fornecedores
  help [command]        display help for command
```

Todo comando aceita `--json` (contrato estável, bom para script) e `-C, --project <dir>`
(por padrão o CLI procura `.agentic/` subindo a partir do diretório atual).

---

## 3. `agentic doctor`: antes de gastar tempo de agente

`doctor` é a primeira coisa a rodar em ambiente novo. Ele não adivinha nada: cada linha é
uma medição.

```console
$ agentic doctor
doctor · /tmp/demo-somador

  ok       versao do Node                     node 24.18.1
  ok       arquivos do projeto                /tmp/demo-somador/.agentic/project.yaml e /tmp/demo-somador/.agentic/gates.yaml validos
  ok       git disponivel                     git version 2.53.0
  ok       repositorio git valido             /tmp/demo-somador e um repositorio git
  ok       workspace x paralelismo            workspace: git-worktree com maxParallelTasks: 2
  ok       capacidade somada dos fornecedores capacidade somada 6 · teto global 2
  ok       agentes em voo                     0 em voo segundo o estado persistido
  ok       fornecedor claude-code             READY · executavel em /home/.../claude; versao via `claude --version`; sonda `claude auth status` saiu 0 e declarou sessao autenticada
  ok       fornecedor mock                    READY · agente in-process; prontidao true

fornecedores

  claude-code  READY
    instalado      sim
    executavel     claude
    caminho        /home/.../claude
    versao         2.1.220
    pronto         sim · origem: sonda `claude auth status` saiu 0 e declarou sessao autenticada
    em voo         0 · capacidade 2
    detalhe        executavel em /home/.../claude; versao via `claude --version`; sonda `claude auth status` saiu 0 e declarou sessao autenticada

  FORNECEDOR   ESTADO  INSTALADO  PRONTO  VERSAO             EM VOO  CAPACIDADE
  claude-code  READY   sim        sim     2.1.220            0       2
  mock         READY   sim        sim     1.0.0-mock         0       4

`unknown` significa que nao foi possivel apurar — nunca conte como pronto.
INSTALLED = instalado com prontidao nao apurada; READY exige sonda de sessao que aprovou.
```

Sai **0** quando não há nenhum `ERRO`; sai **1** se houver.

### Como ler o estado de um fornecedor

São cinco estados, e eles não se confundem:

| Estado | Significa | O que fazer |
| --- | --- | --- |
| `READY` | executável encontrado **e** uma sonda de sessão saiu 0 | pode despachar |
| `INSTALLED` | executável encontrado, prontidão **não apurada** (a CLI não oferece sonda confiável) | não é falha e não é `READY`; siga sabendo que a primeira tentativa é o teste real |
| `NOT_READY` | existe, mas a sonda de sessão **reprovou** | autentique na própria CLI (`<cli> login`), não aqui |
| `NOT_INSTALLED` | não há executável | instale, ou aponte `command` para o caminho absoluto |
| `UNKNOWN` | **a própria instalação não pôde ser apurada** | investigue antes de continuar — nunca conte como pronto |

A distinção que mais economiza tempo: **`--version` respondendo prova instalação, jamais
sessão.** `READY` só sai de uma sonda de sessão que efetivamente saiu 0. E `unknown` nunca
vira aprovação: se não foi possível medir, o doctor diz que não mediu.

`unknown` também aparece fora dos fornecedores. Exemplo real, rodando a CLI com Node 20:

```console
  ERRO     versao do Node                     node 20.18.1: o control plane exige >= 22
  ...
  unknown  agentes em voo                     nao apurado: The module '.../better_sqlite3.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION 137. This version of Node.js requires
NODE_MODULE_VERSION 115. ...
```

O número de agentes em voo sai do **banco**, não da memória deste processo. Se o banco não
pode ser lido, a resposta honesta é `unknown` — não `0`.

Um fornecedor quebrado sai daqui com o conserto na tela:

```console
  ERRO     fornecedor claude-code             NOT_INSTALLED · instalacao: "/tmp/fakebin/claude" e um symlink quebrado: ...
    diagnostico    [broken-symlink] "/tmp/fakebin/claude" e um symlink quebrado: /tmp/fakebin/claude aponta para /opt/nao-existe/claude-2.1.220/cli.js, que nao existe
    alvo           /opt/nao-existe/claude-2.1.220/cli.js (nao existe)
    conserto       recrie o link para uma instalacao existente (`ln -sfn <caminho-real> /tmp/fakebin/claude`) ou reinstale a CLI
```

`agentic providers` mostra o mesmo recorte, só dos fornecedores.

---

## 4. `agentic init` no seu projeto

O projeto-alvo desta demonstração é um pacote Node minúsculo, com gates que já funcionavam
antes do control plane existir:

```sh
mkdir -p /tmp/demo-somador/src /tmp/demo-somador/test && cd /tmp/demo-somador
# package.json com: lint = node --check src/soma.js
#                   test = node --test test/*.test.js
#                   verify = npm run lint && npm run test
git init -q . && git add -A && git commit -qm "projeto inicial"
```

```console
$ npm run verify
...
> lint
> node --check src/soma.js
> test
> node --test test/*.test.js
✔ soma dois numeros (0.409024ms)
ℹ pass 1
ℹ fail 0
...
```

Então:

```console
$ agentic init .
projeto agentico em /tmp/demo-somador/.agentic

  criado      .agentic/project.yaml
  criado      .agentic/gates.yaml
  criado      .agentic/missions/EXEMPLO-001.mission.yaml
  gitignore   7 padrao(oes) de estado local acrescentado(s)

gates
  unit: npm run lint, npm run test
  mission: npm run verify

fornecedores
  claude-code: READY — sessao ativa
  codex: NOT_INSTALLED — executavel nao encontrado no PATH

executor padrao: claude-code

proximo passo: agentic mission validate .agentic/missions/EXEMPLO-001.mission.yaml
```

O `init` **observa antes de escrever**. Ele não presume nem os comandos do seu projeto nem
os fornecedores da sua máquina:

- `project.yaml` — políticas de execução, fornecedores, paralelismo, `denyPaths`, porta do
  servidor. O `project.name` vem do nome da pasta, e o `registry` traz **só as CLIs que a
  sonda observou `READY`** — a primeira delas vira `providers.default`;
- `gates.yaml` — **os comandos do seu projeto**, lidos dos `scripts` do `package.json`
  (`lint`, `typecheck`, `test`, `build`, `verify`). Script que você não tem não vira gate;
- `missions/*.mission.yaml` — a entrega declarada.

Os três são versionados no **seu** repositório. O que o `init` mantém fora do Git — e
acrescenta ao seu `.gitignore`, sem tocar no que já estava lá — é o estado local:
`state.db*`, `runs/`, `worktrees/`, `control-plane.json` e o lock de posse. Isso não é
higiene: o observador do repositório hasheia todo arquivo não rastreado, e sem essas
exclusões o planejamento é recusado com `PLANNER_FAILED: o repositorio mudou durante o
planejamento`.

Rodar `agentic init` de novo é seguro: arquivo que já existe é preservado, e o `.gitignore`
só recebe o padrão que faltava.

### Se nenhuma CLI estiver pronta

O `init` **não finge** que o projeto está executável. Ele escreve o registry com o agente de
**ensaio** (`mock`) e diz, com todas as letras, o que falta:

```console
ATENCAO: nenhuma CLI de agente esta PRONTA nesta maquina.
  `providers.default` ficou em `mock` — agente de ENSAIO, que nao escreve codigo e nao revisa.
  Instale e autentique uma CLI (claude ou codex), rode `agentic providers`
  e troque `providers.default` em .agentic/project.yaml pelo id dela.
```

O ensaio serve a teste, demonstração e preview. Ele **não** é elegível como revisor de uma
tentativa real: revisão é a segunda leitura independente da evidência, e um roteiro fixo não
lê nada. Se você insistir em rodar assim, a tentativa reprova dizendo o nome do problema —
não com um `NO_CHANGES` genérico, e nunca com uma revisão de mentira.

Para declarar a CLI à mão, o formato é este:

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
```

Nenhuma credencial aparece aqui, e nenhuma será pedida: o produto executa a CLI e ela usa a
sessão que **você** já autenticou.

> **Uma edição que ainda vale conferir:** `execution.workspaceSetup.link` liga
> `node_modules` na worktree de cada tentativa, e se `node_modules` estiver **rastreado pelo
> git** a criação da worktree falha.
> Ver [TROUBLESHOOTING.md](TROUBLESHOOTING.md#worktree-não-é-criada-e-o-run-fica-parado-sem-erro).

---

## 5. Escrever, validar e compilar a missão

A missão usada aqui (`.agentic/missions/DEMO-001.mission.yaml`) tem três tasks: duas
paralelas e uma que depende das duas. O bloco abaixo omite, para caber na página,
`scope`, `outOfScope`, `constraints` e `acceptanceCriteria`. Destes, **`acceptanceCriteria`
é obrigatório**: sem ele a validação para com
`DA1001 ERROR mission.acceptanceCriteria ... Required`. Os outros três são opcionais no
schema — e valem escrever assim mesmo, porque é o que o agente lê para saber onde a
entrega termina. A especificação completa do formato está em
[MISSION-FORMAT.md](../architecture/MISSION-FORMAT.md).

```yaml
apiVersion: agentic/v1
kind: Mission

id: DEMO-001
title: Operacoes de subtracao e multiplicacao
objective: >
  Somador ganha subtracao e multiplicacao, cada uma em seu arquivo, com teste
  proprio, sem alterar a soma existente.

defaults:
  requireReview: true
  maxAttempts: 2
  gate: unit

phases:
  - id: implementacao
    title: Implementacao
  - id: qualidade
    title: Qualidade

tasks:
  - id: T01
    phase: implementacao
    title: Funcao subtrai
    objective: >
      Criar src/subtrai.js exportando `subtrai(a, b)` que devolve a - b, no mesmo
      estilo ESM de src/soma.js.
    dependencies: []
    touches: [src/subtrai.js]      # escopo de ESCRITA — é contrato
    reads:   [src/soma.js]
    validation:
      - node --check src/subtrai.js sai 0
      - subtrai(5, 3) devolve 2
    gate: unit
    risk: low
    estimate: 1

  # T02 (src/multiplica.js) é idêntica em forma, sem dependência: roda em paralelo com T01.

  - id: T03
    phase: qualidade
    title: Teste das operacoes novas
    objective: >
      Criar test/operacoes.test.js usando node:test e node:assert/strict, cobrindo
      subtrai e multiplica, inclusive com numero negativo.
    dependencies: [T01, T02]
    touches: [test/operacoes.test.js]
    reads:   [src/subtrai.js, src/multiplica.js, test/soma.test.js]
    gate: mission
    risk: medium
    estimate: 2

missionGate: mission
```

`touches` é a parte que quase todo mundo subestima: é o **escopo de escrita declarado**, e
o control plane verifica por diff depois da tentativa. Dois pontos práticos: `touches` que
se sobrepõem entre tasks concorrentes viram aviso na compilação, e alteração fora de
`touches` reprova a tentativa mesmo que o código esteja certo.

### Validar

```console
$ agentic mission validate .agentic/missions/DEMO-001.mission.yaml
missao DEMO-001 · /tmp/demo-somador/.agentic/missions/DEMO-001.mission.yaml
projeto /tmp/demo-somador/.agentic/project.yaml

  nenhum diagnostico

0 ERROR · 0 WARNING · 0 INFO
ok: 3 tasks, 2 fases, 2 waves
```

Um `ERROR` sai com código 1 e diz a linha e a coluna:

```console
  DA1001  ERROR    mission.id     mission.yaml: id — MissionId deve casar ^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\d{3,}$ (linha 4, coluna 5)
          confira o campo citado em docs/architecture/MISSION-FORMAT.md

1 ERROR · 0 WARNING · 0 INFO
erro [VALIDATION_FAILED]: 1 diagnostico(s) ERROR: a missao nao compila
```

Cada diagnóstico tem código (`DA1xxx` = ERROR, `DA2xxx` = WARNING, `DA3xxx` = INFO), o
alvo, a posição no arquivo e o que fazer a respeito. O compilador explica; quem corrige é
você.

### Compilar

`compile` é onde você vê o plano como o orquestrador o enxerga — e **não gasta nada**:

```console
$ agentic mission compile .agentic/missions/DEMO-001.mission.yaml
missao DEMO-001 · /tmp/demo-somador/.agentic/missions/DEMO-001.mission.yaml

tasks por fase
  implementacao: T01 T02
  qualidade: T03

waves (earliest start)
  1. T01 T02
  2. T03

caminho critico (2 tasks, comprimento 3)
  T01 -> T03

pares concorrentes: 1
  T01 || T02

conflitos de touches: 0

diagnosticos
  nenhum diagnostico

0 ERROR · 0 WARNING · 0 INFO · specHash fnv1a64:15f95735fe4b2053
```

Como ler:

- **waves** — o mais cedo que cada task pode começar. Wave 1 é o que sai junto no START.
- **caminho crítico** — a cadeia que define o tempo mínimo da missão. Encurtar qualquer
  outra coisa não adianta; `comprimento` é a soma dos `estimate` da cadeia.
- **pares concorrentes** — o que o scheduler pode rodar ao mesmo tempo, dado o DAG.
- **conflitos de touches** — pares concorrentes que escreveriam no mesmo escopo. Zero é o
  que você quer.
- **specHash** — identidade do plano compilado. Mudou o YAML, mudou o hash, é outra missão
  para efeito de aprovação.

Se o plano for uma cadeia linear, o compilador diz na cara:

```console
  DA3002  INFO     DEMO-001       o plano e uma cadeia linear de 2 tasks: nao ha paralelismo a explorar (linha 35, coluna 3)
          o plano e uma cadeia linear: nenhum executor extra reduz o tempo
```

---

## 6. Ensaio grátis com o provider `mock`

Antes de gastar assinatura, vale rodar a missão inteira com `providers.default: mock` — o
registry que o `init` já entregou, antes da troca da seção 4(b). O `mock` é in-process,
determinístico, sem rede e sem quota — e **não escreve arquivo nenhum**. O resultado é
este:

```console
$ agentic mission start .agentic/missions/DEMO-001.mission.yaml --actor ewaldo
run 01M1BVTGWXEK1CAHYQJ3N2CXRH iniciado (DEMO-001)
...
status final: BLOCKED
tasks: 0 DONE · 0 FAILED · 2 BLOCKED · 0 SKIPPED
```

```console
$ agentic task inspect T01
...
fatos
  diff          0 arquivos +0 -0

falha: NO_CHANGES a tentativa nao alterou nenhum arquivo

bloqueio: [ATTEMPTS_EXHAUSTED] NO_CHANGES: a tentativa nao alterou nenhum arquivo — precisa: decisao humana: ajustar a task, destravar ou pular (tentativas 2/2)
```

**Isso é sucesso, não falha do ensaio.** O agente de mentira relatou `completed`; o control
plane mediu o diff, encontrou zero arquivo e recusou. É o produto inteiro em uma tela: o
relato do agente não decide.

O que o ensaio prova de graça: que o `.agentic/` está válido, que o DAG dispara na ordem
certa, que as worktrees são criadas, que os locks de `touches` funcionam e que o event log
grava. O que ele **não** prova: nada sobre o seu gate, porque sem diff a tentativa nem
chega ao gate.

---

## 7. Aprovar e iniciar (aqui começa a gastar assinatura)

> A partir daqui cada tentativa é uma invocação real da sua CLI de agente e **consome sua
> assinatura**. A execução completa desta missão de 3 tasks custou **5 tentativas de
> executor + 5 sessões de revisor** — mais do que as 3+3 do caminho feliz, porque houve um
> retry e uma escalada. Faça o primeiro smoke com **uma task só** e `requireReview: false`;
> o desta seção levou 20 segundos.

### Aprovar é um ato humano, e fica registrado

```console
$ agentic mission approve .agentic/missions/DEMO-001.mission.yaml
erro [MISSING_ACTOR]: aprovacao exige --actor: nao pode ser vazio
```

```console
$ agentic mission approve .agentic/missions/DEMO-001.mission.yaml \
    --actor ewaldo --note "DAG revisado: 2 waves, T01 e T02 paralelas"
missao DEMO-001 aprovada
  run     01M1BWDXHFSH9JZ7ZRXJNWAYMC
  actor   ewaldo
  status  APPROVED

proximo passo: agentic mission start .agentic/missions/DEMO-001.mission.yaml
```

Não existe aprovação automática nem anônima. `--actor` vira o evento
`human.mission_approved` no log, e o run nasce em `APPROVED` — congelado sobre aquele
`specHash`.

### Iniciar

```console
$ agentic mission start .agentic/missions/DEMO-001.mission.yaml --actor ewaldo --serve
run 01M1BWDXHFSH9JZ7ZRXJNWAYMC iniciado (DEMO-001)
  actor             ewaldo
  warnings aceitos  nao

control plane em primeiro plano; API e dashboard em http://127.0.0.1:4317
`agentic mission pause` e os demais comandos de mutacao alcancam este run.
--serve: o control plane fica no ar mesmo depois do fim do run; Ctrl+C encerra.
```

Você deu **um** comando. A descoberta do que pode rodar agora é do orquestrador: ele achou
T01 e T02 prontas e despachou as duas.

Três modos, e a diferença importa:

| Forma | O que faz |
| --- | --- |
| `agentic mission start <arquivo>` | orquestra **e** publica a API HTTP; o processo encerra quando o run termina |
| `... --serve` | igual, mas o control plane **fica no ar** depois do fim do run (Ctrl+C encerra) |
| `... --no-serve` | orquestra e **não** publica HTTP: `pause`, `resume`, `stop`, `retry`, `unblock` e `skip` ficam inalcançáveis até o run terminar |

### Se a missão tiver WARNING

`start` recusa até você aceitar explicitamente:

```console
$ agentic mission start .agentic/missions/DEMO-002.mission.yaml --actor ewaldo
  DA2001  WARNING  T01            T01 e T02 podem rodar juntas e escrevem no mesmo escopo (src/ × src/) [T02] (linha 28, coluna 14)
          separe os escopos ou declare dependencia entre as duas tasks
  DA2005  WARNING  T01            task T01 declara src/, um diretorio de topo inteiro [src/] (linha 28, coluna 14)
          aponte para o subdiretorio realmente alterado
  ...
  DA2008  WARNING  T01            1 task(s) exigem cross-provider-required e o projeto tem 1 provider(s) apto(s) a revisar (linha 23, coluna 5)
          declare um segundo provider apto a revisar no registry
erro [WARNINGS_NOT_ACCEPTED]: 6 WARNING pendente(s): a partida exige --accept-warnings
```

`--accept-warnings` libera a partida e **registra que você aceitou**. Leia
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#missão-com-warning-o-que-significa-aceitar) antes
de usar por reflexo.

---

## 8. `agentic serve` e o dashboard

`serve` sobe o control plane **sem** run ativo — é o que permite dar START MISSION pela
tela:

```console
$ agentic serve
control plane no ar em http://127.0.0.1:4317
host/porta vem de `server` em /tmp/demo-somador/.agentic/project.yaml
endereco publicado em .agentic/control-plane.json enquanto este processo viver

sem run ativo: use START MISSION no dashboard ou `agentic mission start`.
```

Abra **http://127.0.0.1:4317** no navegador. O dashboard mostra o DAG vivo (estado por
task, o que está esperando e por quê), a anatomia de uma falha e de um bloqueio, o log do
agente e a evidência — e é dele que sai o START MISSION, sem clicar task a task.

Se a raiz vier com uma orientação de build em vez do DAG, faltou o segundo build da
seção 2 (`npm run build -w @agentic/web`): a API responde sem o dashboard, e o servidor diz
isso em vez de quebrar.

Enquanto o processo vive, o endereço **real** fica publicado em
`.agentic/control-plane.json`:

```json
{
  "host": "127.0.0.1",
  "port": 4317,
  "pid": 390436,
  "url": "http://127.0.0.1:4317",
  "startedAt": "2026-08-31T12:24:12.300Z"
}
```

É por esse arquivo que `pause`, `resume`, `stop`, `retry`, `unblock` e `skip` encontram o
control plane — inclusive quando ele subiu numa porta diferente da declarada em
`project.yaml`. O arquivo some quando o processo morre.

O bind é **loopback por padrão**. Sair do loopback é decisão explícita, nunca efeito
colateral: não há autenticação nesta superfície.

A mesma informação está disponível em HTTP, se você preferir script a navegador:

```console
$ curl -s http://127.0.0.1:4317/api/runs
[{"id":"01M1BWDXHFSH9JZ7ZRXJNWAYMC","missionId":"DEMO-001","status":"PAUSED", ...}]
```

---

## 9. Acompanhar: status, task inspect, events tail

Estes três comandos **leem o SQLite em modo leitura**: funcionam com o run parado, sem
control plane no ar.

### `mission status` — o retrato

```console
$ agentic mission status
run 01M1BWDXHFSH9JZ7ZRXJNWAYMC · DEMO-001 · RUNNING
criado 2026-08-31T12:24:12.079Z · iniciado 2026-08-31T12:24:12.255Z
politicas: paralelismo 2 · executores 2 · revisores 1 · workspace git-worktree
branch da missao: mission/DEMO-001

tasks (3): PENDING 1 · VERIFYING 1 · REVIEW 1

  TASK  STATUS     TENT.  DURACAO
  T01   REVIEW     1      -
  T02   VERIFYING  1      -
  T03   PENDING    0      -

waves: T01+T02 -> T03
caminho critico: T01 -> T03

  FORNECEDOR   INSTALADO  PRONTO  EM USO  CAPACIDADE
  claude-code  sim        sim     1       2

metricas: wall 37.0s · tentativas 2 · retries 0 · paralelismo 0.00
```

Os doze estados de task, na ordem em que aparecem: `PENDING` (dependência pendente),
`READY` (pode rodar, esperando vaga ou lock), `RUNNING` (agente em voo), `VERIFYING` (gate
rodando), `REVIEW` (revisor independente em voo), `INTEGRATING` (merge na branch da
missão), `DONE`; e os desvios `RETRY` (aguardando o backoff da próxima tentativa), `FAILED`,
`BLOCKED` (esperando decisão humana), `SKIPPED`, `CANCELLED`.

Sem `runId` ele pega o run mais recente; `agentic mission status <runId>` escolhe outro.

### `task inspect` — tudo sobre uma task

```console
$ agentic task inspect T03
T03 Teste das operacoes novas · DONE · fase qualidade
objetivo: Criar test/operacoes.test.js usando node:test e node:assert/strict, ...

grafo
  dependencias  T01:DONE T02:DONE
  dependentes   -
  critico       sim

escopo
  touches       test/operacoes.test.js
  reads         src/subtrai.js src/multiplica.js test/soma.test.js
  fora do escopo -

execucao
  provider      claude-code
  executor      claude-code.executor
  tentativa     1/2
  duracao       1m22s

revisao
  revisor       claude-code.reviewer
  fornecedor    claude-code
  politica      cross-provider-preferred downgraded
  veredito      PASS

isolamento
  worktree      /tmp/demo-somador/.agentic/worktrees/01M1BWDXHFSH9JZ7ZRXJNWAYMC/T03-a1
  branch        task/DEMO-001/T03/a1
  base          200fadd37d2b349907319300758479f4ab6d09d1
  commit        5b54c293b2b120c2dfaca59329d0ddab5436cb83
  abrir         code /tmp/demo-somador/.agentic/worktrees/01M1BWDXHFSH9JZ7ZRXJNWAYMC/T03-a1

log do agente
  agent-log   runs/.../attempts/T03-a1/agent.log.jsonl   283 bytes  sha256:2d0b2625...
  review-log  runs/.../attempts/T03-a1/review.log.jsonl  4328 bytes  sha256:61b5899f...

qualidade
  gate          mission PASS
  validacao     npm run test passa com os tres arquivos de teste
  comando       npm run verify (exit 0) em /tmp/demo-somador/.agentic/worktrees/.../T03-a1

fatos
  diff          1 arquivos +32 -0
  evidencia     scope afea427cb1c2633e2b70e7460f4d7052eb151332f06918f37fdb091b9e72df83
  evidencia     gate 919f3d38a08e8521e7ce3f35a800b980b8df5764e438bfca73129528b9b375d5
  evidencia     review f1232789f4586f9e9614092784b26c4096cf37a0c664526ad74de91cb898fe32
  evidencia     integration bced7b614f091cbbc374942007f7d80bd15232da7291c19fc8ab0087c464d2cd

  TENT.  RESULTADO  GATE  REVIEW  BRANCH                WORKTREE
  1      PASS       PASS  PASS    task/DEMO-001/T03/a1  /tmp/demo-somador/.agentic/worktrees/.../T03-a1
```

Três coisas para reparar:

- **`fatos` são medições nossas.** `diff` veio do git rodado por nós; `gate` veio do exit
  code de um processo que nós executamos; `evidencia` são digests do que foi observado.
- **`log do agente` é relato**, guardado com tamanho e `sha256`, e nunca decide transição.
- **`politica cross-provider-preferred downgraded`** diz a verdade: só havia um fornecedor
  apto a revisar, então a preferência por revisão cruzada foi rebaixada — e **registrada**.
  `cross-provider-required` nunca seria rebaixada; ela bloquearia.

A linha `abrir  code <worktree>` existe para você inspecionar o trabalho da tentativa com
as próprias mãos. A worktree fica no disco depois da tentativa.

### `events tail` — o log append-only

```console
$ agentic events tail --limit 8
    1  2026-08-31T12:15:41.050Z  run.created  [orchestrator]
    2  2026-08-31T12:15:41.050Z  task.created T01  [orchestrator]
    3  2026-08-31T12:15:41.050Z  task.created T02  [orchestrator]
    4  2026-08-31T12:15:41.050Z  task.created T03  [orchestrator]
    5  2026-08-31T12:15:41.052Z  human.mission_approved  [human:ewaldo]
    6  2026-08-31T12:15:41.052Z  run.approved  [human:ewaldo]
    7  2026-08-31T12:15:41.219Z  run.started  [human:ewaldo]
    8  2026-08-31T12:15:41.265Z  task.ready T01  [orchestrator]
```

`--since <seq>` é **exclusivo** (reconecta sem lacuna e sem duplicata) e `--follow` segue o
log até você interromper:

```console
$ agentic events tail --since 30 --follow
   31  2026-08-31T12:24:32.997Z  gate.finished T02  [orchestrator]
   ...
   69  2026-08-31T12:28:23.560Z  attempt.log_persisted T01  [orchestrator]
   70  2026-08-31T12:28:23.560Z  review.finished T01  [orchestrator]
   71  2026-08-31T12:28:23.561Z  task.integrating T01  [orchestrator]
   74  2026-08-31T12:28:24.054Z  workspace.integrated T01  [orchestrator]
   76  2026-08-31T12:28:24.054Z  task.done T01  [orchestrator]
```

Toda linha carrega **quem** agiu: `[orchestrator]` ou `[human:<actor>]`. Nenhum ato humano
é anônimo.

> Ao interromper `--follow` com Ctrl+C, o Node imprime
> `Warning: Detected unsettled top-level await` e o processo sai com código 13. É um
> arremate pendente da CLI, não perda de dado: o log já está gravado.

Todos aceitam `--json` com contrato estável.

---

## 10. Pausar e retomar

Pause exige o control plane no ar (por isso `--serve`, ou um `agentic serve` em outro
terminal):

```console
$ agentic mission pause --actor ewaldo --reason "conferir T01 antes de liberar T03"
mission pause enviado para run 01M1BVYAFTS6EY023K931PPVFG via http://127.0.0.1:4317
```

```console
$ agentic mission status
run 01M1BVYAFTS6EY023K931PPVFG · DEMO-001 · PAUSED
...
tasks (3): PENDING 1 · RUNNING 2
```

**Pausar não mata o que já está em voo.** A tentativa em curso vai até o fim — agente,
gate e revisão — e só o **próximo despacho** é retido. Alguns segundos depois, ainda
`PAUSED`:

```console
tasks (3): PENDING 1 · VERIFYING 1 · REVIEW 1
```

Isso é intencional: matar um agente no meio produziria uma tentativa pela metade, e
tentativa encerrada nunca é alterada.

```console
$ agentic mission resume --actor ewaldo
mission resume enviado para run 01M1BVYAFTS6EY023K931PPVFG via http://127.0.0.1:4317
```

`agentic mission stop` cancela o run e encerra as tentativas em voo — é irreversível: o run
vai para `CANCELLED` e não volta.

> `pause` e `resume` valem sobre um run `RUNNING`/`PAUSED`. Sobre um run já `BLOCKED` a
> transição não existe e o CLI diz isso:
> `erro [CONTROL_PLANE_REFUSED]: transicao nao declarada na maquina run: BLOCKED -> PAUSED via HUMAN_PAUSE`.
> Ver [TROUBLESHOOTING.md](TROUBLESHOOTING.md#run-blocked-não-volta-a-rodar-depois-de-task-retry).

---

## 11. Quando uma task trava

Um caso real desta execução: a revisão de T01 passou o gate mas **escalou** — o revisor
encontrou uma ambiguidade que não é dele resolver.

```console
$ agentic task inspect T01
...
revisao
  revisor       claude-code.reviewer
  politica      fresh-session satisfied
  veredito      ESCALATE
...
bloqueio: [ARCHITECTURAL] revisao escalou: **Questão em aberto:** não inspecionei `.agentic/`
para saber se já existe uma task posterior que adiciona `test/subtrai.test.js` ... — precisa:
decisao humana sobre a ambiguidade apontada pela revisao
```

Isso é o produto funcionando: `BLOCKED` é escalonamento para gente, não erro.

As saídas possíveis, todas registrando quem decidiu e por quê:

```console
$ agentic task unblock T01 --actor ewaldo
erro [MISSING_NOTE]: unblock exige --note com a justificativa: note: nao pode ser vazio

$ agentic task unblock T01 --actor ewaldo \
    --note "T03 cobre o teste; o glob do lint e decisao consciente do projeto"
task unblock enviado para task T01 do run 01M1BWDXHFSH9JZ7ZRXJNWAYMC via http://127.0.0.1:4317
```

| Comando | Quando | Obrigatório |
| --- | --- | --- |
| `agentic task unblock <T>` | você decidiu a questão que travou a task | `--note` |
| `agentic task retry <T>` | quer uma tentativa a mais além do orçamento | `--reason` recomendado |
| `agentic task skip <T>` | a task não vai acontecer nesta missão | `--reason` |
| `agentic mission stop` | o run inteiro não tem mais salvação | `--reason` recomendado |

Depois do `unblock`, T01 voltou a `RUNNING` com uma tentativa nova e a missão seguiu até o
fim sozinha.

---

## 12. Relatório final e onde foi parar o código

```console
$ agentic mission status
run 01M1BWDXHFSH9JZ7ZRXJNWAYMC · DEMO-001 · COMPLETED
criado 2026-08-31T12:24:12.079Z · iniciado 2026-08-31T12:24:12.255Z · encerrado 2026-08-31T12:31:06.942Z
politicas: paralelismo 2 · executores 2 · revisores 1 · workspace git-worktree
branch da missao: mission/DEMO-001

tasks (3): DONE 3

  TASK  STATUS  TENT.  DURACAO
  T01   DONE    2      4m12s
  T02   DONE    2      5m32s
  T03   DONE    1      1m22s

...

metricas: wall 6m55s · tentativas 5 · retries 2 · paralelismo 1.41
```

```console
$ agentic run report
relatorio da missao DEMO-001 · run 01M1BWDXHFSH9JZ7ZRXJNWAYMC · COMPLETED

tasks: 3/3 DONE · 0 puladas · 0 canceladas · 0 bloqueadas
tentativas 5 · retries 2 · reprovacoes de review 0
mission gate: mission PASS
wall time: 6m55s

caminho critico real (6m54s): T02 -> T03

tasks mais demoradas
  T02 Funcao multiplica: 5m32s
  T01 Funcao subtrai: 4m12s
  T03 Teste das operacoes novas: 1m22s

tasks com retry
  T01: 2 tentativas (-)
  T02: 2 tentativas (AGENT_ERROR)

evidencia citavel
  T01 · unit · exit 0 · npm run lint
  T01 · unit · exit 0 · npm run test
  ...
  T03 · mission · exit 0 · npm run verify
  mission · mission · exit 0 · npm run verify
```

O **caminho crítico real** (medido) quase nunca é o previsto pelo `compile` (estimado):
aqui o previsto era `T01 -> T03` e o real foi `T02 -> T03`, porque T02 precisou de uma
tentativa a mais.

`agentic run report --md` dá a mesma coisa em markdown, com cada evidência já no formato
que você cola no terminal:

````markdown
- T01 · estrito · exit 1
  ```sh
  cd /tmp/scope-proj/.agentic/worktrees/01M1BWNC1ZT07MYXHYY360E1TR/T01-a1 && node -e "..."
  ```
````

### O código está na branch da missão

O control plane **não** mexe na sua branch de trabalho. Cada task é integrada na branch da
missão, e `integration.autoPush: false` significa que abrir PR continua sendo decisão sua.

```console
$ git log --oneline mission/DEMO-001 -4
5b54c29 T03 a1: Teste das operacoes novas
200fadd T02 a2: Funcao multiplica
74e0ecf T01 a2: Funcao subtrai
42618cc agentic: registry so com claude-code

$ git diff --stat master..mission/DEMO-001
 src/multiplica.js      |  1 +
 src/subtrai.js         |  1 +
 test/operacoes.test.js | 32 ++++++++++++++++++++++++++++++++
 3 files changed, 34 insertions(+)
```

Um commit por tentativa aprovada, com a task e o número da tentativa no assunto. Conferindo
por fora do produto:

```console
$ git worktree add -q /tmp/demo-check mission/DEMO-001 && cd /tmp/demo-check && npm run verify
✔ subtrai resultando em numero negativo
✔ subtrai com numero negativo
✔ multiplica dois numeros
✔ multiplica com numero negativo
✔ multiplica por zero
✔ soma dois numeros
ℹ pass 7
ℹ fail 0
```

---

## 13. O que você precisa saber para não se surpreender

**Os gates são os do arquivo versionado, não os do seu terminal.** `gates.yaml` está no
repositório; quem edita edita para todo mundo, e a mudança entra por commit. O control
plane executa cada comando **sem shell**, na worktree da tentativa, com allowlist estrita
de variáveis de ambiente (`env.allow`). O seu `.bashrc` não participa.

Sem shell significa que `|`, `&`, `;`, `<`, `>`, `` ` ``, `$`, `(` e `)` fora de aspas são
**recusados** na linha do gate, e que curingas não são expandidos — quem expande glob é o
shell. Uma linha `run: npm run lint && npm run test` foi executada de verdade e deu isto:

```console
qualidade
  gate          unit ERROR
  comando       npm run lint && npm run test (exit sem codigo) em /tmp/sh-proj/.agentic/worktrees/.../T01-a1
```

O motivo está no artefato de stderr da tentativa, não no resumo:

```console
$ cat .agentic/runs/<run>/attempts/T01-a1/gate-unit-0.stderr
GATE_COMMAND_SYNTAX: comando de gate invalido: operador de shell "&" fora de aspas; use sh -c '...'
```

Quer encadear? Declare o shell: `run: sh -c 'npm run lint && npm run test'` — ou, melhor,
use dois `run:` no perfil, que é o que o `init` já entrega. Note que `npm run verify`
funciona mesmo contendo `&&`: quem interpreta é o npm, dentro do processo dele.

**`touches` é contrato.** É o escopo de **escrita** declarado, verificado por diff depois
da tentativa. Escreveu fora, reprova com `SCOPE_VIOLATION` — mesmo que o código esteja
certo, e antes de o gate chegar a rodar. Não é uma sugestão no prompt: é o que permite
duas tasks rodarem em paralelo sem se sobrescrever. Numa execução real, o agente informou
no log:

> *"Não criei `src/raiz.js`: ele está fora do escopo de escrita permitido (`touches` lista
> apenas `src/potencia.js`). Se `raiz` faz parte da entrega esperada, o escopo da task
> precisa incluir esse caminho ou ele deve ir para uma task separada."*

Quando o escopo estiver errado, corrija o `touches` — não o contorne.

**O relato do agente não decide `DONE`.** O log do agente (`agent.log.jsonl`) é guardado
com bytes e `sha256`, aparece no `task inspect` e no dashboard, e entra na auditoria. Ele
nunca causa transição de estado. Um exemplo literal do smoke real: o agente escreveu que
*"o `node --check` não pôde ser executado aqui — a permissão para o comando foi negada no
ambiente"*, e a task ficou `DONE` assim mesmo — porque **quem rodou o gate fomos nós**, e
saiu 0. O inverso também vale: agente dizendo "pronto, funcionando" com diff vazio vira
`NO_CHANGES`.

**Um agente por tentativa, uma worktree por tentativa.** Nada de dois agentes na mesma
árvore. A worktree fica no disco depois da tentativa, para você inspecionar. Limpe
`.agentic/worktrees/` quando quiser espaço de volta.

**Revisor ≠ executor, sempre.** É invariante do sistema, não convenção de prompt. Com um
fornecedor só, a política `fresh-session` já garante sessão nova e independente;
`cross-provider-preferred` é rebaixada **e registrada** (`downgraded` no `task inspect`);
`cross-provider-required` **nunca** é rebaixada em silêncio — ela bloqueia.

**Smoke com agente real consome assinatura.** Não existe modo "seco" com agente real: se a
CLI foi invocada, gastou. Ordem que economiza de verdade:

1. `agentic mission compile` — grátis, pega ciclo, dependência inexistente e conflito de
   escopo;
2. ensaio inteiro com `mock` — grátis, prova `.agentic/`, DAG, worktrees e event log;
3. smoke real de **uma task**, `requireReview: false`, `maxAttempts: 1` — 20 segundos;
4. a missão de verdade.

E lembre que `maxAttempts` multiplica o custo: uma task de risco médio com
`maxAttempts: 3` e revisão pode custar até 6 invocações.

**O control plane é o único escritor do estado.** Comandos de leitura (`status`,
`task inspect`, `events tail`, `run report`) abrem o SQLite em modo leitura e funcionam com
tudo parado. Comandos de mutação (`pause`, `resume`, `stop`, `retry`, `unblock`, `skip`)
exigem o processo no ar e vão por HTTP local — se não houver processo, o CLI recusa em vez
de escrever no banco por fora.

**Aprovar de novo não reinicia o run.** Um run já iniciado não volta para `APPROVED`.
Aprovar o mesmo `specHash` de novo cria um **novo run**; e o CLI avisa em vez de fazer
isso sozinho:

```console
erro [CONTROL_PLANE_REFUSED]: missao DEMO-001 nao tem run APPROVED: o run 01M1BVYAFTS6EY023K931PPVFG deste spec esta BLOCKED. Aprovar de novo cria um NOVO run do mesmo spec.
```

---

## Referência rápida

```sh
agentic doctor                                    # ambiente: node, git, workspace, fornecedores
agentic providers                                 # só os fornecedores
agentic init [dir]                                # cria .agentic/

agentic mission validate <arquivo>                # schema + semântica (sai 1 com ERROR)
agentic mission compile  <arquivo>                # DAG: waves, caminho crítico, conflitos
agentic mission approve  <arquivo> --actor <nome> # ato humano registrado
agentic mission start    <arquivo> --actor <nome> [--serve|--no-serve] [--accept-warnings]
agentic mission status   [runId]
agentic mission pause|resume|stop [runId] --actor <nome> --reason <texto>

agentic serve                                     # control plane sem run ativo

agentic task inspect <T> [--run <id>]
agentic task retry   <T> --actor <nome> --reason <texto>
agentic task unblock <T> --actor <nome> --note   <texto>   # --note obrigatório
agentic task skip    <T> --actor <nome> --reason <texto>   # --reason obrigatório

agentic events tail [runId] [--since <seq>] [--limit <n>] [--follow]
agentic run report  [runId] [--md]
```

Deu errado? [TROUBLESHOOTING.md](TROUBLESHOOTING.md) tem só casos realmente observados,
cada um com sintoma, causa e o que fazer.
