# CLAUDE.md — contexto para assistentes de IA

Orientações para agentes trabalharem neste repositório. Humanos: comece pelo
[README.md](README.md).

## O que é

**Desenvolvimento Agêntico**: control plane para coordenar múltiplos agentes de IA em uma
entrega de software, via DAG explícito, isolamento de tarefas, revisão independente, quality
gates reproduzíveis e evidência observada.

Estado: **gate de planejamento concluído, implementação não iniciada**. A próxima missão é
`DA-CORE-001` (ver [docs/development/MVP-PLAN.md](docs/development/MVP-PLAN.md)).

## Regra de contexto (obrigatória)

Antes de qualquer mudança arquitetural relevante, leia:

1. [docs/product/VISION.md](docs/product/VISION.md)
2. [docs/product/PRODUCT-PRINCIPLES.md](docs/product/PRODUCT-PRINCIPLES.md)
3. [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md)
4. [docs/architecture/DOMAIN-MODEL.md](docs/architecture/DOMAIN-MODEL.md)
5. [docs/development/AGENTIC-DEVELOPMENT-METHOD.md](docs/development/AGENTIC-DEVELOPMENT-METHOD.md)

Esses documentos são a memória durável do produto. **Uma nova sessão não redefine o projeto
silenciosamente.** Divergir deles exige ADR novo em `docs/adr/`, com contexto, alternativas e
consequências — não uma decisão embutida no código.

## Regra de independência

Este produto é implementação própria. **Não** fazer fork, clonar, copiar implementação
externa nem modelar a arquitetura para reproduzir outra ferramenta. Bibliotecas genéricas e
consolidadas (framework web, validação, banco, parser YAML, grafo na UI) são bem-vindas
quando fizerem sentido técnico. O que precisa ser nosso: modelo de produto, engine de
orquestração, domínio, máquina de estados, protocolo dos agentes, contratos de execução e
governança.

## Invariantes que não se negociam

| # | Invariante |
| --- | --- |
| I1 | Toda mutação de estado grava estado **e** evento na mesma transação |
| I2 | Duas tasks em `RUNNING` nunca têm `touches` sobrepostos |
| I3 | `reviewer ≠ executor` quando `requireReview` |
| I4 | `attemptCount ≤ maxAttempts` |
| I5 | Tentativa encerrada nunca é alterada |
| I6 | `DONE` só com evidência de escopo, gate e revisão exigidos |
| I7 | O orquestrador é o único escritor do estado do run |
| I8 | Nenhuma task em `RUNNING` sem workspace lease válido |
| I9 | Nenhum despacho excede `maxConcurrent` do provider escolhido |
| I10 | `cross-provider-required` nunca é rebaixada em silêncio |
| I11 | Todo processo de agente inicia com `cwd` na worktree da tentativa |
| I12 | Run em `VERIFYING` tem mission gate em voo **ou** resultado de gate persistido |

E a regra que sustenta o produto inteiro: **o relato do agente (`claims`) é armazenado como
informação operacional, mas nunca decide uma transição de estado nem basta para `DONE`.**
Fato é o que o control plane mediu.

Mais duas que não se negociam:

- **Subscription-first (P17):** nenhum provider real pode exigir API key. Agentes são CLIs
  locais já autenticadas pelo usuário. Não lemos, não guardamos e não injetamos credencial.
- **Independência (P18):** nada no domínio pode citar fornecedor, CLI ou organização.
  `ProviderId` é string opaca vinda de configuração. Nenhuma ADR se justifica por
  compatibilidade com uma empresa.

## Fronteiras de código

```text
interfaces ──► application ──► domain ◄── adapters
```

`packages/domain` não importa Fastify, React, SQLite, git, nem provider algum. Portas são
declaradas no domínio, implementadas fora. A regra é verificada por lint — não é convenção.

## Ao contribuir

1. **Documentação no mesmo commit.** Mudança estrutural → ADR. Mudança de formato →
   `docs/architecture/MISSION-FORMAT.md` e bump de `apiVersion` se incompatível.
2. **Qualidade antes do PR:** `npm run verify` (lint + typecheck + test). TypeScript estrito.
3. **Teste sem LLM.** O orquestrador é testado com o provider `mock`. Teste que exige agente
   real não entra na suíte.
4. **Não reformatar o repositório inteiro.**
5. **Segredos:** nunca commitar `.env`. `.agentic/state.db`, `.agentic/runs/` e
   `.agentic/worktrees/` são locais e gitignored.

## Mapa rápido (quando existir código)

| Quero... | Vá em |
| --- | --- |
| Entidade, estado, regra pura | `packages/domain/` |
| Formato de arquivo, contrato de API | `packages/schemas/` |
| Validação e análise do DAG | `packages/compiler/` (algoritmos em `packages/graph/`) |
| Decisão de o que despachar | `packages/orchestrator/src/scheduler/` |
| Ciclo de execução, retry, escalonamento | `packages/orchestrator/src/engine/` |
| Executar comandos de gate | `packages/gates/` |
| Spawn, timeout, tree-kill, env | `packages/process/` (único lugar com código de SO) |
| Ciclo de vida de agente local | `packages/agent-runtime/` |
| Worktree, diff, escopo, merge | `packages/workspace/` |
| Integrar um agente novo | `packages/providers/` (implemente a porta + passe na suíte de contrato; não toque no domínio) |
| Tela do DAG | `apps/web/` |
