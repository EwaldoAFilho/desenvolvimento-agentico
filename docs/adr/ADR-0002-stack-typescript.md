# ADR-0002 — TypeScript/Node em todo o control plane

**Status:** Aceita · **Data:** 2026-08-30

## Contexto

O control plane precisa: orquestrar processos locais, falar com CLIs de agentes, manipular
git, servir uma API e um dashboard, e compartilhar contratos entre servidor e UI.

A linguagem do control plane **não restringe o projeto orquestrado**: a fronteira com o
projeto-alvo são comandos de shell (gates) e operações de git. Um projeto Python, Java, Go ou
Rust é orquestrado exatamente igual.

## Decisão

TypeScript estrito sobre Node 24 em toda a stack: domínio, engine, adapters, CLI, servidor e
dashboard. Bibliotecas genéricas e consolidadas: `zod` (validação), `yaml` (parser),
`fastify` (HTTP), `better-sqlite3` (persistência), `vitest` (teste), `commander` (CLI),
`@xyflow/react` + `dagre` (grafo na UI), `biome` (lint/format).

Nenhuma dessas define o modelo de produto: engine, domínio, máquina de estados, protocolo de
agentes e contratos de execução são implementação nossa.

## Alternativas

- **Python.** Excelente ecossistema de IA, mas o dashboard exigiria uma segunda linguagem e
  os contratos seriam duplicados. O trabalho pesado aqui é processo, git e UI — não ML.
- **Go.** Ótimo para concorrência e binário único; perde o compartilhamento de tipos com a
  UI e afasta o público que vai estender a ferramenta.
- **TS no core + UI separada em outra linguagem.** Sem ganho.

## Consequências

+ Um só modelo de tipos do YAML até o pixel do dashboard.
+ Público-alvo consegue ler e estender.
− Concorrência real depende de processos filhos (é exatamente o nosso caso de uso).
− `better-sqlite3` é módulo nativo (compilação na instalação). Contido atrás da porta
  `RunStore`; `node:sqlite` é alternativa de troca barata se virar problema.
