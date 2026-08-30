# ADR-0001 — Monorepo npm workspaces com fronteiras verificadas

**Status:** Aceita · **Data:** 2026-08-30

## Contexto

O produto tem domínio puro, vários adapters, um servidor, uma CLI e um dashboard que
compartilham contratos. Precisamos de fronteiras arquiteturais reais (domínio não conhece
infraestrutura) e de tipos compartilhados sem duplicação.

## Decisão

Monorepo com **npm workspaces**, dividido em `apps/` (cli, server, web) e `packages/`
(domain, schemas, graph, compiler, persistence, gates, workspace, providers, orchestrator).

A regra de dependência entre camadas é **verificada por lint** (import boundaries), não
confiada à disciplina: um import de infraestrutura dentro de `domain` quebra o build.

Cada pacote precisa justificar-se por uma fronteira de teste ou substituição real. Ficaram
de fora, deliberadamente: `events`, `metrics`, `common/utils`, `api-client`, `logger`.

## Alternativas

- **Pacote único com pastas.** Mais simples no início; a fronteira vira convenção e erode na
  primeira pressa. Como a separação domínio/adapter é tese central do produto, o custo de
  perdê-la é maior que o overhead do workspace.
- **pnpm workspaces.** Tecnicamente superior em disco e em rigor de resolução. Preterido
  por uma razão do próprio produto: esta é uma ferramenta que o usuário instala e estende, e
  `npm` já vem com o Node — zero pré-requisito adicional para clonar, buildar e contribuir.
  Não usamos nenhum recurso específico de gerenciador, então migrar é mudança de
  configuração, não de arquitetura.

  **Isto não impõe nada ao projeto orquestrado.** O gerenciador do nosso repositório e o do
  repositório-alvo são independentes: gates são comandos de shell declarados pelo próprio
  projeto-alvo, que pode usar pnpm, yarn, Maven, Poetry, Cargo ou Make.
- **Nx / Turborepo.** Orquestração de build que ainda não precisamos; a ironia de adicionar
  um orquestrador de terceiros ao nosso orquestrador não passou despercebida.

## Consequências

+ Fronteiras verificáveis; domínio testável sem I/O; adapters substituíveis.
+ Contratos compartilhados sem duplicar tipo.
− Overhead de configuração inicial (task T01).
− Sem cache de build incremental; aceitável nesta escala.
