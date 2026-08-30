/** Amostras minimas validas. Os testes mutam estas strings para produzir cada invalido. */

export const MINIMAL_MISSION_YAML = `apiVersion: agentic/v1
kind: Mission
id: DA-TEST-001
title: Missao de teste
objective: Objetivo verificavel
acceptanceCriteria:
  - Criterio um
phases:
  - id: core
    title: Nucleo
tasks:
  - id: T01
    phase: core
    title: Primeira task
    objective: Fazer a coisa certa
    touches:
      - packages/exemplo/
`

export const MISSION_WITH_DEFAULTS_YAML = `apiVersion: agentic/v1
kind: Mission
id: DA-TEST-001
title: Missao com defaults
objective: Objetivo verificavel
acceptanceCriteria:
  - Criterio um
defaults:
  requireReview: true
  maxAttempts: 4
  gate: unit
  agentProfile: executor
  reviewPolicy: cross-provider-preferred
phases:
  - id: core
    title: Nucleo
  - id: quality
    title: Qualidade
tasks:
  - id: T01
    phase: core
    title: Herda tudo
    objective: Objetivo um
    touches:
      - packages/um/
  - id: T02
    phase: quality
    title: Sobrescreve tudo
    objective: Objetivo dois
    dependencies: [T01]
    touches:
      - packages/dois/
    reads:
      - packages/um/
    validation:
      - Tem teste
    gate: web
    requireReview: false
    maxAttempts: 1
    agentProfile: revisor
    reviewPolicy: cross-provider-required
    risk: high
    estimate: 8
missionGate: mission
`

export const MINIMAL_PROJECT_YAML = `apiVersion: agentic/v1
kind: Project
project:
  name: projeto-de-teste
execution:
  workspace: git-worktree
  maxParallelTasks: 2
  maxExecutors: 2
  maxReviewers: 1
  defaultMaxAttempts: 3
  attemptTimeoutMinutes: 30
  retryBackoffSeconds: 15
policies:
  review:
    default: fresh-session
    byRisk:
      low: fresh-session
      medium: cross-provider-preferred
      high: cross-provider-required
providers:
  default: primario
  registry:
    primario:
      kind: local-cli
      command: agente-a
      maxConcurrent: 3
      roles: [executor, reviewer]
    mock:
      kind: inprocess
      maxConcurrent: 8
`

export const MINIMAL_GATES_YAML = `apiVersion: agentic/v1
kind: Gates
profiles:
  unit:
    commands:
      - run: npm run lint
      - run: npm run test
        timeoutMs: 900000
        required: false
env:
  allow: [PATH, HOME]
`
