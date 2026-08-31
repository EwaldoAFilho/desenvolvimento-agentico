# DA-DOGFOOD-001 — o produto desenvolvendo o próprio produto

> Run real, no repositório real, com fornecedor real. A prova está no banco, no event log e
> nas branches — não neste texto.

## Identificação

| | |
| --- | --- |
| Mission | `DA-DOGFOOD-001` · specHash `fnv1a64:55bf7c52dec34f3f` |
| Run | `01M1AHP7VY78XVE1HV1MK3AA7X` |
| Repositório-alvo | o próprio produto (`mission/DA-CORE-002` em `983d158`) |
| Fornecedor | `claude-code` — Claude Code CLI 2.1.220, assinatura claude.ai |
| Aprovação | humana, `actor: supervisor-DA-CORE-002`, evento `human.mission_approved` |
| Compilação | 0 ERROR · 0 WARNING · 0 INFO · T01 ∥ T02 · 0 conflito de touches |

## Tasks

| Task | Estado | Tent. | Duração | Resultado |
| --- | --- | --- | --- | --- |
| T01 Não fabricar timestamp no log do agente | `DONE` | 1 | 2m24s | commit `983d158`, +20 −3 em `agent-log.ts` |
| T02 Unificar redação de segredo na CLI | `NO_CHANGES` → `RETRY` | 1 | — | a definição da task estava errada (ver abaixo) |

## O que o produto escreveu em si mesmo (T01)

`packages/orchestrator/src/engine/agent-log.ts` — o agente introduziu um campo que marca
quando o horário foi atribuído pela captura em vez de vir do evento:

```ts
/** Valor de `tsSource`: horario atribuido pelo relogio da captura, nao pelo agente. */
export const TS_SOURCE_CAPTURE = 'capture'

/**
 * Horario da linha e de onde ele saiu. `ts` ausente ou invalido nao vira epoch: 1970-01-01
 * seria indistinguivel de um horario real para quem le o artefato depois, e o log e
 * evidencia de diagnostico — nao pode fabricar dado.
 */
```

Isolamento: worktree `.agentic/worktrees/01M1AHP7VY78XVE1HV1MK3AA7X/T01-a1`, branch
`task/DA-DOGFOOD-001/T01/a1`, integrada em `mission/DA-DOGFOOD-001`.
Gate `unit` (lint + typecheck + 1.940 testes) executado **na worktree da tentativa**.

O control plane coordenador não foi afetado: rodava do diretório principal com seu código já
carregado, enquanto os agentes escreviam em worktrees separadas (item 18).

## O achado mais valioso: T02

T02 falhou com `NO_CHANGES`. O log do agente — que só existe por causa da correção feita
nesta mesma missão — explica exatamente por quê:

> *"Nenhuma alteração entregue: `apps/cli/src/redact.ts` já importa `redactSecrets` de
> `@agentic/process` e não contém cópia — a duplicação real é
> `packages/orchestrator/src/engine/redact.ts`, fora do escopo."*

**O agente estava certo e a definição da task estava errada.** Verificado:
`apps/cli/src/redact.ts` de fato importa o canônico; a cópia real está em
`packages/orchestrator/src/engine/redact.ts`, que eu não declarei em `touches`.

O que aconteceu, em ordem:

1. o agente investigou e descobriu que a premissa da task era falsa;
2. **recusou-se a inventar trabalho fora do `touches` declarado**;
3. recomendou ao dono da missão a correção do plano;
4. o produto registrou `NO_CHANGES` — não fingiu sucesso, não marcou `DONE`.

Três invariantes do produto funcionando ao mesmo tempo, num caso que ninguém desenhou:
escopo é contrato, `DONE` exige fato, e o log torna a falha diagnosticável. Antes desta
missão, este mesmo evento teria sido um `NO_CHANGES` mudo.

## Métricas

```
wall time do run     ~4 min
tasks                2  ·  DONE 1  ·  NO_CHANGES 1
tentativas           3  ·  retries 1  ·  reprovações de review 0
gates executados     1 (unit, na worktree de T01) — exit 0
despachos reais      3 (T01-a1, T02-a1, T02-a2)
```

## Intervenção humana (item 56)

Registrada, não omitida:

- eu **defini** a missão (ato humano por design — `.agentic/` está em `denyPaths`);
- eu **aprovei** a missão (`human.mission_approved` com actor);
- eu **encerrei** o run após a segunda tentativa de T02, porque a retry falharia
  identicamente e queimaria quota — a causa era a definição da task, não o agente;
- eu **não** corrigi manualmente nenhum código que o agente deveria ter escrito.

T01 foi executada, verificada e integrada sem intervenção.
