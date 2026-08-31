# Matriz de prontidão do produto

> Estados objetivos, sem porcentagem. `PASS` = exercitado e verificado.
> `BLOCKED_BY_ENVIRONMENT` = o produto está pronto, falta algo do ambiente.
> `PARTIAL` = funciona com limitação conhecida e declarada.

## Evolução entre missões

| Missão | Veredito de produto |
| --- | --- |
| `DA-CORE-001` | MVP funcional, sem execução real |
| `DA-CORE-002` | `READY_FOR_CONTROLLED_REAL_USE` |
| `DA-PRODUCT-001` | **`READY_FOR_DAILY_LOCAL_USE`** — provider validado: Claude Code · validação dual-provider: `PENDING_ENVIRONMENT` |

---

## Estado após `DA-PRODUCT-001` (2026-08-31)

| Capacidade | Estado | Como foi verificado |
| --- | --- | --- |
| Leitura de missão | `PASS` | schema dos 3 arquivos; os arquivos reais do repo validam |
| Compilação do grafo | `PASS` | 22 diagnósticos; reprovou o plano desta missão 3× antes de aceitar |
| Escalonamento | `PASS` | função pura; inanição de revisão coberta; capacidade por fornecedor |
| Isolamento de workspace | `PASS` | worktree por tentativa, observada em 5 runs reais |
| Execução com mock | `PASS` | 2.095 testes + 52 E2E + 10 de navegador, determinísticos, sem quota |
| **Execução real — Claude Code** | `PASS` | `DA-REAL-002`: T01∥T02 `DONE` em paralelo; `DA-REAL-003`: `COMPLETED` |
| Execução real — Codex | `BLOCKED_BY_ENVIRONMENT` | CLI instalada e autenticada; quota esgotada até 05/09 |
| Task gate | `PASS` | executado na worktree da tentativa, exit code e digest registrados |
| **Revisão independente real** | `PASS` | `DA-REAL-003`: veredito `PASS`, `reviewer.sessionRef ≠ executor.sessionRef` |
| Revisão cruzada real | `BLOCKED_BY_ENVIRONMENT` | exige dois fornecedores com quota |
| Integração | `PASS` | rebase + merge na branch da missão; conflito aborta sem sujar |
| Recovery | `PASS` | órfã vira `INTERRUPTED`, sem duplicar; capacidade devolvida |
| **Dashboard em navegador real** | `PASS` | 10 specs em Chromium contra backend real |
| Tempo real (SSE) | `PASS` | dependente acende sem refetch — provado contando chamadas de `/snapshot` |
| START MISSION | `PASS` | um clique dispara tudo; duplo clique não cria dois runs |
| **Pause / resume** | `PASS` | descoberta do control plane por arquivo de runtime; sem escrita direta no banco |
| Explicabilidade de estado | `PASS` | motivo de espera, anatomia de falha e bloqueio, `NO_CHANGES` explicado |
| Observabilidade de falha | `PASS` | log do agente por tentativa, com digest, truncagem e redação |
| Doctor de ambiente | `PASS` | diagnosticou o Node incompatível na 1ª linha, com `unknown` honesto |
| **Partida em ambiente limpo** | `PASS` | `engine-strict` + teste do entrypoint oficial em diretório limpo |
| Documentação de operação | `PASS` | quickstart e troubleshooting com todo comando executado antes de publicar |
| Trilha de auditoria | `PASS` | estado + evento na mesma transação; tentativas append-only |
| Dogfooding | `PASS` | `DA-DOGFOOD-001`: o produto alterou o próprio código |

## Amostra de confiabilidade real

Todas as tentativas despachadas pelo produto com fornecedor real, nas duas missões desta
fase. Amostra pequena — 8 tentativas — declarada como tal, sem taxa percentual enganosa.

| Categoria | Ocorrências |
| --- | --- |
| Sucesso do fornecedor (task `DONE`) | 4 (T01, T02 de `DA-REAL-002`; T01 de `DA-REAL-003`; +1 revisão `PASS`) |
| Falha causada pelo **produto** | 2 (T03 a1 e a2: prompt de revisão não exigia veredito inequívoco) |
| Falha causada pela **definição da task** | 0 nesta missão (1 em `DA-CORE-002`) |
| Falha de gate | 0 |
| Falha de revisão (veredito `FAIL`) | 0 |
| Falha do fornecedor (erro da CLI) | 0 |
| Retries | 1 |
| Bloqueios | 1 (T03, tentativas esgotadas — escalou corretamente) |

**Leitura honesta:** as duas falhas foram do produto, não do agente. Foram corrigidas e
revalidadas com agente real. Nenhuma foi culpa da CLI.

## Limitações conhecidas

1. **Codex sem quota** até 2026-09-05 — bloqueia execução real e revisão cruzada real.
2. **Um só fornecedor** exercitado de ponta a ponta.
3. **Amostra pequena**: 8 tentativas reais. Suficiente para confiar com acompanhamento;
   insuficiente para afirmar taxa de acerto.
4. **Escopo é verificado, não confinado**: `SCOPE_VIOLATION` é detectado por diff depois da
   tentativa. O agente é contido pela worktree, não por sandbox de FS.
5. **Testes com paralelismo irrestrito estouram a memória** junto de agentes concorrentes.
   Use `--maxWorkers=4`. Observado nesta missão: a máquina caiu uma vez.
6. **Node ≥ 22 é obrigatório** e a violação agora falha na instalação — mas quem já tem
   `node_modules` compilado e troca de versão ainda vê o erro de módulo nativo. O `doctor`
   identifica.
7. **Sabotagem de teste** tem mitigação parcial.

## Veredito de produto

## `READY_FOR_DAILY_LOCAL_USE`

```
validated provider:            Claude Code (CLI local, assinatura)
pending dual-provider:         Codex — PENDING_ENVIRONMENT (quota até 05/09)
DUAL_PROVIDER_VALIDATION:      PENDING_ENVIRONMENT
```

Justificativa item a item do critério exigido:

| Exigência | Evidência |
| --- | --- |
| clean startup | `PASS` — teste do entrypoint oficial em diretório limpo |
| browser real | `PASS` — 10 specs em Chromium contra backend real |
| Mission start real | `PASS` — um clique, sem duplo envio |
| DAG realtime real | `PASS` — dependente acende sem refetch |
| Claude provider real | `PASS` — `DA-REAL-003` `COMPLETED` |
| múltiplas tentativas reais | `PASS` — 8 tentativas em 2 missões |
| gates | `PASS` — na worktree, com evidência citável |
| integration | `PASS` — branch da missão com os commits |
| pause/resume | `PASS` — pelo control plane, sem escrita direta |
| recovery | `PASS` — órfã vira `INTERRUPTED`, sem duplicar |
| logs | `PASS` — por tentativa, com digest e redação |
| doctor | `PASS` — pegou o Node errado antes de tudo |
| error explainability | `PASS` — o defeito de `DA-REAL-002` foi diagnosticado **pelo log que o produto grava** |
| audit trail | `PASS` — estado e evento atômicos, tentativas imutáveis |

**Por que avançar de `CONTROLLED` para `DAILY_LOCAL`:** o produto foi usado, não apenas
testado. Um desenvolvedor consegue instalar do zero, diagnosticar o ambiente, escrever uma
missão, ver o compilador recusar um plano ruim, iniciar por um clique, acompanhar pelo grafo
em tempo real, entender por que uma task espera ou falha, pausar, retomar e auditar depois.
Quando algo deu errado com agente real, o produto **explicou** — o log que ele grava foi o
que permitiu diagnosticar o próprio defeito.

**Por que o qualificador importa e não é formalidade:** um único fornecedor foi exercitado.
A revisão cruzada entre fornecedores — um dos diferenciais declarados — nunca rodou fora de
teste automatizado. Chamar isso de validação dual seria inflar o status.

**O que ainda desaconselho:** deixar rodando sozinho, sem alguém olhando o grafo. Das 8
tentativas reais, 2 falharam por defeito do produto — ambos corrigidos, mas a amostra é
pequena demais para prometer autonomia.
