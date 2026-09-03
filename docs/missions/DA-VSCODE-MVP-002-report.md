# DA-VSCODE-MVP-002 — Mission → DAG → Approve → Run

**Branch:** `feature/DA-VSCODE-MVP-002` (a partir de `feature/DA-VSCODE-MVP`; `main` intocada)
**Data:** 2026-09-03
**Veredito desta rodada:** `BASE_VSCODE_BLOCKED` — ver §A. O desenvolvimento do MVP-002 **não começou**;
o que existe no branch é o terreno preparado (§B).

## A. Base review (Fase 1)

Codex fresh, read-only, escopo restrito às seis correções finais da MVP-001 (commit `2a9397d`).
Log em `codex-base-review.log` (scratchpad da sessão). Resultado: **FAIL**, com dois MAJOR nas
categorias que a missão manda parar:

| # | Achado | Categoria da missão | Evidência |
| --- | --- | --- | --- |
| 2 | `deactivate` pode perder um filho: se a janela fechar (ou o projeto trocar) enquanto `spawnServe()` ainda resolve a toolchain, `childPid` não existe e o serviço fica fora do encerramento; o `launchServe()` conclui depois e cria um filho *detached* sem `stop()`. E, se o filho sair e outra janela publicar um dono antes de `doStop()`, o caminho "externo" sinaliza esse dono. | perda de lifecycle; toca dono alheio | `service.ts:177`, `host.ts:88/129/352`, `service.ts:271/304/320` |
| 3 | O schema da CLI faz `.trim()` nas strings; a extensão não. `repoRoot: " ../repositorio "` resolve para caminhos diferentes na CLI e na extensão; se o caminho literal existir e contiver `apps/cli/bin/agentic.mjs`, a extensão executa a CLI de outro diretório. `server.host` idem (`declaredUrl`). | execução no projeto errado | `project.ts:65/93/151`, `toolchain.ts:228`, `packages/schemas/src/common.ts:20` |

MINOR registrados (seguir sem corrigir agora): corrida entre janelas ainda admite dois processos
vivos quando o perdedor ignora SIGTERM (fica em `childPid`, sem perda de lifecycle);
`childEnv` materializa os valores de `process.env` antes de filtrar (nada é injetado).
NOTA: autorização de caminhos e refs/opções do git estão contidas.

**Correções recomendadas (pequenas, sem saga):**

1. `AgenticService`: registrar `spawning` (promessa do `spawnServe`) e expor no `view()`;
   `shutdown` espera o spawn pendente (com prazo) e para o filho; `retired` guarda serviço com
   spawn em voo. Novo `stopOwnChild()` que **nunca** cai no caminho externo, usado só pelo
   `deactivate`.
2. `readProjectFacts`: `trim()` em `name`, `repoRoot` e `host`, igual ao schema.

## B. Terreno preparado: merge de `mission/DA-UX-001`

O planning que a missão manda reutilizar existia só em `mission/DA-UX-001` (19 commits sobre
`main`, nunca integrado à cadeia de estabilidade). Foi feito o merge no branch novo:

- 4 conflitos resolvidos à mão, todos na fronteira com a cadeia de estabilidade
  (`control-plane.ts`, `server.ts`, `apps/cli/src/deps.ts`, `.gitignore`): o corpo de
  `createControlPlane` com posse/lease foi mantido e o planejamento enxertado sobre
  `runtimeDir` (sem `baseDir`/`databasePath`, I14); `planMission` passa pela mesma guarda de
  posse e de `quiesce()` que `createRun`/`approveMission`/`startRun`.
- `ADR-0013` do planning renumerado para `ADR-0016` (colisão com o ADR de posse), com as
  citações no código atualizadas.
- O launcher `agentic` sem argumento (U02) **não** foi portado: conflita com a verificação de
  identidade da cadeia e não é necessário para a extensão. `launch.ts`, `browser.ts` e seus
  testes ficaram de fora.
- Testes de planning do servidor passaram a adquirir a posse do fixture (como o harness) e o
  `.gitignore` do fixture ignora o lock de posse.
- Extensão adaptada ao `GET /api/missions` enriquecido (`MissionSummaryDto`); `tsconfig` da
  extensão passou a mapear todos os `@agentic/*` para o fonte.

Validação do merge: typecheck OK; lint OK; testes direcionados de domain, schemas, providers,
orchestrator, server, cli, workspace, web e extensão: 172 arquivos, 2144 testes, verde.
`verify`/e2e/browser completos **não** rodados (política do lote).

**Dívida registrada ao portar:** `agentic init` não escreve `.gitignore`; num projeto novo o
lock de posse e o `state.db` aparecem como não rastreados e a impressão digital do repositório
usada pelo planejamento os inclui — o dogfooding do MVP-002 em projeto descartável precisa
de `.gitignore` (ou o `init` precisa gerá-lo). F2 (livelock ao reiniciar missão) e F5 (run
reaberto sem executor) do relatório da DA-UX-001 continuam abertos.

## C. Próximo passo

Decisão humana: aplicar as duas correções de §A (cerca de 40 linhas, com teste) e retomar a
Fase 1 com uma leitura fresh restrita a elas — ou aceitar o risco e seguir para o MVP-002.
