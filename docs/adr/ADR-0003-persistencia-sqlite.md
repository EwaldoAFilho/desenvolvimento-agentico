# ADR-0003 — SQLite embarcado + artefatos em arquivo

**Status:** Aceita · **Data:** 2026-08-30

## Contexto

Precisamos guardar estado do run, tentativas, revisões, execuções de gate e um log de eventos
append-only, com garantia transacional (estado e evento nunca divergem) e sobrevivência a
queda do processo. Volume: dezenas a centenas de tasks, milhares de eventos. Ferramenta
local, single-writer.

## Decisão

**SQLite** (modo WAL) em `.agentic/state.db` para estado e eventos.
**Arquivos** em `.agentic/runs/<runId>/` para artefatos volumosos: patches, logs de agente,
saídas de gate — referenciados no banco por caminho + digest.

## Alternativas

- **Arquivos JSON.** Simples até a primeira escrita concorrente ou queda no meio de uma
  gravação. Não há transação: exatamente a garantia que o invariante I1 exige. Recusado.
- **PostgreSQL.** Traz servidor, migração operacional e Docker para uma ferramenta local.
  Sem caso de uso presente (P16).
- **Event log em arquivo + estado em memória.** Reconstrução a cada consulta; dashboard
  ficaria caro; e perderíamos consulta ad-hoc para auditoria.

## Consequências

+ Transação real, leitura concorrente, zero operação, arquivo único versionável/descartável.
+ SQL ad-hoc para auditoria e métricas sem construir ferramenta.
− Escritor único (é a nossa arquitetura de qualquer forma — I7).
− Blobs grandes fora do banco exigem gestão de ciclo de vida dos artefatos.
