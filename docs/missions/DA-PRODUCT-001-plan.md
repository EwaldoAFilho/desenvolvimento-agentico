# DA-PRODUCT-001 — plano compilado e auditoria de promoção

> Entregável de P01. Números observados, não estimados.

## 1. Baseline de qualidade

Ao reabrir o repositório após reboot, o baseline **falhou**:

```
npm run verify    262 failed | 1443 passed
npm run test:e2e  6 failed | 50 skipped
```

**Não era regressão de código.** Causa observada:

```
The module '.../better-sqlite3/build/Release/better_sqlite3.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 115.
```

O reboot trocou o Node de **24.18.1** para **20.18.1** (`/home/desenvolvedor/.local/node/bin/node`
assumiu a frente do PATH). O módulo nativo estava compilado para Node 24.

**O `doctor` do produto diagnosticou corretamente, como primeira linha da saída:**

```
ERRO     versao do Node    node 20.18.1: o control plane exige >= 22
unknown  agentes em voo    nao apurado: NODE_MODULE_VERSION 137 ... requires 115
```

Note o `unknown` em vez de um número inventado — a honestidade do modelo de saúde
funcionando sob falha de ambiente.

Com o Node correto, baseline confirmado:

| Comando | Resultado |
| --- | --- |
| `npm run build` | exit 0 |
| `npm run verify` | **1.940 testes**, exit 0 |
| `npm run test:e2e` | **52 testes** (+4 opt-in pulados), exit 0 |

**Achado que vira trabalho nesta missão (P06):** quem reinicia e cai no Node errado recebe
262 falhas crípticas. O `doctor` avisa, mas a instalação e o `verify` não. Um produto de uso
diário precisa falhar cedo e legível.

## 2. Auditoria de promoção

```
main                        c9a3271
mission/DA-CORE-001         3c42573
mission/DA-DOGFOOD-001      983d158
task/DA-DOGFOOD-001/T01/a1  983d158
task/DA-DOGFOOD-001/T02/a1  83a18e1
mission/DA-CORE-002         552ee70  (HEAD)
```

Histórico **linear**: toda branch é ancestral de `mission/DA-CORE-002`, e `main` também.
Nenhuma branch tem commit exclusivo que se perderia (`0` em todas).

Estratégia escolhida: **fast-forward**. Preserva os 29 commits com sua granularidade por
task, sem squash e sem fabricar um merge que não aconteceu. As branches ficam como
marcadores das missões (não apagadas).

```
git merge --ff-only mission/DA-CORE-002   →   main = 552ee70
```

Gate pós-promoção: build 0 · verify 0 (1.940) · e2e 0 (52). **PASS.**

## 3. Grafo compilado

```
specHash  fnv1a64:8f41d534e7e6aa85
0 ERROR · 0 WARNING · 1 INFO
9 tasks · 6 fases · 13 pares concorrentes · 0 conflito de touches
```

### Waves

```
1. P01
2. P02  P04  P05  P06
3. P03  P07
4. P08
5. P09
```

### Caminho crítico (5 tasks, comprimento 22)

```
P01 → P04 → P03 → P08 → P09
```

A espinha é **explicabilidade → navegador → execução real → aceitação**. Faz sentido: esta
missão é sobre uso, não sobre motor. As tasks de infraestrutura (P02), operação (P05) e
partida limpa (P06) têm folga.

### INFO entendido

`DA3001` em P03: a task está na fase `navegador` e depende de P04, que está em `operacao` —
uma fase declarada depois. É intencional: a aceitação em navegador só faz sentido depois que
a interface passa a explicar o estado. Fase é agrupamento, o DAG é que manda (P02 do produto).

## 4. Orçamento operacional

| Fornecedor | Despachos reais | Revisões reais |
| --- | --- | --- |
| Claude Code | teto 6 | teto 3 |
| Codex | **0** — quota bloqueada até 05/09, fora do escopo desta missão |

Tetos, não metas.
