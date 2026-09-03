# DA-VSCODE-MVP-001 — First usable VS Code extension

**Branch:** `feature/DA-VSCODE-MVP` (a partir de `integration/STABILITY-FINAL-PRE-VSCODE`; `main` intocada)
**Data:** 2026-09-02
**Veredito:** FIRST_USABLE_VSIX_READY (com ressalvas; ver seção final).

## A. Arquitetura

```text
VS Code Extension  →  AgenticHost (cliente/serviço)  →  Control Plane (agentic serve)  →  Orchestrator
```

A extensão (`extensions/vscode`) é casca e cliente. Não contém orquestrador, servidor nem
banco: o teste `src/bundle.test.ts` compila `src/extension.ts` de verdade e prova que o
bundle não carrega Fastify, SQLite nem orquestrador. Decisão registrada em
[ADR-0015](../adr/ADR-0015-extensao-vscode-como-cliente.md).

- `src/core/` — sem `vscode`, testado sem SO: `project.ts` (detecção, repoRoot canônico,
  branch), `discovery.ts` (`control-plane.json` + `/api/health` pelo mesmo `repoRoot`),
  `client.ts` (HTTP com o header de guarda do projeto), `toolchain.ts` (node ≥ 22 que carrega
  o driver nativo do projeto; CLI do repo / node_modules / PATH), `launcher.ts` (único
  `spawn`), `service.ts` (máquina de estados da janela), `missions.ts`.
- `src/vscode/` — `host.ts` (o que a janela sabe), `status-view.ts`, `missions-view.ts`,
  `home-panel.ts` (webview), `git-content.ts` (diff nativo via `git show`), `commands.ts`.
- `media/home.ts` + `media/home.css` — Project Home da webview, vanilla, sem rede; reaproveita
  `apps/web/src/lib/format.ts`.

## B. Arquivos

`extensions/vscode/{package.json, esbuild.mjs, tsconfig.json, .vscodeignore, README.md,
CHANGELOG.md, LICENSE, resources/agentic.svg, resources/icon.png, media/home.{ts,css},
src/extension.ts, src/core/*, src/vscode/*, src/webview/protocol.ts, src/*.test.ts,
test/run.mjs, test/suite.cjs}`. Na raiz: workspaces `extensions/*`, scripts `vscode:*`,
projeto `vscode-extension` no vitest, `extensions/vscode/src` no typecheck, fronteira
`vscode: ['schemas','server','web']` no lint, `.vscode/launch.json` (F5).

## C. Comandos

`agentic.start`, `agentic.stop`, `agentic.restart`, `agentic.open` (Open Agentic),
`agentic.refresh`, `agentic.showLog`, `agentic.openMission`, `agentic.openMissionFile`,
`agentic.openFile`, `agentic.openDiff` (os quatro últimos fora da paleta).

## D. Activity Bar

Container `agentic` com as views `agentic.status` (Projeto · Branch · Control Plane ·
Providers · Mission) e `agentic.missions`. Ícones de título condicionados a
`agentic.controlPlane` (Start quando parado; Stop/Restart quando no ar). Welcome view
quando não há projeto.

## E. Project detection

`workspaceContains:.agentic/project.yaml` ativa; a primeira pasta com `.agentic/project.yaml`
(subindo a partir dela) é o projeto. `repoRoot` = `project.repoRoot` resolvido e
canonicalizado (a identidade, I14); `runtimeDir` = `<repoRoot>/.agentic`; branch via
`git rev-parse`. Sem git o projeto continua detectado, com o fato exibido.

## F. Lifecycle

`STOPPED → STARTING → RUNNING → STOPPING → STOPPED`, com `FAILED` quando o encerramento
vence o prazo (processo mantido; Stop de novo tenta outra vez). `Start` reutiliza o dono
vivo (registro + health pelo mesmo `repoRoot`) e só no silêncio sobe
`agentic serve -C <repoRoot>`; `serve` que sai com 0 porque outra janela venceu a corrida
vira reutilização. `Stop` de filho: SIGTERM e espera pela saída; de dono externo: SIGTERM ao
pid publicado e espera pelo silêncio da descoberta. `Restart` é stop provado e depois start,
serializados. Ao fechar a janela, `deactivate` encerra o filho que ela criou (setting
`agentic.stopOnWindowClose`, default `true`), com prazo de 4 s.

## G. Provider status

`GET /api/providers` → READY / NOT READY / UNAVAILABLE / UNKNOWN por `installed`/`ready`,
com versão, em voo e capacidade; tooltip com `detail`/`readinessSource`. Sem control plane:
"não apurado", nunca zero.

## H. Missions

Lista do control plane (`GET /api/missions`) ou, parado, do disco (mesmo filtro). Estado
= status do último run; sem run, `READY`/`INVALID` pelo compile; sem control plane,
`UNKNOWN` com `runsKnown: false`. Selecionar abre detalhes no painel: diagnósticos, runs,
tasks do último run (worktree, touches, diffs).

## I. Webview

Painel `agentic.home` com CSP `default-src 'none'`, `script-src` por nonce, sem
`connect-src`; tudo por `postMessage` validado (`isWebviewToHost`); DOM montado pela API,
sem `innerHTML` com dados.

## J. VS Code file/diff integration

Caminhos do painel abrem no editor (`showTextDocument`) ou revelam a pasta; diff nativo por
`vscode.diff` sobre um `TextDocumentContentProvider` (`agentic-git:`) que faz `git show
<ref>:<path>` dos dois lados (baseCommit ↔ commit/branch da tentativa).

## K. Múltiplas janelas

`src/multi-window.test.ts` (processos reais com a CLI construída): a segunda janela reutiliza
o dono da primeira; o `Stop` da segunda encerra o processo da primeira de forma graciosa
(registro retirado); projetos diferentes têm donos independentes.

## L. Testes direcionados

Projeto vitest `vscode-extension` (no `verify`): deteção, extração do YAML, descoberta,
máquina de estados (start/stop/restart/refresh, 16 casos), cliente HTTP, toolchain (incl.
ABI do driver nativo), missions, protocolo, bundle sem core, múltiplas janelas.
Integração num VS Code real (`npm run vscode:test:integration`, fora do `verify` como
`test:browser`): ativação, comandos, detecção, Start, providers/missions, painel, Restart,
Stop — 8/8 no projeto descartável **e** 8/8 sobre este repositório (providers reais).

## M. Full gate final

Executado uma vez no fim do lote (e o `verify` repetido após cada ciclo de correção):

| Gate | Resultado |
| --- | --- |
| `npm run build` | OK |
| `npm run verify` (lint + typecheck + test) | 201 arquivos, 2361 testes, verde |
| `npm run test:e2e` | 98 passados, 4 pulados (por desenho) |
| `npm run test:browser` | 10/10 |
| `npm run vscode:test:integration` (VS Code real, projeto descartável) | 8/8 |
| `AGENTIC_IT_WORKSPACE=<este repo> npm run vscode:test:integration` | 8/8, providers reais |

Uma reprovação no primeiro `verify`: o teste de bundle procurava a string `better-sqlite3`,
que passou a existir de propósito (nome do driver que a sonda da toolchain carrega num
filho). O teste foi trocado pela prova por `metafile` do esbuild.

## N. Codex review

Codex fresh, read-only, `integration/STABILITY-FINAL-PRE-VSCODE..feature/DA-VSCODE-MVP`,
foco nos nove itens da missão. Log em `codex-review.log`/`codex-review-2.log` (scratchpad).

**Ciclo 1 — FAIL, 6 MAJOR, todos do lote, todos corrigidos (commit `084efbc`):**
start que estoura o prazo sem esperar a saída; start não idempotente em RUNNING; `-C` com
`repoRoot` em vez de `projectDir`; `process.env` inteiro injetado no filho (P17); payload da
webview validado só pelo tipo e caminhos sem autorização; prova de bundle por strings.
MINOR também tratados: menu Start/Stop por estado, `deactivate` honesto, serviço de projeto
anterior alcançável.

**Ciclo 2 — FAIL, 6 MAJOR.** O limite da missão é um ciclo de correção; ainda assim os
achados eram de segurança e corrida, e foram corrigidos **sem terceira rodada do Codex**
(estas correções ficam registradas como *não revisadas independentemente*):

| Achado (ciclo 2) | Correção |
| --- | --- |
| corrida entre janelas: filho perdedor sai com 0 antes de o vencedor publicar → STOPPED falso; ou handle do perdedor mantido junto ao vencedor | espera pelo vencedor até o prazo; o perdedor é assentado antes da adoção; após parar o filho, redescobre e não declara STOPPED com outro dono vivo; teste com dois `ensureRunning()` simultâneos |
| `deactivate` ignora filho em STARTING/FAILED | rastreio de `childPid` (filho vivo) separado de `owned`; o encerramento da janela alcança todo filho vivo |
| projeção manual do YAML diverge da CLI (flow mapping, escapes, `#` em string) | parser YAML genérico (`yaml`), mesmas quatro chaves |
| autorização lexical escapa por symlink | comparação sobre `realpath`; alvo inexistente é recusado |
| refs do `openDiff` viram opção do git (`--output=`) | refs e caminho validados por padrão (nunca começam com `-`), `--end-of-options`, só diffs publicados pelo host, payload sem chaves extras |
| `agentic.childEnvAllow` reabre passthrough de segredo | setting removido; allowlist fechada; o teste real usa `childEnv` |
| (MINOR) contenção por prefixo textual em missions offline | `relative` por segmentos |
| (MINOR) docs com `-C <repoRoot>` | ADR/README corrigidos |
| (MINOR) `lib: DOM` no typecheck raiz | removido; `npm run typecheck` roda também o tsconfig da extensão |

Achado não endereçado: a corrida realmente simultânea de duas janelas com processos reais
não é coberta pelo teste de múltiplas janelas (só pelo teste com dublês).

## O. VSIX

`desenvolvimento-agentico-vscode-0.1.0-alpha.1.vsix` (13 arquivos, ~67 KB), gerado por
`npm run vscode:package` (`vsce package --no-dependencies`). Versão `0.1.0-alpha.1` aceita
pelo empacotador. Não publicado.

## P. Instalação / dogfooding

VSIX instalado no VS Code local (`code --install-extension`). Dogfooding sobre este
repositório revelou um defeito real: com Node 20 no `PATH` do editor, a extensão escolhia o
Node mais novo do nvm (24), cujo ABI não é o do `better-sqlite3` instalado (127 ≠ 137). A
correção valida cada candidato abrindo um banco em memória com o driver do projeto (o
`require` do pacote não basta: o binário carrega de forma preguiçosa). Jornada completa
confirmada em VS Code real sobre este repositório: Activity Bar, projeto detectado, Start
(adotou o run existente), Status, Providers (claude-code e codex READY), Missions, Webview,
Restart, Stop.

## Q. Limitações

- Linux/macOS: Stop de dono externo usa SIGTERM.
- A CLI precisa existir no repositório, em `node_modules/.bin` ou no `PATH`; não é embutida.
- Provider CLIs precisam estar no `PATH` visto pelo VS Code.
- Multi-root: uma pasta por janela (a primeira com projeto).
- Dono sem registro (endereço declarado respondendo, sem pid) não pode ser parado daqui.
- Dívida conhecida da 004B (cancelamento com gate/integração em voo) aparece como `Stop` →
  `FAILED` com processo mantido — visível, não escondida.
- Sem chat, sem editor de mission, sem Plan/DAG approval, sem Marketplace/auto-update.

## R. Branch / commits

Branch `feature/DA-VSCODE-MVP` a partir de `integration/STABILITY-FINAL-PRE-VSCODE` (`d4c283c`); `main` intocada; nada foi enviado ao remoto.

```text
2a9397d fix(DA-VSCODE-MVP-001): achados do ciclo 2 da revisao — corrida entre janelas, filho vivo no deactivate, YAML por parser, realpath na autorizacao, refs do git validadas, allowlist fechada
084efbc fix(DA-VSCODE-MVP-001): ciclo de revisao — prova no timeout do start, start idempotente, -C no projectDir, allowlist de ambiente, payload e caminhos da webview autorizados, bundle provado por metafile
8876998 test(DA-VSCODE-MVP-001): bundle proibe o CODIGO do driver, nao o nome usado pela sonda
756dd93 chore(DA-VSCODE-MVP-001): diagnostico do serve comeca pela toolchain escolhida
831662e fix(DA-VSCODE-MVP-001): o node do control plane precisa carregar o driver nativo do projeto
83ff5c7 test(DA-VSCODE-MVP-001): jornada da extensao num VS Code real (@vscode/test-electron)
598c930 docs(DA-VSCODE-MVP-001): ADR-0015 — extensao VS Code como cliente do control plane
9a3570a feat(DA-VSCODE-MVP-001): extensao VS Code — shell, deteccao de projeto, ciclo de vida do control plane, sidebar e webview
<este relatório>
```

## S. git status

Limpo após o commit deste relatório (`git status --short` vazio). O VSIX na raiz é ignorado por `.gitignore`.

## Veredito

**FIRST_USABLE_VSIX_READY**, com duas ressalvas explícitas para decisão humana:

1. A revisão independente do Codex reprovou nos dois ciclos executados. Todos os MAJOR dos
   dois ciclos foram corrigidos e cobertos por teste, mas as correções do ciclo 2 não
   passaram por uma terceira rodada (limite da missão). Recomenda-se uma revisão fresh antes
   de promover a cadeia.
2. A jornada foi confirmada por automação em VS Code real (duas vezes, dois projetos) e
   pelo operador na própria janela, que revelou o defeito da ABI do Node — corrigido e
   reempacotado. A validação manual final do VSIX reinstalado (após *Reload Window*) fica
   com o operador.

Próxima missão: **DA-VSCODE-MVP-002 — Nova Mission + DAG + Approve + Run.**
