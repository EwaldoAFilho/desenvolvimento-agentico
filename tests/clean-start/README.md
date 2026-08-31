# Partida em ambiente limpo

Prova que alguém que acabou de clonar o repositório consegue **instalar, compilar e usar**
o produto — pelos entrypoints publicados, não por módulo interno.

## Por que este teste existe

Um reboot trocou o Node de 24 para 20. O resultado foram **262 falhas de teste** com
`NODE_MODULE_VERSION` do módulo nativo `better-sqlite3`. O `doctor` do produto diagnosticou
na primeira linha; a instalação e o `npm run verify` não disseram nada útil — o `npm ci`
compilou um binário nativo contra o ABI errado e o erro só apareceu muito depois, longe da
causa.

Duas coisas saíram daí:

1. **`.npmrc` com `engine-strict=true`** na raiz do repositório. `npm ci` / `npm install`
   passam a **recusar** Node fora de `engines` do `package.json`, com a mensagem do próprio
   npm, antes de instalar qualquer coisa:

   ```text
   npm error code EBADENGINE
   npm error engine Not compatible with your version of node/npm: desenvolvimento-agentico@0.1.0
   npm error notsup Required: {"node":">=22"}
   npm error notsup Actual:   {"npm":"10.8.2","node":"v20.18.1"}
   ```

   Verificado nos dois sentidos: com `engine-strict=false` o mesmo `npm ci` sob Node 20 sai
   **0** e instala; com `engine-strict=true` sai **1** sem criar `node_modules`.

2. **Este teste**, que roda a partida inteira do zero e falha se qualquer degrau quebrar.

### O que o `.npmrc` NÃO cobre

`engine-strict` vale para **instalação**, não para `npm run`. Verificado: com
`engine-strict=true`, `npm run build` sob Node 20 sai **0** normalmente. Ou seja, o cenário
exato do incidente — `node_modules` instalado sob Node 24, reboot, `npm run verify` sob
Node 20 — continua possível, porque nenhuma instalação acontece nesse caminho. O `.npmrc`
impede que a reinstalação sob o Node errado produza um binário nativo errado; ele não
impede **rodar** sob o Node errado contra binário de outro ABI.

Quem fecha essa porta hoje é o `doctor`, que diz na primeira linha qual Node está rodando.
Fechar por completo exigiria uma checagem de `engines` em tempo de execução antes da suíte
(um `pretest`/`preverify`, ou um setup do vitest) — e `package.json` e `vitest.config.ts`
estão fora do `touches` desta task.

## Como rodar

```sh
node tests/clean-start/clean-start.mjs
```

**Este teste é lento e não entra em `npm run verify`.** Ele instala e compila um repositório
inteiro; com cache npm frio leva minutos. `package.json` não faz parte do `touches` desta
task, então o script fica pronto para ser plugado como:

```json
"scripts": {
  "test:clean-start": "node tests/clean-start/clean-start.mjs"
}
```

O `vitest.config.ts` **não** deve ganhar um projeto para este diretório: os projetos
existentes incluem `tests/tools/**` e `tests/e2e/**`, e `npm run test` é filtrado por
exclusão (`--project=!e2e`) — qualquer projeto novo entraria no `verify` automaticamente,
que é exatamente o que este teste não pode fazer. Por isso ele é executável por `node`
direto, sem runner.

### Variáveis de ambiente

| Variável | Efeito |
| --- | --- |
| `CLEAN_START_LEGACY_NODE` | Caminho do `bin/` (ou do binário) de um Node **antigo**. Liga o passo que prova a recusa do `npm`. Ex.: `~/.nvm/versions/node/v20.18.1/bin`. |
| `CLEAN_START_DIR` | Onde criar a cópia temporária (default: `os.tmpdir()`). |
| `CLEAN_START_KEEP=1` | Não apaga a cópia ao final. |
| `CLEAN_START_VERBOSE=1` | Espelha stdout/stderr de cada comando enquanto roda. |

Em falha a cópia é **sempre** preservada, e o caminho vai impresso.

## O que ele faz

1. **Guarda de engine** — `.npmrc` existe e tem `engine-strict=true`; `package.json` declara
   `engines.node`.
2. **Cópia limpa** — copia o repositório sem `node_modules`, `dist`, `.git`,
   `.agentic/state.db*`, `.agentic/runs/`, `.agentic/worktrees/`, `coverage`, `*.tsbuildinfo`
   e `.env`/`.env.*` (o `.env.example`, que é fonte versionada, fica). Configuração local de
   máquina não pode fazer a partida limpa passar — nem viajar para o diretório temporário.
   Depois `git init` na cópia: um `git clone` entrega um repositório, e o `project.yaml` usa
   `workspace: git-worktree`; o que não queremos carregar é a **história**, não o `.git`.
3. **Node antigo recusado** (opt-in) — `npm ci` com o Node antigo tem de falhar citando
   `EBADENGINE` **sem** ter criado `node_modules`.
4. **`npm ci`**.
5. **`npm run build`**.
6. **`node apps/cli/bin/agentic.mjs doctor`** — o entrypoint oficial, humano e `--json`.
7. **`node apps/cli/bin/agentic.mjs serve --port <livre>`** + `GET /api/health` — 200.
8. **Derruba tudo** — `SIGTERM` no control plane, encerramento com código 0, cópia removida.

A cópia é da **árvore de trabalho como está**, não do que está commitado — é isso que
responde "o que eu tenho aqui instala e sobe?". Com edição em voo no repositório ele pode
capturar um estado transitório e reprovar no `npm run build`; a mensagem mostra o erro do
`tsc`, e a leitura correta é rodar de novo com a árvore parada.

Nenhum arquivo TypeScript interno é chamado no lugar do entrypoint. A porta do servidor é
**sorteada pelo SO**, nunca a `4317` do projeto: se um control plane alheio já estivesse no
ar, ele responderia `/api/health` e o teste passaria por engano. Pela mesma razão o teste
confere que o `repoRoot` da resposta é o da cópia.

Nenhum agente real é invocado e nenhuma quota é consumida. O `doctor` sonda as CLIs locais
(`--version`, status de sessão) porque é o trabalho dele; isso não gasta token.

## O que reprova

Reprova (código de saída 1) qualquer degrau que quebre, e dentro do `doctor` estes checks
precisam sair `ok`:

| Check | Por quê |
| --- | --- |
| `node.version` | A cadeia de ferramentas é o objeto deste teste. |
| `project.files` | `.agentic/project.yaml` e `gates.yaml` válidos na cópia. |
| `git.installed`, `git.repository` | `workspace: git-worktree` exige repositório. |
| `state.running` | **O canário.** Ele só responde `ok` se o módulo nativo do banco carregou — é exatamente o que quebrou com o Node 20. |
| `provider.mock` | Fornecedor in-process: independe da máquina. |

Os checks de fornecedor **real** (`provider.claude-code`, `provider.codex`) são reportados
mas **não** reprovam: dependem de quais CLIs estão instaladas na máquina, não da partida.
Exigir `ok` deles deixaria o teste vermelho em qualquer máquina sem as CLIs — e o que a
partida limpa garante é a cadeia de ferramentas.

## Saída real do `doctor` no ambiente limpo

Primeira coisa que quem instala vê. Capturado por este teste em 31/08/2026, Node 24.18.1,
na cópia limpa (o caminho longo é o diretório temporário da cópia):

```text
doctor · /tmp/.../agentic-clean-start-UEsNJL

  ok       versao do Node                     node 24.18.1
  ok       arquivos do projeto                /tmp/.../agentic-clean-start-UEsNJL/.agentic/project.yaml e /tmp/.../agentic-clean-start-UEsNJL/.agentic/gates.yaml validos
  ok       git disponivel                     git version 2.53.0
  ok       repositorio git valido             /tmp/.../agentic-clean-start-UEsNJL e um repositorio git
  ok       workspace x paralelismo            workspace: git-worktree com maxParallelTasks: 5
  ok       capacidade somada dos fornecedores capacidade somada 13 · teto global 5
  ok       agentes em voo                     0 em voo segundo o estado persistido
  ok       fornecedor claude-code             READY · executavel em /home/.../bin/claude; versao via `claude --version`; sonda `claude auth status` saiu 0 e declarou sessao autenticada
  ok       fornecedor codex                   READY · executavel em /home/.../bin/codex; versao via `codex --version`; sonda `codex login status` saiu 0
  ok       fornecedor mock                    READY · agente in-process; prontidao true

fornecedores

  claude-code  READY
    instalado      sim
    executavel     claude
    caminho        /home/.../bin/claude
    versao         2.1.220
    pronto         sim · origem: sonda `claude auth status` saiu 0 e declarou sessao autenticada
    em voo         0 · capacidade 3
    detalhe        executavel em /home/.../bin/claude; versao via `claude --version`; sonda `claude auth status` saiu 0 e declarou sessao autenticada

  codex  READY
    instalado      sim
    executavel     codex
    caminho        /home/.../bin/codex
    versao         0.151.0-alpha.7.2
    pronto         sim · origem: sonda `codex login status` saiu 0
    em voo         0 · capacidade 2
    detalhe        executavel em /home/.../bin/codex; versao via `codex --version`; sonda `codex login status` saiu 0

  mock  READY
    instalado      sim
    executavel     (in-process)
    caminho        unknown
    versao         1.0.0-mock
    pronto         sim · origem: unknown
    em voo         0 · capacidade 8
    detalhe        agente in-process; prontidao true

  FORNECEDOR   ESTADO  INSTALADO  PRONTO  VERSAO             EM VOO  CAPACIDADE
  claude-code  READY   sim        sim     2.1.220            0       3
  codex        READY   sim        sim     0.151.0-alpha.7.2  0       2
  mock         READY   sim        sim     1.0.0-mock         0       8

`unknown` significa que nao foi possivel apurar — nunca conte como pronto.
INSTALLED = instalado com prontidao nao apurada; READY exige sonda de sessao que aprovou.
```

Sem `.git` na cópia — isto é, **antes** do `git init` do passo 2 — a mesma saída troca uma
linha e o comando sai **1**, o que é a leitura correta do ambiente:

```text
  ERRO     repositorio git valido             /tmp/.../engine-probe nao e repositorio git: workspace git-worktree exige um
...
erro [ENVIRONMENT_INVALID]: 1 problema(s): git.repository
```

## Execução completa registrada

```text
[1/7] guarda de engine (.npmrc)
      .npmrc exige engines.node >=22 · rodando node 24.18.1
[2/7] copia limpa do repositorio
[3/7] Node antigo recusado
      v20.18.1 recusado com EBADENGINE antes de instalar qualquer coisa
[4/7] npm ci
[5/7] npm run build
[6/7] node apps/cli/bin/agentic.mjs doctor
      node 24.18.1
      0 em voo segundo o estado persistido — o modulo nativo do banco carregou
[7/7] node apps/cli/bin/agentic.mjs serve + GET /api/health
      GET http://127.0.0.1:40133/api/health -> 200 "ok" · @agentic/server
      SIGTERM encerrou o control plane com codigo 0

partida limpa ok em 10.3s
```

Os 10,3 s são com cache npm quente. Com cache frio o passo `npm ci` domina o tempo — daí os
limites generosos (15 min para instalar e compilar, 90 s para o `/api/health` responder).
