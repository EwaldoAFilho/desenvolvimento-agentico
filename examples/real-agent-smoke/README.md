# real-agent-smoke

Projeto-alvo **mínimo** para o smoke com agente real: uma biblioteca Node de três módulos,
sem nenhuma dependência externa, e a missão `SMOKE-REAL-001` com três tasks.

Existe para uma coisa só: **rodar o control plane contra CLIs de agente de verdade**
(Claude Code, Codex) e ver o produto despachar, medir gate, revisar e integrar com trabalho
que não é de mentira.

> **Opt-in e pago.** Executar esta missão **consome quota da sua assinatura**. Nenhum teste
> automatizado a executa: `npm run test:e2e` roda inteiro com providers mock in-process e
> tem `examples/estoque-cli` como alvo. Se você não decidiu gastar assinatura de propósito,
> não está no lugar certo.

Por que existe um segundo fixture, se `estoque-cli` já roda a missão inteira: `estoque-cli`
tem 8 tasks e foi desenhado para o E2E determinístico, onde uma task custa milissegundos.
Com agente real, 8 tasks × 2 tentativas é caro e demorado. Aqui são 3 tasks, uma revisão e
um gate de menos de um segundo — barato o bastante para rodar de novo quando algo der
errado, e verdadeiro o bastante para a evidência valer.

---

## O que é o código

Um utilitário de agenda. Domínio pequeno e sem ambiguidade: **"certo" é o que a suíte diz**.

```text
src/resultado.js   base — a convencao: ok / falha / propagar, e os quatro codigos
src/texto.js       base — normalizacao de entrada (caixa, espaco)
src/horario.js     base — 'HH:MM' <-> minutos do dia; modelo executavel da convencao
tests/run.js       a suite
tests/specs/*.js   um contrato executavel por modulo
docs/CONTRATO.md   a mesma especificacao em prosa, para quem prefere ler antes
scripts/reset.mjs  volta ao estado inicial
```

A missão entrega três módulos que **não existem** no estado inicial:

| Task | Fase | Depende de | Escreve | Gate | Revisão |
| --- | --- | --- | --- | --- | --- |
| T01 | base | — | `src/duracao.js` | `unit` | não |
| T02 | base | — | `src/intervalo.js` | `unit` | não |
| T03 | integracao | T01, T02 | `src/agenda.js` | `mission` | **sim** |

```text
waves           1. T01 T02 · 2. T03
caminho critico T01 -> T03 (5)
concorrentes    T01 || T02        conflitos de touches: 0
```

T01 e T02 são independentes, tocam arquivos diferentes e rodam ao mesmo tempo. T03 depende
das duas e integra as duas. Cada task escreve em **um caminho previsível e distinto** — é o
que torna `enforceTouches` verificável a olho nu.

Nenhuma das três é decorativa: para escrever qualquer uma o agente precisa ler o código que
já existe, entender a convenção de `Resultado` (incluindo qual código de falha sai em cada
situação) e cobrir os casos de borda — entrada vazia, forma errada, faixa, ordem, sobra.

---

## Como rodar o gate à mão

```sh
cd examples/real-agent-smoke

node tests/run.js
# ok 13 casos em 3 modulos · pendente: agenda.js duracao.js intervalo.js

node tests/run.js --exigir-tudo
# pendente 3 modulo(s) nao entregue(s): agenda.js duracao.js intervalo.js
echo $?   # 4
```

São exatamente os dois comandos de [`.agentic/gates.yaml`](.agentic/gates.yaml):

| Perfil | Comando | Papel |
| --- | --- | --- |
| `unit` | `node tests/run.js` | gate das tasks: módulo não entregue fica **pendente**, módulo entregue errado **reprova** |
| `mission` | `node tests/run.js --exigir-tudo` | mission gate: pendência vira reprovação (exit 4) |

O gate `unit` passa no estado inicial de propósito — senão toda tentativa começaria
reprovada. O gate `mission` **falha no estado inicial** e só passa quando a missão inteira
entregou; é assim que ele vale alguma coisa.

E o gate reprova de verdade: quebre um módulo entregue e a suíte sai 1 com o caso nomeado.

```console
$ node tests/run.js
FALHOU duracao.js · componente fora da faixa e FAIXA
  Expected values to be strictly equal: ...
$ echo $?
1
```

## Como resetar

```sh
node scripts/reset.mjs
# reset: removido(s) src/agenda.js src/duracao.js src/intervalo.js
```

Idempotente: `src/` volta a ter exatamente os três módulos base. Rodar duas vezes dá o mesmo
resultado. O estado do control plane (`.agentic/state.db`, `.agentic/runs/`, worktrees) não é
tocado pelo script — ele some junto com a cópia do projeto, que é descartável por natureza.

---

## Como rodar o smoke com agente real

O roteiro completo — pré-requisitos, `doctor`, como ler cada falha — é
[`docs/missions/SMOKE-REAL.md`](../../docs/missions/SMOKE-REAL.md). O resumo, com este alvo:

```sh
# 1. copie para FORA do repositorio do produto (este diretorio nao e um repo git proprio)
cp -r examples/real-agent-smoke /tmp/smoke-agenda
cd /tmp/smoke-agenda && git init -q -b main && git add -A && git commit -q -m inicial

# 2. na raiz do produto: npm install && npm run build
alias agentic="node /caminho/do/produto/apps/cli/bin/agentic.mjs"

# 3. confira o ambiente e compile (nao gasta nada)
agentic doctor
agentic mission compile .agentic/missions/SMOKE-REAL-001.mission.yaml

# 4. a partir daqui gasta assinatura
agentic mission approve .agentic/missions/SMOKE-REAL-001.mission.yaml --actor "seu.nome"
agentic mission start .agentic/missions/SMOKE-REAL-001.mission.yaml --serve
```

Copiar para fora não é zelo excessivo: rodar aqui dentro faria o control plane criar branch
e worktrees **do repositório do produto**.

Compilar do repositório do produto também funciona e é o que o CI de revisão faz — só note
que o contexto vem do `.agentic/` da raiz, não do daqui:

```sh
node apps/cli/bin/agentic.mjs mission compile \
  examples/real-agent-smoke/.agentic/missions/SMOKE-REAL-001.mission.yaml
# 0 ERROR · 0 WARNING · 0 INFO
```

Para compilar com o `.agentic/` **deste** projeto, aponte o contexto:

```sh
node apps/cli/bin/agentic.mjs mission compile \
  examples/real-agent-smoke/.agentic/missions/SMOKE-REAL-001.mission.yaml \
  -C examples/real-agent-smoke
```

### O que observar

| O quê | Onde | Por quê |
| --- | --- | --- |
| T01 e T02 em `RUNNING` juntas | dashboard / `agentic mission status` | paralelismo real, escopos disjuntos |
| T03 só acende quando as duas terminam | dashboard | a dependência é do DAG, não do relógio |
| gate rodando em cada worktree | saída do run | `node tests/run.js` de verdade, exit code medido |
| T03 revisada por outra sessão | `agentic task inspect T03 --json` | I3: `reviewer ≠ executor` |
| escrita fora de `src/<arquivo>.js` reprova | relatório | `enforceTouches`: escopo é contrato |
| agente que diz ter feito sem alterar arquivo | falha `NO_CHANGES` | `claims` não decide nada |

### Duas variações que valem o custo

- **Revisão cruzada obrigatória:** mude `risk: medium` para `risk: high` na T03. O projeto
  mapeia `high` para `cross-provider-required`: com dois fornecedores aptos, T03 conclui com
  revisor de fornecedor diferente do executor; com um só, T03 vai para `BLOCKED` com
  `CROSS_PROVIDER_UNAVAILABLE` — I10 sendo observada, não rebaixada em silêncio.
- **Reprovação de escopo:** peça ao agente, no prompt da task, para "ajustar a suíte se
  necessário". `tests/` está em `denyPaths` e fora de `touches`: a tentativa reprova mesmo
  que o gate passasse.

---

## Segredos

Nenhum. Não há `.env`, credencial, token, URL interna ou dado pessoal neste diretório — e o
`allow` de `gates.yaml` repassa só `PATH`, `HOME`, `LANG` e `TMPDIR` para os comandos.
Subscription-first (P17): os providers são CLIs locais já autenticadas pelo usuário, nenhuma
exige API key.
