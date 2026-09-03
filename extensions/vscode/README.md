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
   `agentic serve -C <diretório que contém .agentic/project.yaml>` e espera o health.
4. Providers e Missions ficam visíveis na sidebar; **Open Agentic** abre o painel (Project Home).
5. **Stop Agentic** encerra graciosamente (SIGTERM → drenagem → devolução da posse) e a UI
   passa por *Stopping…* até *Stopped*. **Restart** é stop provado e depois start.

Sem porta, sem PID, sem `curl`: tudo é descoberto.

## Jornada principal (0.2.0)

Na aba **Agentic** (comando *Open Agentic*) roda o dashboard do produto:

1. **Home**: projeto, providers, missions e runs.
2. **+ Nova Mission**: descreva o que quer, escolha o planner (só providers READY que sabem
   planejar), informe o `actor` e gere o plano. O control plane invoca a CLI local em modo
   de leitura, valida, compila e grava `.agentic/missions/<ID>.mission.yaml`; a mission
   aparece como **DRAFT** com o DAG.
3. **Revisão**: DAG, inspeção de nó (objective, dependências, touches, gate, risco, provider,
   política de revisão), diagnósticos, conflitos de `touches`. Clicar em um caminho abre no
   editor.
4. **Aprovar e executar**: `actor` obrigatório (sugerido do `git config user.name`), o plano
   aprovado é exatamente o inspecionado (`specHash`), um clique = no máximo um run.
5. **Run ao vivo**: DAG com estados, detalhe de task com worktree/branch/logs/gate/revisão/
   evidência, abrir arquivo, diff nativo, retry/unblock/skip/pause/resume.

A sidebar mostra *Active Run* com as tasks; a mesma aba serve outra janela do mesmo projeto.

## Comandos

| Comando | O que faz |
| --- | --- |
| `Agentic: Start Agentic` | reutiliza o dono ou sobe um control plane para o repositório |
| `Agentic: Stop Agentic` | encerramento gracioso; recusa declarar *Stopped* sem prova |
| `Agentic: Restart Agentic` | stop → confirmação → start, nunca dois donos |
| `Agentic: Open Agentic` | aba com o dashboard (Home / Mission / Run) |
| `Agentic: New Mission` | abre a aba já na tela de nova mission |
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
npm run vscode:package           # gera desenvolvimento-agentico-vscode-0.2.0-alpha.1.vsix na raiz
```

Para depurar: abra `extensions/vscode` no VS Code e pressione F5 (Extension Development Host),
ou use a configuração de launch da raiz.

## Limitações conhecidas (0.2.0-alpha.1)

- Só Linux/macOS: o encerramento gracioso de um dono externo usa SIGTERM.
- A CLI `agentic` precisa existir no repositório aberto, em `node_modules/.bin` ou no `PATH`;
  a extensão não a embute.
- Multi-root: a primeira pasta com `.agentic/project.yaml` é o projeto da janela.
- O `agentic serve` recebe só uma allowlist fechada de ambiente (`PATH`, `HOME`, locale,
  proxy, certificados); nenhum segredo herdado pelo VS Code é injetado (P17).
- O painel só abre caminhos dentro do repositório, do diretório de configuração ou de
  worktrees publicadas por ele; qualquer outro é recusado.
- Planejamento é uma chamada síncrona ao control plane (até 10 min) sem cancelamento: o
  contrato do planner não o oferece ainda.
- O dashboard usa o próprio CSS (paleta clara); o tema do VS Code só cobre o portão.
- Sem chat próprio, sem editor visual de mission.
