# ADRs — Architecture Decision Records

Registro de decisões estruturais. Formato: contexto → decisão → alternativas → consequências.
Só decisões relevantes: não criamos ADR para escolha trivial.

| ADR | Decisão | Status |
| --- | --- | --- |
| [0001](ADR-0001-monorepo-e-fronteiras.md) | Monorepo npm workspaces com fronteiras verificadas | Aceita |
| [0002](ADR-0002-stack-typescript.md) | TypeScript/Node em todo o control plane | Aceita |
| [0003](ADR-0003-persistencia-sqlite.md) | SQLite embarcado + artefatos em arquivo | Aceita |
| [0004](ADR-0004-estado-mais-event-log.md) | Estado materializado + event log (não event sourcing) | Aceita |
| [0005](ADR-0005-representacao-do-grafo.md) | Grafo compilado imutável derivado de YAML declarativo | Aceita |
| [0006](ADR-0006-control-plane-dono-do-estado.md) | Control plane é o único dono do estado; evidência é observada | Aceita |
| [0007](ADR-0007-isolamento-git-worktree.md) | Isolamento por git worktree por tentativa | Aceita |
| [0008](ADR-0008-dashboard-spa-sem-next.md) | Dashboard SPA servido pelo próprio servidor (sem Next.js) | Aceita |
| [0009](ADR-0009-local-subscription-first.md) | Execução local subscription-first: agentes via CLIs já autenticadas | Aceita |
| [0010](ADR-0010-dois-providers-locais-no-mvp.md) | Dois providers reais locais no MVP + suíte de contrato única | Aceita |
| [0011](ADR-0011-politica-de-revisao-cruzada.md) | Política de revisão cruzada entre fornecedores | Aceita |
| [0012](ADR-0012-process-e-agent-runtime.md) | Process Runtime e Local Agent Runtime como pacotes próprios | Aceita |
| [0013](ADR-0013-ownership-do-control-plane.md) | Posse do projeto por lock SQLite dedicado (I14) | Aceita |
