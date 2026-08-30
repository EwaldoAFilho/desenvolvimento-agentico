# ADR-0007 — Isolamento por git worktree por tentativa

**Status:** Aceita · **Data:** 2026-08-30

## Contexto

Paralelismo real exige que dois agentes escrevam ao mesmo tempo. Mesmo com `touches`
disjuntos, uma working tree compartilhada quebra três coisas: atribuição do diff, gate
reproduzível (o gate de A vê o código meio-escrito de B) e operações de git de um agente
afetando o outro.

## Decisão

`WorkspaceProvider` como porta, com dois adapters:

- **`git-worktree`** (default quando o alvo é repositório git): uma worktree por **tentativa**,
  em branch `task/<missionId>/<taskId>/a<N>` a partir de `mission/<missionId>`. Gate roda
  dentro dela. Aprovada, a tentativa é integrada via rebase + merge pelo `Integrator`.
- **`shared`**: uma árvore só, com paralelismo de escrita forçado a 1.

Configurar `shared` com `maxParallelTasks > 1` é erro de compilação (`DA1010`) e falha no
`doctor`.

Conflito de integração é estado previsto (`INTEGRATION_CONFLICT`), retentável — a nova
tentativa parte da base já atualizada.

## Alternativas

- **Clone por task.** Isolamento igual, custo de disco e tempo muito maior; worktree
  compartilha o object store.
- **Container por task.** Isolamento mais forte, mas exige que todo projeto-alvo tenha
  imagem pronta. Fica como evolução, atrás da mesma porta.
- **Só lock lógico sem isolamento físico.** Não resolve gate nem atribuição de diff.

## Consequências

+ Paralelismo com evidência atribuível e gate reproduzível.
+ Branch da missão pronta para PR ao final.
+ Tentativa que falhou pode ser preservada para perícia.
− Dependência de git no projeto-alvo (modo `shared` cobre o resto).
− Custo de disco por tentativa e casos de borda (hooks, submódulos, arquivos grandes) —
  concentrados na task T08, de risco alto.
− Projetos cujo build depende de caminho absoluto ou de `node_modules` na raiz exigem
  atenção; documentado como limitação conhecida.
