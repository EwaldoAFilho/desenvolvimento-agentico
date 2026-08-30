# estoque-cli

Projeto-alvo de exemplo: uma biblioteca Node minúscula, sem nenhuma dependência externa,
que serve de alvo para a missão `EXEMPLO-001`.

Não é um mock. Os arquivos existem, o código roda e a suíte é de verdade:

```sh
node tests/run.js
# ok 2 verificacoes em 2 modulos
```

## Estado inicial

```text
src/unidades.js    conversao caixas -> unidades
src/catalogo.js    catalogo de produtos e busca por sku
tests/run.js       suite: importa todo modulo de src/, roda asserts e os casos de tests/casos.js
```

`tests/run.js` é o comando do gate `unit`. Ele carrega **todo** arquivo de `src/`, então um
módulo entregue por uma task entra na verificação sem que ninguém edite a suíte — e um
módulo que não compila reprova a tentativa com exit code 1.

## O que a missão entrega

[`.agentic/missions/EXEMPLO-001.mission.yaml`](.agentic/missions/EXEMPLO-001.mission.yaml)
tem 8 tasks:

| Task | Fase | Depende de | Escreve | Gate | Risco |
| --- | --- | --- | --- | --- | --- |
| T01 | base | — | `src/unidades.js` | `unit` | low |
| T02 | base | — | `src/catalogo.js` | `unit` | low |
| T03 | feature | T01, T02 | `src/inventario.js` | `unit` | medium |
| T04 | feature | T02 | `src/precos.js` | `unit` | low |
| T05 | feature | T01, T03 | `src/reposicao.js` | `unit` | **high**, `cross-provider-required` |
| T06 | feature | T02, T03, T04 | `src/relatorio.js` | **sem gate** | low |
| T07 | quality | T05, T06 | `src/cli.js` | `unit` | medium |
| T08 | quality | T04, T07 | `docs/USAGE.md`, `tests/casos.js` | `mission` | low |

```text
waves          1. T01 T02 · 2. T03 T04 · 3. T05 T06 · 4. T07 · 5. T08
caminho critico T01 -> T03 -> T05 -> T07 -> T08 (13)
concorrentes   T01||T02, T01||T04, T03||T04, T04||T05, T05||T06
conflitos      0        diagnosticos: 0 ERROR · 0 WARNING · 0 INFO
```

O plano foi desenhado para exercitar, na mesma missão: dependências reais, dois pares de
tasks concorrentes com escopos disjuntos, uma task de risco alto com revisão cruzada
obrigatória, uma task sem gate (verificável por `validation`) e um mission gate que só passa
depois que a missão inteira entregou.

## Gates

[`.agentic/gates.yaml`](.agentic/gates.yaml) — comandos reais, baratos e reproduzíveis:

| Perfil | Comandos |
| --- | --- |
| `unit` | `node tests/run.js` |
| `mission` | `node tests/run.js` · `node -e '...'` conferindo que todos os arquivos da missão existem |

O segundo comando do perfil `mission` **falha (exit 4) no estado inicial** e só passa quando
a missão terminou — é assim que ele vale alguma coisa.

## Fornecedores

[`.agentic/project.yaml`](.agentic/project.yaml) declara duas CLIs locais já autenticadas
(`claude-code` e `codex`), sem nenhuma API key. Dois fornecedores não é enfeite: é o que
permite `cross-provider-required` na T05.

No E2E os dois são substituídos por agentes in-process roteirizados — nenhuma CLI real é
invocada e nenhuma quota é consumida. Para rodar contra as CLIs verdadeiras, siga
[`docs/missions/SMOKE-REAL.md`](../../docs/missions/SMOKE-REAL.md).
