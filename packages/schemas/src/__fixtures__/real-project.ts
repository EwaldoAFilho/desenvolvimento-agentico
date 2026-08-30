/** Copia literal de `.agentic/project.yaml`. O pacote e puro: o texto entra como dado. */
export const REAL_PROJECT_YAML = `apiVersion: agentic/v1
kind: Project

# Políticas de execução do próprio Desenvolvimento Agêntico.
# Este arquivo é lido pelo control plane e é PROIBIDO para agentes (ver policies.denyPaths).

project:
  name: desenvolvimento-agentico
  repoRoot: .

execution:
  workspace: git-worktree        # git-worktree | shared
  worktreeRoot: .agentic/worktrees
  # Recalculado após o patch arquitetural: com 17 tasks o ótimo passou de 3 para 4
  # executores (makespan 40 vs 42). Teto global 5 = capacidade somada dos providers.
  maxParallelTasks: 5
  maxExecutors: 4
  maxReviewers: 2
  defaultMaxAttempts: 3
  attemptTimeoutMinutes: 30
  retryBackoffSeconds: 15
  workspaceSetup:                # prepara a worktree antes do agente e do gate
    link: [node_modules]
    commands: []
    timeoutMs: 600000

policies:
  enforceTouches: true           # alteração fora de \`touches\` reprova a tentativa
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
  review:                        # política, não regra de domínio (ADR-0011)
    default: cross-provider-preferred
    byRisk:
      low: fresh-session
      medium: cross-provider-preferred
      high: cross-provider-required

integration:
  missionBranchPrefix: mission/
  taskBranchPrefix: task/
  strategy: rebase-merge
  autoPush: false                # abrir PR é decisão humana (P15)

providers:
  # Local subscription-first (P17): CLIs locais já instaladas e autenticadas pelo usuário.
  # Nenhuma exige API key. Não guardamos nem injetamos credencial.
  default: claude-code
  registry:
    claude-code:
      kind: local-cli
      command: claude
      versionArgs: ["--version"]
      maxConcurrent: 3
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
      kind: inprocess            # usado pelos testes determinísticos
      maxConcurrent: 8

gates:
  file: .agentic/gates.yaml
  missionGate: mission

server:
  host: 127.0.0.1
  port: 4317
`
