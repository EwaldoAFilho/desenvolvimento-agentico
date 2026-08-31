# Matriz de prontidão do produto

> Estados objetivos, sem porcentagem. Última atualização: fim de `DA-CORE-002` (2026-08-30).
>
> `PASS` = exercitado e verificado. `BLOCKED_BY_ENVIRONMENT` = o produto está pronto, falta
> algo do ambiente. `PARTIAL` = funciona com limitação conhecida e declarada.

| Capacidade | Estado | Como foi verificado |
| --- | --- | --- |
| Leitura de missão | `PASS` | 3 arquivos declarativos com schema; os arquivos reais do repo validam |
| Compilação do grafo | `PASS` | 22 diagnósticos; reprovou o plano de `DA-CORE-002` 3× antes de aceitar |
| Escalonamento | `PASS` | função pura; inanição de revisão coberta; capacidade por fornecedor |
| Isolamento de workspace | `PASS` | worktree por tentativa, observada em 3 runs reais |
| Execução com mock | `PASS` | 1.940 testes + 52 E2E determinísticos, sem quota |
| Execução real — Claude Code | `PASS` | `T01 DONE` em 1m35s, código integrado, run `01M1AHF…` |
| Execução real — Codex | `BLOCKED_BY_ENVIRONMENT` | CLI instalada e autenticada; quota esgotada até 05/09 |
| Task gate | `PASS` | executado na worktree da tentativa, exit code e digest registrados |
| Revisão independente | `PASS` | `reviewer ≠ executor` como invariante verificada por mutação |
| Revisão cruzada real | `BLOCKED_BY_ENVIRONMENT` | exige dois fornecedores com quota |
| Integração | `PASS` | rebase + merge na branch da missão, conflito aborta sem sujar |
| Recovery | `PASS` | órfã vira `INTERRUPTED`, sem duplicar tentativa; capacidade devolvida |
| Dashboard em tempo real | `PASS` | SSE com `since`, geometria e seleção estáveis, sem polling |
| START MISSION | `PASS` | um comando dispara tudo; sem duplo envio; recusa sem aprovação |
| Pause / resume | `PARTIAL` | funciona via HTTP; `mission start` sem `--serve` deixa o run inalcançável (mensagem agora orienta) |
| Observabilidade de falha | `PASS` | log do agente persistido por tentativa, com digest, truncagem e redação |
| Doctor de ambiente | `PASS` | 5 estados por fornecedor, caminho resolvido, origem da prontidão, diagnóstico de symlink |
| Trilha de auditoria | `PASS` | estado + evento na mesma transação; tentativas append-only |
| Dogfooding | `PASS` | `DA-DOGFOOD-001`: o produto alterou o próprio código, com gate e integração |

## Limitações conhecidas

1. **Codex sem quota** até 2026-09-05. Não é defeito do produto; nenhum atalho por API foi
   usado.
2. **Revisão cruzada real** depende do item 1.
3. **`running` de fornecedor** é derivado do estado persistido; um agente despachado por um
   control plane que morreu só é reconciliado no próximo start.
4. **Escopo é verificado, não confinado**: `SCOPE_VIOLATION` é detectado por diff depois da
   tentativa. O agente é contido pela worktree, não por sandbox de FS.
5. **`--permission-mode acceptEdits` / `--sandbox workspace-write`**: o produto concede ao
   agente permissão de edição dentro da worktree. É o mínimo necessário; nenhum flag
   "dangerously" é usado.
6. **Sabotagem de teste** tem mitigação parcial (arquivo de teste fora de `touches`
   reprova; o revisor vê o diff completo).

## Veredito de produto

## `READY_FOR_CONTROLLED_REAL_USE`

Justificativa, item a item do que o critério exige:

- **execução com fornecedor real** — sim, ponta a ponta, com código integrado;
- **dogfooding** — sim, o produto alterou o próprio código, com gate e integração;
- **recovery** — sim, coberto por teste e por defeito corrigido em uso;
- **dashboard usável** — sim, com tempo real, motivo de espera e UX de falha;
- **gates** — sim, reproduzíveis, na worktree da tentativa;
- **trilha de auditoria** — sim, estado e evento atômicos, tentativas imutáveis.

**Por que não `READY_FOR_DAILY_LOCAL_USE`:** um único fornecedor foi exercitado de ponta a
ponta. A revisão cruzada real — que é um dos diferenciais declarados do produto — nunca
rodou fora de teste. E das 6 tentativas reais despachadas pelo produto, 4 falharam: três por
um defeito já corrigido, uma por definição de task equivocada. A taxa de acerto em uso real
ainda não foi medida numa amostra que autorize a palavra "diário".

**Por que não `NOT_READY_FOR_REAL_USE`:** o produto executou trabalho real, integrou código
real, corrigiu a si próprio, e em nenhum momento mentiu sobre `DONE` — inclusive recusando
concluir uma missão cujo gate reprovou, e recusando marcar sucesso quando o agente não
entregou.
