# Desenvolvimento Agêntico para VS Code

Casca do produto dentro do editor: detecta o projeto, descobre ou sobe o control plane,
mostra providers, missions e runs, e abre arquivos e diffs no próprio VS Code.

```text
VS Code Extension  →  AgenticHost (cliente)  →  Control Plane (agentic serve)  →  Orchestrator
```

A extensão **não contém o orquestrador**. Ela é cliente de um processo `agentic serve` — um
por repositório (I14) — que ela reutiliza quando já existe e sobe quando não existe.

## Jornada

1. Abra uma pasta com `.agentic/project.yaml` (ou rode `agentic init` nela).
2. Clique em **Agentic** na Activity Bar: projeto, branch e estado do control plane já aparecem.
3. **Start Agentic** (ícone ▶ na view *Projeto* ou paleta): a extensão procura um dono
   vivo pelo `.agentic/control-plane.json` + `/api/health`; se não houver, sobe
   `agentic serve -C <repoRoot>` e espera o health.
4. Providers e Missions ficam visíveis na sidebar; **Open Agentic** abre o painel (Project Home).
5. **Stop Agentic** encerra graciosamente (SIGTERM → drenagem → devolução da posse) e a UI
   passa por *Stopping…* até *Stopped*. **Restart** é stop provado e depois start.

Sem porta, sem PID, sem `curl`: tudo é descoberto.

## Comandos

| Comando | O que faz |
| --- | --- |
| `Agentic: Start Agentic` | reutiliza o dono ou sobe um control plane para o repositório |
| `Agentic: Stop Agentic` | encerramento gracioso; recusa declarar *Stopped* sem prova |
| `Agentic: Restart Agentic` | stop → confirmação → start, nunca dois donos |
| `Agentic: Open Agentic` | painel Project Home (webview) |
| `Agentic: Refresh` | redetecta o projeto e relê o control plane |
| `Agentic: Show Agentic Log` | canal de saída com as linhas do `agentic serve` |

## Configuração

| Setting | Default | Uso |
| --- | --- | --- |
| `agentic.cliPath` | `""` | caminho da CLI; vazio detecta `apps/cli/bin/agentic.mjs` no repo, `node_modules/.bin/agentic`, `PATH` |
| `agentic.nodePath` | `""` | `node` >= 22 para o control plane; vazio detecta no `PATH` e no nvm |
| `agentic.stopOnWindowClose` | `true` | ao fechar a janela, encerra o control plane que **ela** iniciou |

## Várias janelas

Duas janelas do mesmo repositório compartilham o mesmo control plane: a segunda descobre o
dono e reutiliza. *Stop* de qualquer janela encerra o processo (via SIGTERM ao pid
publicado, com prova pelo silêncio do `/api/health`). Projetos diferentes têm control planes
independentes.

## Desenvolvimento

```bash
npm install                      # na raiz do monorepo
npm run vscode:build             # esbuild: dist/extension.js + dist/webview/home.js
npm run vscode:test              # testes direcionados (vitest, projeto vscode-extension)
npm run vscode:package           # gera desenvolvimento-agentico-vscode-0.1.0-alpha.1.vsix na raiz
```

Para depurar: abra `extensions/vscode` no VS Code e pressione F5 (Extension Development Host),
ou use a configuração de launch da raiz.

## Limitações conhecidas (0.1.0-alpha.1)

- Só Linux/macOS: o encerramento gracioso de um dono externo usa SIGTERM.
- A CLI `agentic` precisa existir no repositório aberto, em `node_modules/.bin` ou no `PATH`;
  a extensão não a embute.
- Multi-root: a primeira pasta com `.agentic/project.yaml` é o projeto da janela.
- Sem chat próprio, sem editor de mission, sem aprovação/DAG (próxima missão).
