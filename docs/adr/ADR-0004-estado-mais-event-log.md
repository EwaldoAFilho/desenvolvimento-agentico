# ADR-0004 — Estado materializado + event log, não event sourcing

**Status:** Aceita · **Data:** 2026-08-30

## Contexto

Queremos responder "o que está acontecendo agora" (operação) e "o que aconteceu e por quê"
(auditoria). São necessidades diferentes com custos diferentes.

## Decisão

Modelo híbrido: tabelas de **estado corrente** + **log append-only** de eventos, gravados na
**mesma transação**. O estado é a fonte para operação; o log é a fonte para auditoria e
timeline. Nenhum dos dois é derivado do outro em runtime — a atomicidade garante coerência.

## Alternativas

- **Event sourcing puro.** Estado só como projeção. Traz versionamento de evento, replay,
  projeções e reconstrução — maquinário caro cujo benefício (viagem no tempo, reprocessamento
  de projeção) não temos caso de uso.
- **Só estado corrente.** Perde histórico de tentativa, timeline e auditoria — que são o
  produto (P12).
- **Só log.** Toda leitura vira replay; dashboard e CLI ficam caros.

## Consequências

+ Consulta operacional direta; auditoria completa; impossível divergir.
+ Dashboard usa snapshot + stream incremental de eventos, sem polling.
− Duas escritas por transição (custo irrelevante nesta escala).
− Disciplina obrigatória: quem altera estado sem emitir evento quebra I1 — coberto por teste.
