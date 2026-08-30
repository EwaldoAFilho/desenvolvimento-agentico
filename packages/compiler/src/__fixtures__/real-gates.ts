/** Copia literal de `.agentic/gates.yaml`. O pacote e puro: o texto entra como dado. */
export const REAL_GATES_YAML = `apiVersion: agentic/v1
kind: Gates

# Quality gates do projeto. Escritos por humanos, versionados, executados pelo control
# plane. Nenhum agente pode alterar este arquivo (P09).

profiles:
  unit:
    commands:
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run test
        timeoutMs: 900000

  web:
    commands:
      - run: npm run lint -w @agentic/web
      - run: npm run typecheck -w @agentic/web
      - run: npm run build -w @agentic/web

  mission:
    commands:
      - run: npm run verify
      - run: npm run test:e2e
        required: true
        timeoutMs: 1800000

env:
  allow: [PATH, HOME, NODE_ENV, CI, LANG]
`
