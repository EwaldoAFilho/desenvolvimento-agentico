# ADR-0005 — Grafo compilado imutável derivado de YAML declarativo

**Status:** Aceita · **Data:** 2026-08-30

## Contexto

O DAG é o coração operacional. Precisa ser: escrito e revisado por humanos, validável antes
de executar, determinístico, comparável entre execuções e estável durante um run.

## Decisão

1. **Declaração** em YAML (`mission.yaml`), com dependências explícitas por id de task.
2. **Compilação** para um `CompiledGraph` imutável, determinístico e hasheável (`specHash`),
   contendo nós, arestas, ordem topológica canônica, waves, caminho crítico, matriz de
   concorrência, conflitos de escopo e diagnósticos.
3. **Congelamento**: o grafo é gravado no `Run` no início. Editar o YAML durante a execução
   não afeta o run corrente.
4. Estrutura interna: listas de adjacência + fecho transitivo pré-computado. Sem banco de
   grafos, sem biblioteca de grafos — os algoritmos necessários (Kahn, Tarjan, longest path)
   são conhecidos, curtos e ficam em `packages/graph`, testados e determinísticos.

## Alternativas

- **Grafo mutável em runtime.** Permitiria replanejamento, mas dissolve a auditoria: o plano
  executado deixa de ser identificável. Replanejamento vira operação explícita no futuro.
- **Banco de grafos (Neo4j) ou biblioteca pesada.** Escala e consultas que não precisamos.
- **Ordem inferida de texto/heurística.** Viola P02.
- **JSON em vez de YAML.** Pior para humano (sem comentário, sem bloco multilinha). O parser
  não vaza para o domínio.

## Consequências

+ Erro de plano aparece antes de qualquer agente rodar.
+ Mesma missão → mesmo grafo → execuções comparáveis.
+ Grafo é dado serializado: dashboard e relatório o consomem sem recompilar.
− Mudança de plano exige nova compilação e (futuramente) operação de replan.
