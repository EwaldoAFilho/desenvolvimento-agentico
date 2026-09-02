# Changelog

## 0.1.0-alpha.1

Primeira versão utilizável (DA-VSCODE-MVP-001):

- Activity Bar **Agentic** com as views *Projeto* e *Missions*.
- Detecção automática do projeto (`.agentic/project.yaml`, repoRoot canônico, branch git).
- Ciclo de vida do control plane: Start (reutiliza o dono existente), Stop gracioso, Restart serializado.
- Providers com estado READY / UNAVAILABLE / UNKNOWN.
- Missions com estado e último run; detalhes no painel.
- Painel **Open Agentic** (Project Home) via webview sem rede, por `postMessage`.
- Abrir arquivo/worktree e diff nativo (`git show` dos dois lados) a partir do painel.
