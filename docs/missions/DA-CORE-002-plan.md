# DA-CORE-002 — plano compilado

> Entregável de T201. Análise produzida pelo **próprio Graph Compiler** do produto
> (`agentic mission compile`), não por inspeção manual.

## Ambiente apurado antes de planejar

| Fornecedor | Estado | Como foi apurado |
| --- | --- | --- |
| `codex` | disponível, autenticado | `codex --version` → 0.151.0-alpha.7.2; `codex login status` → "Logged in using ChatGPT", exit 0 |
| `claude` | **recuperado nesta missão**, autenticado | symlink quebrado repontado (registro abaixo); `claude --version` → 2.1.220; `claude auth status` → `loggedIn: true`, `authMethod: claude.ai`, exit 0 |

Nenhuma variável `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` definida ou usada.

### Recuperação do Claude Code (autorizada pelo item 8)

```
alvo antigo (quebrado): /home/desenvolvedor/snap/code/252/.local/share/claude/versions/2.1.220
                        (revisão snap 252 não existe mais)
alvo novo:              /home/desenvolvedor/snap/code/current/.local/share/claude/versions/2.1.220
                        existe: sim · executável: sim · --version: 2.1.220 (Claude Code)

reversão: ln -sfn "<alvo antigo>" /home/desenvolvedor/.local/bin/claude
```

Nada foi baixado, instalado, removido ou elevado com `sudo`. Nenhum rc de shell alterado.
Apenas um symlink no HOME foi repontado para uma instalação **já existente** da **mesma
versão**. Consequência: **T207 e T208 deixam de ser condicionais.**

## O compilador reprovou este plano duas vezes

Registro deliberado — é a ferramenta praticando o que prega:

1. **`DA1008` ×2** — T201 e T211 declaravam `touches` em `.agentic/missions/`, que está em
   `denyPaths` por P09: agente nunca altera política nem plano.
2. **`DA1008` ×2** — removi os `touches` e o compilador recusou de novo: *"sem escopo de
   escrita não há contrato a verificar"* (P04).
   **Correção:** o YAML da missão é ato do supervisor humano; o entregável verificável da
   task é a análise registrada (este arquivo).
3. **`DA2006`** — T202 apontada como trabalho órfão: mudava o pipeline de verificação e
   nada a jusante exercitava a mudança. **Correção:** T213 passou a depender de T202,
   porque o mission gate de T213 *é* o pipeline que T202 separou.

Nenhum `--accept-warnings` foi usado para contornar diagnóstico.

## Grafo compilado

```
specHash  fnv1a64:c260cb5608c3329c
0 ERROR · 0 WARNING · 2 INFO
13 tasks · 7 fases · 29 pares concorrentes · 0 conflito de touches
```

### Waves

```
1. T201
2. T202  T203  T204  T209
3. T205  T210
4. T206  T211
5. T207
6. T208
7. T212
8. T213
```

### Caminho crítico (8 tasks, comprimento 33)

```
T201 → T203 → T205 → T206 → T207 → T208 → T212 → T213
```

A espinha é a **execução real**: recuperar prontidão de provider (T203), expor isso na
interface (T205), e então a cadeia real Codex → Claude → cross-provider → dogfooding.
As tasks de código puro (T202, T204, T209, T210) têm folga.

### INFO entendidos, não silenciados

`DA3001` em T207 e T208: dependem apenas de tasks da mesma fase `real`. É intencional — a
cadeia de execução real é sequencial por controle de orçamento de assinatura, e sua porta
de entrada (T206) é que depende das fases anteriores.

## Orçamento operacional desta missão

| Fornecedor | Despachos reais | Revisões reais |
| --- | --- | --- |
| Codex | teto 3 | teto 2 |
| Claude Code | teto 3 | teto 2 |

Tetos, não metas. Nenhum laço automático consome quota.
