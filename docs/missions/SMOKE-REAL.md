# Smoke real — validação manual contra as CLIs verdadeiras

Roteiro **manual e opt-in** para exercitar o control plane contra agentes reais (Claude Code
e Codex). Não faz parte de `npm run test:e2e`, não roda em CI e não é pré-requisito de
merge.

> **Regra que não se negocia:** nenhum teste automatizado invoca CLI de agente real nem
> consome quota. `npm run test:e2e` roda inteiro com providers mock in-process e é
> determinístico. O que está aqui é procedimento de gente, executado de propósito, sabendo
> que vai gastar assinatura.

Alvo do roteiro: o projeto de exemplo [`examples/estoque-cli`](../../examples/estoque-cli) e a
missão `EXEMPLO-001` (8 tasks, dois níveis de paralelismo, uma task de risco alto com
`reviewPolicy: cross-provider-required`, uma task sem gate e um mission gate).

---

## 1. Pré-requisitos

| Item | Como conferir | Por quê |
| --- | --- | --- |
| Node 22+ | `node --version` | `engines` do produto |
| git 2.30+ | `git --version` | worktree por tentativa |
| Produto compilado | `npm install && npm run build` na raiz | o binário `agentic` carrega `apps/cli/dist` |
| Ao menos uma CLI de agente instalada e **autenticada** | seção 3 | subscription-first (P17): sem API key, sem token nosso |

Nenhuma variável de ambiente com credencial é lida, guardada ou injetada. Se um roteiro
pedir `ANTHROPIC_API_KEY` ou equivalente, ele não é este.

Atalho usado no resto do documento (rode na raiz do produto, depois do `build`):

```sh
alias agentic="node $PWD/apps/cli/bin/agentic.mjs"
```

---

## 2. Preparar um alvo FORA do repositório do produto

**Isto não é zelo excessivo, é o passo que evita estrago.** `examples/estoque-cli` não é um
repositório git próprio: ele vive dentro do repositório do produto. Rodar a missão ali faria
o control plane criar a branch `mission/EXEMPLO-001` e worktrees **do repositório do
produto**.

```sh
cp -r examples/estoque-cli /tmp/smoke-estoque
cd /tmp/smoke-estoque
git init -q -b main
git add -A
git commit -q -m "estoque-cli: estado inicial"
```

É exatamente o que o E2E faz em `mkdtemp` (`tests/e2e/support/fixture.ts`).

---

## 3. Conferir o ambiente com `agentic doctor`

```sh
cd /tmp/smoke-estoque
agentic doctor
```

Saída esperada em um ambiente com as duas CLIs prontas:

```text
  ok       versao do Node                     node 22.x
  ok       arquivos do projeto                .../project.yaml e .../gates.yaml validos
  ok       git disponivel                     git version 2.x
  ok       repositorio git valido             /tmp/smoke-estoque e um repositorio git
  ok       workspace x paralelismo            workspace: git-worktree com maxParallelTasks: 4
  ok       capacidade somada dos fornecedores capacidade somada 5 · teto global 4
  ok       fornecedor claude-code             versao ... · capacidade 3
  ok       fornecedor codex                   versao ... · capacidade 2
```

Como ler a coluna de prontidão:

| Valor | Significa | O que fazer |
| --- | --- | --- |
| `sim` | instalação e prontidão **observadas** | pode começar |
| `nao` | a sonda respondeu que não | instale ou autentique a CLI |
| `unknown` | a CLI não permite apurar de forma confiável | **não conte como pronto**; a primeira tentativa é quem vai descobrir |

`doctor` sai com código 1 quando há qualquer `ERRO`. Comece só depois de entender cada
linha — descobrir CLI faltando no meio do run custa tempo de agente.

---

## 4. Compilar a missão (não gasta nada)

```sh
agentic mission compile .agentic/missions/EXEMPLO-001.mission.yaml
```

Esperado (conferido neste repositório):

```text
waves (earliest start)
  1. T01 T02
  2. T03 T04
  3. T05 T06
  4. T07
  5. T08

caminho critico (5 tasks, comprimento 13)
  T01 -> T03 -> T05 -> T07 -> T08

pares concorrentes: 5
conflitos de touches: 0
0 ERROR · 0 WARNING · 0 INFO · specHash fnv1a64:d4ea77e6d63f3b63
```

Se aparecer `DA2008` (`revisao cruzada sem segundo fornecedor`), o projeto está com um
fornecedor apto a revisar só — leia a seção 8 antes de partir.

---

## 5. Aprovar e dar START MISSION

Aprovar é ato humano e fica registrado com autor:

```sh
agentic mission approve .agentic/missions/EXEMPLO-001.mission.yaml --actor "seu.nome"
```

Partir, pelo terminal:

```sh
agentic mission start .agentic/missions/EXEMPLO-001.mission.yaml --serve
```

Ou pelo dashboard, que é o caminho que o produto recomenda:

```sh
agentic serve            # sobe em http://127.0.0.1:4317, sem run ativo
```

Abra a URL, escolha `EXEMPLO-001` e use **START MISSION**. Um clique: o orquestrador
descobre todas as tasks READY e despacha conforme as políticas. Não existe botão de
despachar task a task — se você se pegar procurando um, o produto está sendo usado errado.

---

## 6. O que observar enquanto roda

| Onde | Comando | O que precisa aparecer |
| --- | --- | --- |
| DAG vivo | dashboard aberto | T01 e T02 em RUNNING ao mesmo tempo; T03 acende READY sozinha quando as duas concluem |
| Estado | `agentic mission status` | contadores por estado e métricas do run |
| Log | `agentic events tail --follow` | `task.dispatched`, `gate.finished`, `review.finished`, `workspace.integrated` |
| Isolamento | `git worktree list` em `/tmp/smoke-estoque` | uma worktree por tentativa em voo, em `.agentic/worktrees/` |
| Uma task | `agentic task inspect T05 --json` | worktree, branch, provider do executor **e do revisor** |
| Gates | saída do run | `node tests/run.js` rodando de verdade em cada worktree |
| Integração | `git log --oneline mission/EXEMPLO-001` | um commit por task concluída |
| Fim | `agentic run report --md` | relatório com caminho crítico real e evidência citável |

Três coisas merecem atenção especial, porque são as que separam este produto de um script
que chama LLM em sequência:

1. **T05 é revisada por outro fornecedor.** `agentic task inspect T05 --json` precisa mostrar
   `review.reviewerProvider` diferente de `execution.provider`, com
   `review.policyOutcome: "satisfied"`.
2. **Nada chega a DONE por relato.** Se um agente disser que terminou e não alterar arquivo,
   a tentativa falha com `NO_CHANGES`.
3. **Escrever fora do `touches` reprova**, mesmo que o gate passasse.

---

## 7. Encerrar e limpar

```sh
git worktree list                  # confira o que sobrou
git worktree prune
cd / && rm -rf /tmp/smoke-estoque
```

O banco (`.agentic/state.db`), os artefatos (`.agentic/runs/`) e as worktrees são locais e
gitignorados — some tudo junto com o diretório.

---

## 8. Como interpretar falha

| Sintoma | Significa | O que fazer |
| --- | --- | --- |
| `PROVIDER_UNAVAILABLE` | a CLI não foi encontrada no PATH | instale; **não consome tentativa** |
| `PROVIDER_NOT_READY` | CLI presente, sessão não autenticada | autentique na própria CLI; **não consome tentativa** |
| `doctor` mostra `unknown` | a CLI não permite apurar prontidão | siga, sabendo que a primeira tentativa é o teste real |
| `GATE_FAILED` | o gate rodou e reprovou | cole a linha `cd ... && ...` do relatório no terminal: dá o mesmo resultado |
| `SCOPE_VIOLATION` | o agente escreveu fora do `touches` | o escopo declarado é contrato; reveja o `touches` da task ou o prompt |
| `NO_CHANGES` | o agente relatou trabalho sem alterar arquivo | é o produto funcionando: `claims` não decide |
| `REVIEW_FAILED` | revisor independente reprovou | nova tentativa dentro do orçamento (`maxAttempts: 2` no fixture) |
| `review.escalated` → `BLOCKED` | o revisor pediu decisão humana | `agentic task unblock T0x --note "..."` (a nota é obrigatória e fica registrada) |
| `CROSS_PROVIDER_UNAVAILABLE` → `BLOCKED` | só há um fornecedor apto a revisar e a task exige revisão cruzada | **isto é o comportamento correto (I10)**: registre um segundo fornecedor ou assuma o bloqueio; a política nunca é rebaixada em silêncio |
| `ATTEMPTS_EXHAUSTED` → `BLOCKED` | acabou o orçamento de tentativas | decisão humana: `task unblock`, `task retry` ou `task skip --reason` |
| `INTERRUPTED` | o control plane caiu com tentativa em voo | reabra: a tentativa órfã é encerrada com registro e nada é presumido concluído |
| `INTEGRATION_CONFLICT` | o merge na branch da missão conflitou | resolva na worktree indicada; o control plane não inventa resolução |

Regra geral para ler qualquer falha: **o que vale é o que foi medido**. Comando, exit code,
diff e commit estão no relatório e no `task inspect`; a narrativa do agente fica em `claims`
e não decide nada.

---

## 9. Estado observado neste ambiente — 2026-08-30

Registro honesto do que **foi** e do que **não foi** verificado na máquina onde a T15 foi
construída. Nada aqui é suposição.

### Codex — disponível e pronto (verificado)

```console
$ ls -l ~/.local/bin/codex
-rwxrwxr-x 1 desenvolvedor desenvolvedor 1612 ... /home/desenvolvedor/.local/bin/codex

$ codex --version
codex-cli 0.151.0-alpha.7.2

$ codex login status
Logged in using ChatGPT
$ echo $?
0
```

`agentic doctor` no fixture concorda: `ok fornecedor codex · versao 0.151.0-alpha.7.2 ·
capacidade 2`. Prontidão observável de verdade, não inferida de um `--version` que
respondeu.

### Claude Code — indisponível (verificado)

```console
$ ls -l ~/.local/bin/claude
lrwxrwxrwx ... /home/desenvolvedor/.local/bin/claude -> /home/desenvolvedor/snap/code/252/.local/share/claude/versions/2.1.220

$ test -e ~/.local/bin/claude && echo existe || echo "symlink quebrado"
symlink quebrado

$ claude --version
bash: claude: comando não encontrado
```

O symlink aponta para um caminho snap que não existe mais. `agentic doctor` reporta:

```text
  ERRO     fornecedor claude-code   nao instalado: instalacao: "claude" nao encontrado
                                    (14 candidato(s) verificados); prontidao: false por
                                    ausencia do executavel
```

(o número de candidatos varia com o `PATH` de quem roda; o que importa é `nao instalado`)

**Consequência, dita sem rodeio: o smoke real do Claude Code NÃO pôde ser executado neste
ambiente.** Não foi executado, não é afirmado. Nenhuma linha deste repositório afirma que
uma missão real rodou com Claude Code.

### O que dá para rodar aqui, e o que isso prova

Com `codex` como único fornecedor apto a revisar:

- `agentic mission compile` passa a emitir **`DA2008` (WARNING)** — revisão cruzada sem
  segundo fornecedor — e a partida passa a exigir `--accept-warnings`;
- as sete tasks de política `fresh-session` executam e concluem normalmente;
- **T05 vai para `BLOCKED` com `CROSS_PROVIDER_UNAVAILABLE`** e o run termina `BLOCKED`.

Isso não é o roteiro falhando: é a invariante I10 sendo observada em ambiente real. O mesmo
par de cenários está coberto de forma determinística, com dois mocks distintos, em
[`tests/e2e/cross-provider.test.ts`](../../tests/e2e/cross-provider.test.ts).

### Para restaurar o Claude Code e completar o roteiro

1. Reinstale a CLI de forma que `claude --version` responda no PATH.
2. `agentic doctor` no fixture precisa mostrar `ok fornecedor claude-code`.
3. Repita as seções 4 a 7. Com dois fornecedores, `mission compile` volta a `0 WARNING` e
   T05 conclui com `review.policyOutcome: satisfied` e revisor de outro fornecedor.

---

## 10. Sonda opt-in automatizada (não gasta quota)

Existe um teste desligado por padrão que **apenas sonda a prontidão** dos providers reais
declarados no fixture — instalação, versão e login. Ele nunca despacha agente e nunca envia
prompt:

```sh
AGENTIC_SMOKE_REAL=1 npx vitest run --project e2e tests/e2e/smoke-real.test.ts
```

Sem a variável, `describe.skipIf` pula o arquivo inteiro: `npm run test:e2e` continua sendo
mock puro. A execução de uma missão real com agentes de verdade permanece o que está nas
seções 2 a 7 — trabalho manual, feito por uma pessoa que decidiu gastar a assinatura.
