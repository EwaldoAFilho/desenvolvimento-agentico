# Changelog

## 0.2.0-alpha.1

Jornada principal dentro do VS Code (DA-VSCODE-MVP-002):

- **Dashboard do produto na aba Agentic**: o mesmo `App` de `apps/web` (Home do projeto,
  Nova Mission, revisão do plano com DAG, aprovação e Run ao vivo) roda na webview atrás de
  uma ponte sem rede (`postMessage` ↔ extension host ↔ control plane).
- **Nova Mission**: descrição em texto livre → planner escolhido entre os providers READY do
  control plane → plano gerado, validado e compilado pelo control plane → Mission DRAFT.
- **Revisão e aprovação**: DAG, inspeção de nó (objective, dependências, touches, gate, risco,
  provider, política de revisão), diagnósticos, `actor` obrigatório (sugerido do git),
  `specHash` do plano inspecionado, aprovar e executar num ato, sem run duplicado.
- **Run ao vivo**: DAG com estados por SSE repassado pelo host, detalhe de task (provider,
  tentativa, worktree, branch, logs, gate, revisão, evidência, arquivos), ações nativas
  (abrir arquivo/worktree/log, diff), retry/unblock/skip/pause/resume quando o core suporta.
- **Sidebar**: view *Active Run* com as tasks; *+ New Mission*.
- Base: `deactivate` conhece o spawn em voo e nunca toca dono externo; identidade do
  `project.yaml` com o mesmo `trim` da CLI.

## 0.1.0-alpha.1

Primeira versão utilizável (DA-VSCODE-MVP-001):

- Activity Bar **Agentic** com as views *Projeto* e *Missions*.
- Detecção automática do projeto (`.agentic/project.yaml`, repoRoot canônico, branch git).
- Ciclo de vida do control plane: Start (reutiliza o dono existente), Stop gracioso, Restart serializado.
- Providers com estado READY / UNAVAILABLE / UNKNOWN.
- Missions com estado e último run; detalhes no painel.
- Painel **Open Agentic** (Project Home) via webview sem rede, por `postMessage`.
- Abrir arquivo/worktree e diff nativo (`git show` dos dois lados) a partir do painel.
- Segurança: o `agentic serve` nasce com allowlist de ambiente (P17); a webview só abre
  caminhos do projeto ou publicados pelo host; `node` é validado contra o driver nativo do projeto.
