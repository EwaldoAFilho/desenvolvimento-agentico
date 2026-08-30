<!--
Artefato de exemplo. Gerado pelo E2E do fixture examples/estoque-cli:

    AGENTIC_WRITE_REPORT=1 npx vitest run --project e2e tests/e2e/mission-report.test.ts

O run foi executado com agentes in-process roteirizados (nenhuma CLI real, nenhuma quota)
sobre um clone temporario do fixture — por isso os caminhos citados apontam para /tmp.
O conteudo abaixo e a saida literal de `renderMissionReport`, sem edicao manual.
-->
# Relatorio da missao EXEMPLO-001

- run: `01M1A7BH32ZZ8RSNAPS99E1XSQ`
- resultado: **COMPLETED**
- tasks concluidas: 8/8 (puladas 0, canceladas 0, bloqueadas 0)
- tentativas: 8 · retries: 0 · reprovacoes de review: 0
- mission gate: mission PASS
- wall time: 1.2s

## Caminho critico real

- T02 -> T04 -> T06 -> T07 -> T08 (1.1s)

## Tasks mais demoradas

- T04 Precificacao de pedido: 0.2s
- T02 Busca do catalogo por sku: 0.2s
- T01 Conversao de unidades em dois sentidos: 0.2s
- T03 Inventario em unidades: 0.2s
- T08 Casos de teste e documentacao de uso: 0.2s

## Tasks com retry

- nenhuma

## Bloqueios

- nenhum

## Evidencia citavel

- T01 · unit · exit 0
  ```sh
  cd /tmp/agentic-e2e-j9WllH/.agentic/worktrees/01M1A7BH32ZZ8RSNAPS99E1XSQ/T01-a1 && node tests/run.js
  ```
- T02 · unit · exit 0
  ```sh
  cd /tmp/agentic-e2e-j9WllH/.agentic/worktrees/01M1A7BH32ZZ8RSNAPS99E1XSQ/T02-a1 && node tests/run.js
  ```
- T03 · unit · exit 0
  ```sh
  cd /tmp/agentic-e2e-j9WllH/.agentic/worktrees/01M1A7BH32ZZ8RSNAPS99E1XSQ/T03-a1 && node tests/run.js
  ```
- T04 · unit · exit 0
  ```sh
  cd /tmp/agentic-e2e-j9WllH/.agentic/worktrees/01M1A7BH32ZZ8RSNAPS99E1XSQ/T04-a1 && node tests/run.js
  ```
- T05 · unit · exit 0
  ```sh
  cd /tmp/agentic-e2e-j9WllH/.agentic/worktrees/01M1A7BH32ZZ8RSNAPS99E1XSQ/T05-a1 && node tests/run.js
  ```
- T07 · unit · exit 0
  ```sh
  cd /tmp/agentic-e2e-j9WllH/.agentic/worktrees/01M1A7BH32ZZ8RSNAPS99E1XSQ/T07-a1 && node tests/run.js
  ```
- T08 · mission · exit 0
  ```sh
  cd /tmp/agentic-e2e-j9WllH/.agentic/worktrees/01M1A7BH32ZZ8RSNAPS99E1XSQ/T08-a1 && node tests/run.js
  ```
- T08 · mission · exit 0
  ```sh
  cd /tmp/agentic-e2e-j9WllH/.agentic/worktrees/01M1A7BH32ZZ8RSNAPS99E1XSQ/T08-a1 && node -e 'const fs = require("node:fs"); const faltando = ["src/inventario.js", "src/precos.js", "src/reposicao.js", "src/relatorio.js", "src/cli.js", "docs/USAGE.md", "tests/casos.js"].filter((caminho) => !fs.existsSync(caminho)); if (faltando.length > 0) { console.error("faltando " + faltando.join(" ")); process.exit(4) }'
  ```
- mission · mission · exit 0
  ```sh
  cd /tmp/agentic-e2e-j9WllH/.agentic/worktrees/01M1A7BH32ZZ8RSNAPS99E1XSQ/mission && node tests/run.js
  ```
- mission · mission · exit 0
  ```sh
  cd /tmp/agentic-e2e-j9WllH/.agentic/worktrees/01M1A7BH32ZZ8RSNAPS99E1XSQ/mission && node -e 'const fs = require("node:fs"); const faltando = ["src/inventario.js", "src/precos.js", "src/reposicao.js", "src/relatorio.js", "src/cli.js", "docs/USAGE.md", "tests/casos.js"].filter((caminho) => !fs.existsSync(caminho)); if (faltando.length > 0) { console.error("faltando " + faltando.join(" ")); process.exit(4) }'
  ```
