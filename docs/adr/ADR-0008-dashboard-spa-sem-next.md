# ADR-0008 — Dashboard SPA servido pelo próprio servidor (sem Next.js)

**Status:** Aceita · **Data:** 2026-08-30

## Contexto

O documento fundador levantou Next.js como possibilidade natural. O dashboard do MVP é
read-heavy, local, monousuário, com atualização ao vivo e um DAG interativo como elemento
central.

## Decisão

SPA em **Vite + React**, build estático servido pelo mesmo processo do control plane
(`apps/server`, Fastify). Dados por REST (snapshot) + SSE (incremental). Grafo com
`@xyflow/react` e layout `dagre`.

## Alternativas

- **Next.js.** Traria um segundo servidor (Node runtime, rotas, SSR) ao lado do nosso, com
  duas noções de "backend" e mais superfície para o estado divergir. SEO, SSR e roteamento de
  aplicação não têm valor aqui: é uma ferramenta local atrás de `127.0.0.1`.
- **Terminal UI apenas.** A visualização do DAG é requisito de produto ("queremos enxergar o
  desenvolvimento acontecendo").
- **Renderizar o grafo à mão em SVG.** Layout de DAG hierárquico não é trabalho trivial;
  `dagre` é biblioteca genérica consolidada.

## Consequências

+ Um processo, uma fonte de verdade, um deploy local.
+ Tipos do contrato compartilhados com `packages/schemas` sem cliente gerado.
− Sem SSR (irrelevante).
− O servidor precisa servir estáticos (trivial no Fastify).
