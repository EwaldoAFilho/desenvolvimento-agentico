# ADR-0012 — Process Runtime e Local Agent Runtime como pacotes próprios

**Status:** Aceita · **Data:** 2026-08-30

## Contexto

Com agentes locais (ADR-0009), a plataforma passa a gerenciar dois tipos bem diferentes de
processo:

| | Gate | Agente |
| --- | --- | --- |
| Duração | segundos a minutos | minutos a dezenas de minutos |
| Saída | capturada e comparada | transmitida e arquivada |
| Ciclo | executa e termina | inicia, observa, pode ser cancelado |
| Falha típica | exit code ≠ 0 | timeout, cancelamento, CLI ausente, não autenticado |

O que os dois compartilham é a parte mais perigosa: spawn, sinais, encerramento de árvore de
processos, allowlist de ambiente, buffers que não podem estourar memória.

## Decisão

Dois pacotes:

- **`packages/process`** — primitivo de sistema operacional: `spawn` com `cwd` e allowlist,
  streaming, timeout, cancelamento com tree-kill, status de saída normalizado, truncamento
  com digest. Não conhece domínio, gate nem agente.
- **`packages/agent-runtime`** — `LocalAgentRuntime`: descoberta de executável, versão,
  prontidão (`probe`), `spawn` **sempre com `cwd` na worktree da tentativa**, handle com pid,
  streams e status. Conhece "agente local"; não conhece Mission, Task nem estado de run.

`packages/gates` passa a usar `process` em vez de ter o seu próprio executor.

Camadas resultantes: `process` → `agent-runtime` → `providers` → `orchestrator`. Três
traduções, três responsabilidades: processo → agente → resultado de tentativa → transição de
estado.

## Alternativas

- **Manter tudo em `gates`.** Um pacote chamado "gates" contendo o runtime dos agentes é
  nome mentiroso, e acopla dois ciclos de vida diferentes.
- **Colocar o runtime dentro de `providers`.** Cada adapter reimplementaria (ou
  compartilharia informalmente) o tratamento de sinais e tree-kill — exatamente o código onde
  duplicação vira bug de sistema.
- **Um único pacote `runtime`.** Misturaria o primitivo genérico com a semântica de agente,
  e impediria testar tree-kill isoladamente do conceito de provider.

## Consequências

+ O código específico de sistema operacional existe em um lugar só, testado uma vez.
+ Runtime em container ou remoto entra pela mesma porta, sem tocar adapters nem domínio.
+ Habilita paralelismo real no plano: `T16` roda na onda 2, `T17` na onda 3.
− Dois pacotes a mais (18 → 20 unidades de fronteira no repositório).
− `T09` passa a depender de `T17`, criando a cadeia quase crítica de folga 1 (risco R4).
