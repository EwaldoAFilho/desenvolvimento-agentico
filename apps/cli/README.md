# @agentic/cli — o binário `agentic`

Camada **fina** sobre `@agentic/orchestrator`. A CLI traduz entrada do usuário em caso de uso
e resposta em saída; nenhuma regra de orquestração mora aqui.

```bash
node apps/cli/bin/agentic.mjs --help
```

## Comandos

| Comando | O que faz |
| --- | --- |
| `agentic init [dir]` | cria `.agentic/` com `project.yaml`, `gates.yaml` e uma missão de exemplo. Nunca sobrescreve |
| `agentic mission validate <arquivo>` | schema + semântica. Exit 0 **só** sem `ERROR` |
| `agentic mission compile <arquivo>` | DAG: tasks por fase, waves, caminho crítico, pares concorrentes, conflitos de `touches` |
| `agentic mission approve <arquivo> --actor <nome>` | registra a aprovação humana |
| `agentic mission start <arquivo> [--accept-warnings] [--serve]` | cria o run e orquestra |
| `agentic mission status [runId]` | retrato do run |
| `agentic mission pause\|resume\|stop [runId]` | comandos sobre o run em voo |
| `agentic serve [--port]` | control plane sem run ativo (ver ressalva abaixo) |
| `agentic task inspect <T> [--run <id>]` | detalhe completo, **com worktree e branch** (`code <path>`) |
| `agentic task retry\|unblock\|skip <T>` | `unblock` exige `--note`; `skip` exige `--reason` |
| `agentic run report [runId] [--md]` | relatório final |
| `agentic events tail [runId] [--since <seq>] [--follow]` | log append-only |
| `agentic providers` | installed / ready / version / running / capacity |
| `agentic doctor` | node, git, workspace e saúde dos fornecedores |

## Códigos de saída

| Código | Significado |
| --- | --- |
| `0` | ok |
| `1` | erro de validação ou de execução (missão com `ERROR`, run recusado, ambiente inválido) |
| `2` | erro de uso (`--note` ausente, id inválido, opção desconhecida) |

## `--json`

Todo comando aceita `--json` e emite **um** documento com envelope estável:

```json
{ "ok": true, "command": "mission validate", "data": { "...": "CompileReportDto" } }
{ "ok": false, "command": "mission start", "error": { "code": "NOT_APPROVED", "message": "..." } }
```

`data` é sempre um contrato de `@agentic/schemas` (`CompileReportDto`, `RunSnapshot`,
`TaskDetail`, `EventDto[]`, `ProviderHealthDto[]`) ou um objeto documentado do comando.

## Leitura x mutação (I7)

- **Leitura** (`status`, `task inspect`, `events tail`, `run report`) abre o estado local e
  funciona com o run parado, sem daemon.
- **Mutação sobre run** (`pause`, `resume`, `stop`, `task retry|unblock|skip`) exige control
  plane no ar e vai por HTTP local. Sem processo, a CLI **diz isso** em vez de escrever no
  banco por fora do único escritor.
- `approve` e `start` delegam ao control plane quando há um no ar; sem ele, a própria CLI
  vira o processo do control plane — é assim que um run começa.

## Ressalva do `serve`

A API HTTP + SSE é publicada por `@agentic/server`, e a regra de fronteiras
(`scripts/boundaries.config.mjs`) **proíbe** `cli` de importar `server`. Então `agentic serve`
informa o endereço configurado e manda subir o servidor (`npm start -w @agentic/server`) em vez
de fingir que subiu. Se já houver control plane no ar naquele endereço, ele diz isso e sai 0.

## `unknown` é `unknown`

Prontidão de fornecedor que não pôde ser apurada sai como `unknown` — nunca `sim`, nunca
verde. Uma CLI que respondeu `--version` **não** prova autenticação.

## Arquitetura interna

Cada comando é `(args, deps) => Promise<CommandResult>`. `deps` (`src/deps.ts`) carrega stdout,
stderr, exit, relógio, ambiente, a fábrica do control plane, a do registry de providers, a
sonda do git e a conexão com o control plane. Por isso a suíte testa comando por comando, com
saída capturada, sem `spawn` e sem nenhum agente real.
