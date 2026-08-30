/**
 * Modelos escritos por `agentic init`. Sao YAML porque humano le, comenta e revisa o
 * arquivo — e ele e o contrato versionado (MISSION-FORMAT 1).
 */
export const PROJECT_TEMPLATE = `apiVersion: agentic/v1
kind: Project

project:
  name: meu-projeto
  repoRoot: .

execution:
  workspace: git-worktree        # git-worktree | shared
  worktreeRoot: .agentic/worktrees
  maxParallelTasks: 2
  maxExecutors: 2
  maxReviewers: 1
  defaultMaxAttempts: 3
  attemptTimeoutMinutes: 30
  retryBackoffSeconds: 15
  # Sem isto a worktree nova nao tem node_modules nem .env e TODO gate falha.
  workspaceSetup:
    link:
      - node_modules
    commands: []
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
    byRisk:
      low: fresh-session
      medium: cross-provider-preferred
      high: cross-provider-required

integration:
  missionBranchPrefix: mission/
  taskBranchPrefix: task/
  strategy: rebase-merge
  autoPush: false

providers:
  # CLIs locais ja instaladas e autenticadas pelo usuario. Nenhuma API key (P17).
  default: mock
  registry:
    mock:
      kind: inprocess
      maxConcurrent: 4
      roles: [executor, reviewer]

gates:
  file: .agentic/gates.yaml
  missionGate: mission

server:
  host: 127.0.0.1
  port: 4317
`

export const GATES_TEMPLATE = `apiVersion: agentic/v1
kind: Gates

# Comandos do SEU projeto, em qualquer linguagem. O control plane executa, mede e guarda
# a evidencia — nao tem opiniao sobre eles.

profiles:
  unit:
    commands:
      - run: npm run lint
      - run: npm run test
        timeoutMs: 900000

  mission:
    commands:
      - run: npm run verify
        timeoutMs: 1800000

env:
  allow: [PATH, HOME, NODE_ENV, CI, LANG]
`

export const EXAMPLE_MISSION_ID = 'EXEMPLO-001'

export const MISSION_TEMPLATE = `apiVersion: agentic/v1
kind: Mission

id: ${EXAMPLE_MISSION_ID}
title: Exemplo de missao
objective: >
  Entrega de exemplo para conhecer o formato. Substitua por uma entrega real com
  resultado verificavel.

scope:
  - O que esta missao entrega
outOfScope:
  - O que ela deliberadamente nao faz

constraints:
  - Sem nova dependencia de runtime

acceptanceCriteria:
  - O criterio observavel que prova a entrega

defaults:
  requireReview: true
  maxAttempts: 3
  gate: unit

phases:
  - id: foundation
    title: Fundacao
  - id: entrega
    title: Entrega
  - id: qualidade
    title: Qualidade

tasks:
  - id: T01
    phase: foundation
    title: Contrato compartilhado
    objective: Tipos e validacao usados pelo resto da missao, com teste de schema.
    dependencies: []
    touches:
      - src/contratos/
    validation:
      - Schema rejeita entrada invalida
    gate: unit
    risk: low
    estimate: 2

  - id: T02
    phase: entrega
    title: Implementacao do caso de uso
    objective: Caso de uso le e grava usando o contrato compartilhado.
    dependencies: [T01]
    touches:
      - src/aplicacao/
    reads:
      - src/contratos/
    validation:
      - Caso de uso cobre o caminho feliz e o de erro
    gate: unit
    risk: medium
    estimate: 3

  - id: T03
    phase: entrega
    title: Interface do usuario
    objective: Tela consome o caso de uso e mostra o erro sem quebrar.
    dependencies: [T01]
    touches:
      - src/ui/
    reads:
      - src/contratos/
    validation:
      - Tela renderiza estado de erro
    gate: unit
    risk: low
    estimate: 2

  # Folha da missao: usa o mission gate, entao a entrega integrada e verificada.
  - id: T04
    phase: qualidade
    title: Teste de ponta a ponta
    objective: Fluxo completo exercitado sobre a entrega integrada.
    dependencies: [T02, T03]
    touches:
      - tests/integracao/
    validation:
      - Fluxo passa duas vezes seguidas sem intervencao
    gate: mission
    risk: low
    estimate: 2

missionGate: mission
`
