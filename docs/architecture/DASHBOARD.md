# DASHBOARD — observabilidade da execução

> Objetivo: **enxergar o desenvolvimento acontecendo** — e dar a partida. Legibilidade
> operacional acima de decoração. O dashboard é uma projeção do estado oficial (não guarda
> estado próprio) com um conjunto pequeno e deliberado de comandos.
>
> O que ele **não** é: editor de missão. O YAML continua sendo o contrato versionado.

## 1. Layout

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ DA-BPM-021  Refinar painel de propriedades BPM        ● RUNNING   12:47      │
│ 17 tasks · 9 DONE · 3 RUNNING · 1 REVIEW · 1 BLOCKED · 3 PENDING            │
│ wall time 34min · tentativas 21 · retries 4 · paralelismo 2,4×  [⏸] [■]     │
│ claude-code ●2/3   codex ●1/2   ⓘ ready unknown                            │
├───────────────────────────────────────────────┬──────────────────────────────┤
│                                               │  TASK T04                    │
│   FOUNDATION ─────────────────────────────    │  Endpoint de gravação        │
│    ┌──────┐   ┌──────┐                        │  ─────────────────────────   │
│    │ T01 ✔│   │ T02 ✔│                        │  Fase      backend           │
│    └───┬──┘   └──┬───┘                        │  Estado    ▶ RUNNING (4m12s) │
│        │         │                            │  Tentativa 2 de 3            │
│   BACKEND ───────┼────────────────────────    │  Executor  backend-executor  │
│        ▼         ▼                            │  Depende   T01 ✔  T02 ✔      │
│    ┌──────┐   ┌──────┐                        │  Destrava  T09  T13          │
│    │ T03 ✔│──►│ T04 ▶│                        │  Escopo    apps/api/src/bpm/ │
│    └──────┘   └───┬──┘                        │  Gate      backend           │
│                   │                           │  ─────────────────────────   │
│   FRONTEND ───────┼────────────────────────   │  TENTATIVA 1  ✖ REVIEW_FAILED│
│                   ▼                           │   403 ausente p/ sem permissão│
│    ┌──────┐   ┌──────┐   ┌──────┐             │   npm test -w api → 35/2 ✖   │
│    │ T05 ⟳│   │ T06 ⊘│   │ T07 ○│             │  TENTATIVA 2  em andamento   │
│    └──────┘   └──────┘   └──────┘             │  ─────────────────────────   │
│                                               │  [ver diff] [logs] [retry]   │
├───────────────────────────────────────────────┴──────────────────────────────┤
│ 12:46:58 task.T04.attempt_started    attempt=2 executor=backend-executor      │
│ 12:46:57 task.T04.retry_scheduled    reason=REVIEW_FAILED backoff=15s         │
│ 12:46:41 review.T04.failed           reviewer=reviewer findings=1             │
└──────────────────────────────────────────────────────────────────────────────┘
```

Três zonas: **cabeçalho** (missão e saúde do run), **canvas do DAG** (elemento principal) e
**painel de detalhe**; rodapé com o stream de eventos, recolhível.

## 2. Nó da task

Mínimo sempre visível: `ID`, `título` (truncado), `estado` (cor + ícone + rótulo), `fase`
(pelo agrupamento). Conforme o zoom permitir: executor, duração corrente, `tentativa N/M`.

```text
┌────────────────────────────┐
│ T04  ▶ RUNNING      2/3    │
│ Endpoint de gravação       │
│ backend-executor    4m12s  │
└────────────────────────────┘
```

## 2.1 START MISSION

Antes do run existir, a mesma tela mostra a missão compilada e o botão de partida:

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ DA-BPM-021  Refinar painel de propriedades BPM              ○ APPROVED       │
│ 17 tasks · 4 fases · caminho crítico 5 tasks · 2 avisos                      │
│                                                                              │
│   ⚠ DA2001  T07 e T09 escrevem em apps/web/src/contracts/ sem dependência    │
│   ⚠ DA2007  T12 tem risk: high com requireReview: false                     │
│                                                                              │
│ Providers   claude-code  installed ✔  ready ?  cap 3        │              │
│             codex        installed ✔  ready ?  cap 2        │ [START MISSION]│
└──────────────────────────────────────────────────────────────────────────────┘
```

Um clique. O usuário **não** dispara task a task: o orquestrador descobre todas as `READY` e
despacha conforme as políticas.

```text
[START MISSION] → POST /api/runs → StartRun → Orchestrator → Scheduler → Providers
                                                     │
                                          eventos → SSE → o DAG se preenche sozinho
```

Regras da operação:

- exige missão `APPROVED`; aprovar é ato humano registrado com `actor` (pode ser feito aqui,
  mostrando os diagnósticos antes);
- com `WARNING` pendente, o botão exige confirmação explícita — os avisos ficam à vista, não
  escondidos atrás de um "ok";
- com qualquer `ERROR`, não há botão: há a lista de erros e o caminho para corrigir o YAML;
- se algum provider necessário estiver indisponível, o aviso aparece **antes** da partida.

## 3. Linguagem visual de estados

| Estado | Ícone | Cor | Forma da borda |
| --- | --- | --- | --- |
| `PENDING` | `○` | cinza | tracejada |
| `READY` | `◔` | azul | sólida fina |
| `RUNNING` | `▶` | azul forte | sólida grossa + pulso sutil |
| `VERIFYING` | `⚙` | roxo | sólida grossa |
| `REVIEW` | `⟳` | roxo | sólida grossa |
| `INTEGRATING` | `⇉` | ciano | sólida grossa |
| `DONE` | `✔` | verde | sólida fina |
| `FAILED` | `✖` | vermelho | sólida grossa |
| `RETRY` | `↻` | laranja | tracejada grossa |
| `BLOCKED` | `⊘` | âmbar | dupla |
| `SKIPPED` | `—` | cinza claro | tracejada |
| `CANCELLED` | `⊗` | cinza escuro | tracejada |

Regra de acessibilidade: **cor nunca é o único diferenciador** — sempre acompanha ícone e
rótulo textual. Um daltônico e uma captura em preto e branco precisam funcionar.

Arestas: cinza (dependência não satisfeita), verde (satisfeita), âmbar tracejada (destino
bloqueado). Aresta do caminho crítico com traço mais espesso.

## 4. Agrupamento por fase

Faixas horizontais por `phase` na ordem declarada; arestas atravessam faixas livremente (uma
task de `FRONTEND` pode depender de `FOUNDATION` sem passar por `BACKEND`). Fases servem à
leitura, não à ordem — se o desenho sugerir o contrário, o desenho está mentindo (P02).

Alternância de visualização: **por fase** (default) · **por onda** (earliest start) ·
**topológico puro**. Layout com `dagre`, direção configurável; posições estáveis entre
atualizações — nó não pode dançar a cada evento.

## 5. Painel de detalhe

O card mostra pouco; o painel lateral mostra tudo. Campos que o design precisa comportar:

| Grupo | Campos |
| --- | --- |
| Identidade | id, título, descrição, objetivo, fase, estado |
| Grafo | dependências (com estado de cada uma), dependentes, posição no caminho crítico |
| Escopo | `touches`, `reads`, violações de escopo detectadas |
| Execução | **provider**, executor (perfil + modelo), tentativa N/M, início, duração |
| Revisão | **revisor** (perfil + **provider**), política de revisão aplicada e se foi rebaixada, veredito, findings |
| Isolamento | **worktree** (caminho), **branch**, commit base, commit da tentativa |
| Qualidade | contrato de validação, gate executado, comando + exit code + duração de cada passo |
| Fatos | observações (arquivos alterados, diff stat), evidências citáveis |
| Falha | `failureReason` (código + detalhe), histórico completo de tentativas |
| Eventos | linha do tempo filtrada por esta task |

Cada evidência é **citável**: comando exato que um humano pode repetir, com link para a
saída persistida.

O caminho da **worktree** aparece com botão de copiar. Isso resolve hoje, sem integração
nenhuma, o caso "quero abrir essa task no meu editor" (`code <caminho>`) — e deixa pronto o
terreno para uma futura ação *Open Workspace in VS Code*, que é UI sobre um dado que já
existe. A plataforma orquestra os agentes; ela não fecha o editor do desenvolvedor.

## 5.1 Painel de providers

```text
claude-code   installed ✔   ready ?   v2.1.4    ●●○  2/3
codex         installed ✔   ready ?   v0.9.2    ●○   1/2
mock          installed ✔   ready ✔   —         ○    0/8
```

`?` é `unknown` e é resposta legítima: nem toda CLI permite observar autenticação de forma
confiável. A UI mostra `unknown` como `unknown` — não pinta de verde por otimismo.

## 6. Tempo real

Snapshot inicial via `GET /api/runs/:id/snapshot`; atualizações por SSE a partir do último
`seq` visto. Reconexão retoma sem lacuna e sem duplicata. Sem polling.

Separação que sustenta a tela: **a estrutura do DAG vem da Mission compilada** (congelada no
início do run, portanto estável — nós não se movem) e **o estado visual vem do Run** (muda a
cada evento). Um é geometria, o outro é cor.

Requisitos de tempo real:

- os 12 estados (`PENDING`, `READY`, `RUNNING`, `VERIFYING`, `REVIEW`, `INTEGRATING`,
  `FAILED`, `RETRY`, `BLOCKED`, `DONE`, `SKIPPED`, `CANCELLED`) refletem no nó sem reload;
- ao concluir uma task, os dependentes que ficarem `READY` **acendem imediatamente** — é o
  momento mais informativo da tela e o que prova o DAG funcionando;
- posição dos nós é estável entre atualizações: só cor, ícone e rótulo mudam;
- o painel de providers atualiza `running/capacity` no mesmo stream.

## 7. Ações disponíveis no MVP

Deliberadamente poucas — o dashboard é read-heavy com uma operação de partida:

| Ação | Escopo | Exigência |
| --- | --- | --- |
| **Aprovar missão** | missão | ato humano registrado com `actor` |
| **START MISSION** | run | missão `APPROVED`; confirmação explícita se houver `WARNING` |
| `pause` / `resume` | run | — |
| `retry` | task | — |
| `unblock` | task | nota obrigatória |
| `skip` | task | motivo obrigatório |

Fora do MVP: editar missão, criar task, reordenar dependência, alterar gate ou política pela
UI. Configuração mora em arquivo versionado (P09, P13).

## 8. Relatório final

Ao concluir, a mesma UI apresenta o relatório (também disponível em Markdown por
`agentic run report --md`):

```text
MISSION DA-BPM-021 · COMPLETED
Tasks 17/17 DONE · Tentativas 21 · Retries 4 · Falhas de review 3
Mission gate PASS · Wall time 52min · Paralelismo 2,4×
Caminho crítico real: T01 → T04 → T09 → T13 → T17 (38min)
Maiores durações · Tasks com retry · Bloqueios · Evidências finais
```
