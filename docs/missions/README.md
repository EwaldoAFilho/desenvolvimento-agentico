# Relatórios de missão

Relatório final de cada Mission executada, gerado por `agentic run report --md`.
São versionados: é o registro durável de o que foi feito, por quem e com qual evidência.
Artefatos brutos de execução ficam em `.agentic/runs/` e não são versionados.

## Nesta pasta

| Arquivo | O que é |
| --- | --- |
| [`EXEMPLO-001-report.md`](EXEMPLO-001-report.md) | relatório de exemplo, gerado pelo E2E sobre o fixture [`examples/estoque-cli`](../../examples/estoque-cli) |
| [`SMOKE-REAL.md`](SMOKE-REAL.md) | roteiro manual e opt-in para validar contra as CLIs verdadeiras, fora do CI |

`EXEMPLO-001-report.md` é regerado sob demanda, nunca a cada `npm run test:e2e`:

```sh
AGENTIC_WRITE_REPORT=1 npx vitest run --project e2e tests/e2e/mission-report.test.ts
```
