# AUDITORIA ARQUITETURAL — gate de planejamento

> Revisão crítica do próprio plano antes de apresentá-lo. Registra o que foi verificado, o
> que foi corrigido e o que permanece como risco assumido.
>
> **Revisão 1** — gate inicial (DA-DISCOVERY-000).
> **Revisão 2** — patch arquitetural: independência do produto, execução local
> subscription-first, dois providers reais, runtime local, capacidade por fornecedor,
> revisão cruzada e START MISSION.

---

# Revisão 2 — auditoria do patch arquitetural

## 1. Verificações (números recalculados sobre o arquivo da missão)

| Pergunta | Resultado | Evidência |
| --- | --- | --- |
| Sobrou acoplamento a alguma organização? | Não | busca por nome de empresa em `docs/` e `.agentic/` retorna zero; ADR-0001 e ADR-0002 rejustificadas por razão do produto |
| O domínio conhece fornecedor ou CLI? | Não | `ProviderId` opaco; nomes só em `packages/providers` e `project.yaml`; verificação por lint entra em T01/T02 |
| Algum provider real exige API key? | Não | ADR-0009; `LocalAgentRuntime` não tem campo de credencial; validação explícita em T17 |
| Providers compartilham suíte de contrato? | Sim | uma suíte para os três adapters (T09) |
| Testes consomem quota de agente? | Não | mocks, stubs de processo e fixtures; validação explícita em T09 e T15 |
| Saúde de provider inventa suporte inexistente? | Não | `readinessProbe` declarado por capability; `unknown` é valor de primeira classe |
| O scheduler considera capacidade por provider? | Sim | `CapacitySnapshot.byProvider` como **entrada**; scheduler segue função pura (T10) |
| Revisão cruzada pode ser rebaixada em silêncio? | Não | I10; `required` bloqueia, `preferred` rebaixa **com registro** e evento |
| Risco está codificado no domínio? | Não | mapa risco→política mora em `project.yaml`; domínio recebe `ReviewPolicy` resolvida (ADR-0011) |
| `claims` ficou mais fraco? | Não | continua fora de toda transição; agora explicitado como informação operacional armazenada |
| START MISSION quebra a autoridade humana? | Não | aprovar e iniciar **são** atos humanos, com `actor` registrado; não há caminho automático |
| O dashboard virou editor de missão? | Não | seis ações, nenhuma altera o YAML |
| Existem ciclos? | Não | Kahn processa os 17 nós |
| Conflitos de `touches` entre concorrentes? | Nenhum | 50 pares concorrentes verificados |
| Dependências artificiais? | Nenhuma nova | `T09→T17` e `T07→T16` são de construção real |
| 3 executores continuam ótimos? | **Não** | ótimo passou para **4** (40 vs 42); ver §3 |

## 2. Mudanças estruturais aplicadas

| # | Mudança | Efeito |
| --- | --- | --- |
| 1 | Justificativas por ecossistema de empresa removidas de ADR-0001/0002 e do plano | produto independente; exemplos neutros |
| 2 | P17 (subscription-first) e P18 (independência) formalizados | princípio com verificação, não intenção |
| 3 | `LocalAgentRuntime` + `Process Runtime` como portas/pacotes (ADR-0012) | código de SO em um lugar testado; runtime substituível |
| 4 | Segundo provider real (`CodexCliProvider`) no MVP (ADR-0010) | porta provada por construção; habilita revisão cruzada |
| 5 | `ProviderHealth` com `unknown` de primeira classe | honestidade operacional; `--version` não prova autenticação |
| 6 | `maxConcurrent` por provider + `CapacitySnapshot` | scheduler respeita capacidade real sem deixar de ser puro |
| 7 | `ReviewPolicy` em três níveis, resolvida por configuração (ADR-0011) | independência de revisão deixa de ser binária |
| 8 | `PROVIDER_UNAVAILABLE` / `PROVIDER_NOT_READY`, sem consumir tentativa | falha de ambiente não queima tentativa útil |
| 9 | Regra "drenar antes de encher" no scheduler | evita inanição de revisão |
| 10 | START MISSION na aplicação, no server e no dashboard | um clique dispara todas as READY |
| 11 | Caminho da worktree exposto em API, CLI e painel | *Open in VS Code* vira UI sobre dado existente, não arquitetura |

## 3. Recálculo do grafo (nada preservado)

| | Revisão 1 | Revisão 2 |
| --- | --- | --- |
| Tasks | 15 | **17** |
| Trabalho total | 67 | **83** |
| Pares concorrentes | 34 | **50** |
| Conflitos de `touches` | 0 | **0** |
| Caminho crítico | 34 (dois empatados) | **40** (único) |
| Makespan 1/2/3/4/5 | 67/39/34/34/34 | **83/47/42/40/40** |
| Executores ótimos | 3 | **4** |

O patch acrescentou 16 unidades de trabalho paralelizável e alargou as ondas 2–4. Com 3
executores o plano custa 42 (+5%); com 4 atinge o caminho crítico. `.agentic/project.yaml`
foi atualizado para `maxExecutors: 4`, `maxParallelTasks: 5`.

## 4. Pontos frágeis desta revisão

### 4.1 Cadeia quase crítica de risco alto (novo)
`T17 Local Agent Runtime` → `T09 Agent Providers` tem **folga 1** e ambas são `risk: high` —
justamente as que dependem do comportamento de CLIs externas. Mitigação: antecipar na
sequência de execução e tratar como caminho crítico. Plano de contenção: se estourar, o
`CodexCliProvider` vira entrega incremental pós-MVP — a porta e a suíte de contrato já ficam
prontas, então o corte é de uma implementação, não de arquitetura.

### 4.2 Prontidão indeterminável
Com `readinessProbe: unsupported`, só o primeiro despacho revela que a CLI não está
autenticada. Mitigado por `PROVIDER_NOT_READY` (não consome tentativa), pelo `doctor` e pelo
aviso na tela de START MISSION — mas continua sendo uma falha que aparece tarde.

### 4.3 Capacidade compartilhada entre execução e revisão
Um provider com `maxConcurrent: 2` executando duas tasks não tem vaga para revisar. A regra
"drenar antes de encher" evita o travamento, mas reduz o paralelismo efetivo de execução — o
makespan calculado é piso estrutural, não previsão.

### 4.4 Revisão cruzada reduz correlação, não elimina viés
Dois fornecedores diferentes ainda são dois modelos de linguagem. A revisão cruzada quebra a
correlação de treino; não substitui o gate mecânico, que continua decidindo antes.

## 5. Fragilidades herdadas da revisão 1 (mantidas)

`reads` sem enforcement (sob observação para corte) · uma validação parcialmente subjetiva em
T14 · escopo verificado a posteriori, não confinado · sabotagem de teste com mitigação apenas
parcial. Detalhes em §3 da revisão 1, abaixo.

## 6. Conclusão da revisão 2

Todas as exigências do patch foram incorporadas de forma consistente entre documentos,
schemas, ADRs, configuração e missão; os números foram recalculados e contradizem o plano
anterior onde deviam contradizer (ponto ótimo de executores).

**Veredito: READY_FOR_IMPLEMENTATION.**

---

# Revisão 1 — gate inicial

## 1. Verificações

| Pergunta | Resultado |
| --- | --- |
| Existe overengineering? | Corrigido em 6 pontos |
| Existe acoplamento indevido? | Não — regra de dependência verificada por lint |
| Existem componentes prematuros? | Um reclassificado (`Review Coordinator` é módulo, não pacote) |
| Abstrações sem caso de uso? | Duas cortadas, uma sob observação |
| O dashboard está misturado ao domínio? | Não |
| O domínio conhece provider? | Não |
| O scheduler depende da interface? | Não |
| Temos uma fonte de verdade? | Sim |
| Existem ciclos / conflitos de `touches`? | Nenhum |
| Cada task tem validação reproduzível? | 14 de 15 plenamente |

## 2. Correções aplicadas

### 2.1 Preparação do workspace (lacuna que inviabilizaria o uso real)
Worktree nasce sem `node_modules`, `.env` nem artefato de build: todo task gate falharia por
motivo alheio ao trabalho do agente. Correção: `execution.workspaceSetup`, com falha própria
(`WORKSPACE_ERROR`).

### 2.2 Campo `kind` em Dependency — removido
Discriminador para tipos que não existem.

### 2.3 Estado `READY` do Run — removido
Sem condição observável que o distinguisse de `APPROVED`.

### 2.4 `Review Coordinator` — reclassificado
Módulo dentro de `orchestrator`, não pacote.

### 2.5 Dependência artificial `T14 → T13` — removida
O dashboard depende do **contrato**, não do servidor. Caminho crítico caiu 15%.

### 2.6 Pacotes e entidades recusados
`events`, `metrics`, `common/utils`, `api-client`, `logger`; `Executor`/`Reviewer` como
entidades; `Evidence` como tabela paralela; event sourcing puro; Next.js; PostgreSQL; Redis.

## 3. Pontos frágeis assumidos

- **`reads` sem enforcement** — serve a contexto e relatório; sob observação, cortado se não
  provar valor em `DA-CORE-002`.
- **Uma validação parcialmente subjetiva** — legibilidade do layout em T14.
- **Independência do revisor era procedural** — resolvido parcialmente na revisão 2 pela
  revisão cruzada entre fornecedores.
- **Escopo é verificado, não confinado** — `SCOPE_VIOLATION` é detectado por diff, depois da
  tentativa.
- **Sabotagem de teste** — mitigação parcial (`touches` + revisão do diff).
