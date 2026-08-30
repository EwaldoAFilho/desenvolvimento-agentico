# examples/

Projetos-alvo de exemplo: repositórios pequenos, **reais e executáveis**, usados para
demonstrar e para testar o control plane de ponta a ponta.

| Exemplo | O que é |
| --- | --- |
| [`estoque-cli/`](estoque-cli) | biblioteca Node sem dependências, com `.agentic/` completo e a missão `EXEMPLO-001` de 8 tasks |

## Como estes exemplos são usados

- **Pelo E2E** (`npm run test:e2e`): `tests/e2e/support/fixture.ts` copia o projeto para um
  diretório temporário, roda `git init` nele e executa a missão inteira com agentes
  in-process roteirizados. O repositório do produto nunca é o alvo, e nenhuma CLI de agente
  real é invocada.
- **Pelo smoke manual**: [`docs/missions/SMOKE-REAL.md`](../docs/missions/SMOKE-REAL.md)
  descreve como rodar a mesma missão contra as CLIs verdadeiras — fora do CI, de propósito,
  gastando assinatura.

## Regra ao rodar um exemplo à mão

Copie para fora do repositório do produto antes de executar qualquer missão:

```sh
cp -r examples/estoque-cli /tmp/smoke-estoque
cd /tmp/smoke-estoque && git init -q -b main && git add -A && git commit -q -m inicial
```

`examples/estoque-cli` não é um repositório git próprio. Executar a missão sem copiar faria
o control plane criar branch e worktrees **do repositório do produto**.
