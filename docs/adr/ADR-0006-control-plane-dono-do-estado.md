# ADR-0006 — Control plane é o único dono do estado; evidência é observada

**Status:** Aceita · **Data:** 2026-08-30

## Contexto

O modo natural (e errado) de construir isto é deixar o agente reportar o que fez e o
orquestrador acreditar. É a origem de "terminei, está funcionando" sem prova, do autor que
aprova o próprio trabalho e da conclusão que não se sustenta.

## Decisão

Duas fronteiras rígidas:

1. **Escrita de estado**: apenas o orquestrador escreve estado de run. Agentes não têm acesso
   ao banco. Eles produzem arquivos em um workspace; o control plane decide o que isso
   significa.
2. **Origem da evidência**: o relatório do agente é `AgentOutcome.claims`. Ele **é
   armazenado** — serve para depurar, para o relatório e para analisar o processo — e é
   informação operacional legítima. O que ele não é: evidência. `claims` **nunca é suficiente
   para levar uma task a `DONE`** e não participa de nenhuma transição de estado.
   Os fatos vêm de `Observation`, produzida pelo control plane: `git diff` que nós rodamos,
   exit code de processo que nós executamos, commit que nós criamos. Escopo, diff, gates,
   resultados e commits continuam sendo coletados por nós, sob qualquer provider — inclusive
   os locais (ADR-0009), que não mudam nada nesta decisão.

Corolários: `touches` é verificado a posteriori (`SCOPE_VIOLATION`); gates vêm de arquivo
versionado, nunca do agente; `executor ≠ reviewer` é invariante do sistema, não instrução de
prompt.

## Alternativas

- **Confiar no relato do agente** (com prompt pedindo honestidade). Não é verificável e falha
  exatamente quando mais importa.
- **Agente escreve estado via API.** Superfície de corrupção do estado oficial e fim da fonte
  única de verdade.
- **Confiança graduada por histórico do agente.** Complexidade sem necessidade: medir é mais
  barato que confiar.

## Consequências

+ Conclusão é auditável e reproduzível por humano.
+ Trocar de fornecedor de IA não afeta a qualidade da evidência.
+ Alucinação de progresso deixa de ser um risco de produto.
− Custo de execução: rodamos gates nós mesmos, o que gasta tempo de máquina.
− Não protege contra um agente que sabota o teste em vez do código — mitigado pelo
  `SCOPE_VIOLATION` (arquivo de teste fora do `touches`) e pela revisão do diff.
