# MISSION FORMAT — especificação dos arquivos declarativos

Três arquivos, todos YAML, todos versionados no repositório **do projeto-alvo**:

```text
.agentic/
  project.yaml              # políticas de execução do projeto
  gates.yaml                # perfis de quality gate
  missions/
    DA-BPM-021.mission.yaml # uma entrega
```

YAML e não JSON: os arquivos são escritos e revisados por humanos, precisam de comentário e
de blocos de texto multilinha. A validação é feita com zod sobre o documento já parseado —
o formato de arquivo não vaza para o domínio (ADR-0005).

---

## 1. `mission.yaml`

### 1.1 Exemplo completo

```yaml
apiVersion: agentic/v1
kind: Mission

id: DA-BPM-021
title: Refinar painel de propriedades BPM
objective: >
  Painel de propriedades do editor BPM lê e grava propriedades da atividade
  selecionada via API, com validação e cobertura de teste.

scope:
  - Painel de propriedades e seus componentes
  - Endpoint de leitura/gravação de propriedades
outOfScope:
  - Redesenho do canvas do editor
  - Migração de dados históricos

constraints:
  - Sem nova dependência de runtime no frontend
  - Manter compatibilidade da API v1

acceptanceCriteria:
  - Alterar propriedade persiste e sobrevive a reload
  - Usuário sem permissão recebe 403
  - Cobertura do módulo de propriedades não regride

defaults:
  requireReview: true
  maxAttempts: 3
  gate: unit
  agentProfile: executor

phases:
  - id: foundation
    title: Fundação
  - id: backend
    title: Backend
  - id: frontend
    title: Frontend
  - id: quality
    title: Qualidade

tasks:
  - id: T01
    phase: foundation
    title: Contrato de propriedades da atividade
    objective: >
      Tipos e schema de validação de PropriedadeAtividade compartilhados entre
      api e web, com testes de schema.
    dependencies: []
    touches:
      - packages/contracts/src/bpm/
    validation:
      - Schema rejeita propriedade sem chave
      - Tipos exportados no index do pacote
    gate: unit
    risk: low
    estimate: 2

  - id: T04
    phase: backend
    title: Endpoint de gravação de propriedades
    objective: Endpoint PATCH persiste propriedades validando permissão do usuário.
    dependencies: [T01, T02]
    touches:
      - apps/api/src/bpm/propriedades/
    reads:
      - packages/contracts/src/bpm/
    validation:
      - Usuário sem permissão recebe 403
      - Payload inválido recebe 422 com detalhe do campo
    gate: backend
    requireReview: true
    risk: high
    estimate: 5
    agentProfile: backend-executor

missionGate: mission
```

### 1.2 Campos

#### Raiz

| Campo | Tipo | Obrigatório | Regra |
| --- | --- | --- | --- |
| `apiVersion` | `"agentic/v1"` | sim | versionamento do formato |
| `kind` | `"Mission"` | sim | |
| `id` | string | sim | `^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\d{3,}$` |
| `title` | string | sim | 1–120 chars |
| `objective` | string | sim | resultado verificável |
| `description` | string | não | |
| `scope` / `outOfScope` | string[] | não | |
| `constraints` | string[] | não | repassadas a todo agente |
| `acceptanceCriteria` | string[] | sim | ≥ 1 |
| `defaults` | objeto | não | `requireReview`, `maxAttempts`, `gate`, `agentProfile` |
| `phases` | Phase[] | sim | ≥ 1, ids únicos |
| `tasks` | Task[] | sim | 1–200 |
| `missionGate` | string | não | id de perfil em `gates.yaml` |

#### Task

| Campo | Tipo | Obrigatório | Regra |
| --- | --- | --- | --- |
| `id` | string | sim | `^[A-Z]\d{2,}$`, único |
| `phase` | string | sim | precisa existir em `phases` |
| `title` | string | sim | |
| `objective` | string | sim | não vazio (`DA1009`) |
| `description` | string | não | |
| `dependencies` | string[] | não | default `[]`; ids existentes, sem auto-referência |
| `touches` | string[] | sim para task que altera código | caminhos POSIX relativos à raiz |
| `reads` | string[] | não | contexto; não gera lock |
| `validation` | string[] | não | recomendado (`DA2002`) |
| `gate` | string | não | herda de `defaults.gate` |
| `requireReview` | boolean | não | herda de `defaults` |
| `maxAttempts` | int ≥ 1 | não | herda de `defaults` |
| `risk` | `low\|medium\|high` | não | default `medium` |
| `estimate` | number > 0 | não | default 1; unidade relativa |
| `agentProfile` | string | não | herda de `defaults` |
| `reviewPolicy` | `fresh-session\|cross-provider-preferred\|cross-provider-required` | não | override mais específico; ver §1.4 |

### 1.4 Política de revisão

Resolução, do mais específico para o mais genérico:

```text
task.reviewPolicy
  > mission.defaults.reviewPolicy
  > project.policies.review.byRisk[task.risk]
  > project.policies.review.default
```

O mapa risco→política mora em `project.yaml` de propósito: é decisão de projeto, muda sem
tocar código, e o domínio recebe a política **já resolvida**. Uma equipe que queira revisão
cruzada obrigatória em tudo muda uma linha de configuração.

Em qualquer política vale `reviewer ≠ executor`. Em `cross-provider-required` vale também
`reviewer.provider ≠ executor.provider`; sem um segundo fornecedor apto, a task vai para
`BLOCKED` — nunca rebaixa em silêncio. `cross-provider-preferred` rebaixa para
`fresh-session` e **registra** o rebaixamento.

### 1.3 Semântica de `touches`

- Caminho terminado em `/` é prefixo de diretório; caso contrário, arquivo específico.
- Normalização POSIX; `..` e caminho absoluto são erro (`DA1008`).
- Conflito: `A` e `B` conflitam se um é prefixo do outro.
- É **contrato**: alteração fora do declarado reprova a tentativa (P04).
- Vale para escrita. Leitura é livre dentro do repositório (declarar em `reads` serve para
  contexto e para o relatório, não para trava).

---

## 2. `project.yaml`

```yaml
apiVersion: agentic/v1
kind: Project

project:
  name: plataforma-exemplo
  repoRoot: .

execution:
  workspace: git-worktree        # git-worktree | shared
  worktreeRoot: .agentic/worktrees
  maxParallelTasks: 3
  maxExecutors: 3
  maxReviewers: 2
  defaultMaxAttempts: 3
  attemptTimeoutMinutes: 30
  retryBackoffSeconds: 15
  # Sem isto, uma worktree recém-criada não tem node_modules nem .env e TODO gate falha.
  workspaceSetup:
    link:                        # symlink a partir da raiz do repositório (barato)
      - node_modules
      - .env
    commands: []                 # ex.: [{ run: npm ci --prefer-offline }] quando link não serve
    timeoutMs: 600000

policies:
  enforceTouches: true
  requireReviewByDefault: true
  denyPaths:
    - .agentic/
    - .git/
    - .env
    - "*.pem"
  escalateOn:
    - attemptsExhausted
    - scopeViolationRepeated
    - reviewEscalate
  review:
    default: cross-provider-preferred
    byRisk:                        # mapa risco→política é POLÍTICA, não regra de domínio
      low: fresh-session
      medium: cross-provider-preferred
      high: cross-provider-required

integration:
  missionBranchPrefix: mission/
  taskBranchPrefix: task/
  strategy: rebase-merge         # rebase-merge | merge
  autoPush: false

providers:
  default: claude-code
  registry:
    claude-code:
      kind: local-cli              # processo local já autenticado pelo usuário (P17)
      command: claude              # nome ou caminho do executável
      versionArgs: ["--version"]
      maxConcurrent: 3             # capacidade individual deste fornecedor
      roles: [executor, reviewer]
      profiles:
        executor: { role: executor }
        reviewer: { role: reviewer }
    codex:
      kind: local-cli
      command: codex
      versionArgs: ["--version"]
      maxConcurrent: 2
      roles: [executor, reviewer]
      profiles:
        executor: { role: executor }
        reviewer: { role: reviewer }
    mock:
      kind: inprocess            # agente de ENSAIO: roteiro fixo, sem processo e sem quota
      maxConcurrent: 8

gates:
  file: .agentic/gates.yaml
  missionGate: mission

server:
  host: 127.0.0.1
  port: 4317
```

### `kind: inprocess` é ensaio, e ensaio não revisa

`local-cli` é um agente de verdade: processo local, sessão do usuário, resultado imprevisível.
`inprocess` é um roteiro determinístico — existe para teste, demonstração e preview.

A diferença tem consequência de produto, e não só de implementação: **um fornecedor
`inprocess` nunca satisfaz revisão de tentativa real**, em política nenhuma, nem em
`fresh-session`. Revisão é a segunda leitura independente da evidência (P07), e um roteiro
não lê nada. O escalonamento recusa antes de despachar e a task vai para `BLOCKED` com
`reason: SIMULATED_REVIEWER_ONLY` (transição 12b em
[STATE-MACHINES.md](STATE-MACHINES.md)) — nunca com uma revisão de mentira.

`roles: [executor, reviewer]` num provider `inprocess` não muda isso, e nem precisa ser
retirado: a inelegibilidade vem do `kind`.

---

## 3. `gates.yaml`

```yaml
apiVersion: agentic/v1
kind: Gates

profiles:
  unit:
    commands:
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run test
        timeoutMs: 900000

  backend:
    commands:
      - run: npm run lint -w @exemplo/api
      - run: npm run typecheck -w @exemplo/api
      - run: npm run test -w @exemplo/api

  web:
    commands:
      - run: npm run lint -w @exemplo/web
      - run: npm run typecheck -w @exemplo/web
      - run: npm run build -w @exemplo/web

  mission:
    commands:
      - run: npm run verify
      - run: npm run test:e2e
        required: true
        timeoutMs: 1800000

env:
  allow: [PATH, HOME, NODE_ENV, CI, LANG]
```

Regras: comandos rodam com `cwd` no workspace da tentativa (ou o `cwd` declarado, relativo a
ele); `required: false` registra falha sem reprovar; nenhuma variável de ambiente além da
allowlist é repassada; toda saída é persistida com digest e citada no relatório.

Os comandos são do **projeto orquestrado**, em qualquer linguagem ou ferramenta — `pytest`,
`mvn verify`, `cargo test`, `make check`, `go test ./...`. O control plane não tem opinião
sobre eles: executa, mede e guarda a evidência.

---

## 4. Evolução do formato

`apiVersion` é o mecanismo de compatibilidade. Mudança incompatível → `agentic/v2` + migração
explícita. O compilador rejeita versão desconhecida com `DA1001`, jamais tenta adivinhar.
