# Contribuir

Curto de propósito. O contexto de produto e as regras que não se negociam estão em
[CLAUDE.md](CLAUDE.md) — valem para pessoas e para agentes.

## Node suportado

Node **22** (LTS). O `package.json` declara `engines.node >= 22` e o `.nvmrc` fixa `22`; com nvm,
`nvm use` resolve. O control plane depende de um módulo nativo (`better-sqlite3`): versão errada
falha na instalação, de propósito. Também é preciso `git`.

## Preparar

```bash
npm ci
npm run build                 # pacotes, CLI e servidor (tsc)
npm run build -w @agentic/web # dashboard; `npm run test` exige apps/web/dist em disco
```

## Verificar

```bash
npm run verify        # lint + typecheck + testes (é o que a CI exige em toda PR)
npm run test:e2e      # ponta a ponta com provider mock; também obrigatório na PR
npm run test:browser  # Chromium real; antes: npx playwright install chromium
```

`verify` e `test:e2e` são exatamente o perfil `mission` de [.agentic/gates.yaml](.agentic/gates.yaml).
Nenhum teste da suíte exige agente real: o orquestrador é testado com o provider `mock`.

## Extensão VS Code

A extensão em [extensions/vscode](extensions/vscode) é cliente do control plane; não contém o core.

```bash
npm run vscode:build             # bundle da extensão e da webview (esbuild)
npm run vscode:test              # testes unitários (já entram em `npm run test`)
npm run vscode:test:integration  # VS Code real via @vscode/test-electron: baixa o editor e precisa de display
npm run vscode:package           # gera o VSIX na raiz do repositório (gitignored)
```

Para depurar, abra o repositório no VS Code e use a configuração de launch existente
(`.vscode/launch.json`), que carrega a extensão numa janela de desenvolvimento.

## Abrir uma PR

1. Branch a partir de `main`; PR para `main`.
2. A CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) roda `verify`, `product-build`
   (CLI, dashboard, extensão compilada e empacotada) e `e2e` em toda PR. O job `browser` roda
   só em `main` e sob demanda (`workflow_dispatch`).
3. Não bypasse um check vermelho: corrija a causa. A CI não publica nada — release, tag e VSIX
   continuam sendo ato humano explícito.
4. Documentação vai no mesmo commit. Mudança estrutural exige ADR em `docs/adr/`; mudança de
   formato atualiza `docs/architecture/MISSION-FORMAT.md`.
5. Não reformate o repositório inteiro; `npm run lint:fix` só no que você tocou.

## O que nunca entra no commit

O runtime do control plane vive em `.agentic/` e é **local**: `state.db` (e `state.db-*`),
`runs/`, `worktrees/`, `control-plane.json` e `control-plane.lock.db*`. Tudo isso já está no
`.gitignore`, junto com `*.vsix`, `dist/` e `.env`. O que **é** versionado em `.agentic/` são
`project.yaml`, `gates.yaml` e `missions/*.mission.yaml` — declarações, não estado.

Segredos nunca. O produto é subscription-first: não lê, não guarda e não injeta credencial.
