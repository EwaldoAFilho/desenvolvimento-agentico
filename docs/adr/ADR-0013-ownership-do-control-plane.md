# ADR-0013 — Posse do projeto por lock SQLite dedicado

**Status:** Aceita · **Data:** 2026-09-01

## Contexto

I13 garante que um run recuperável tem exatamente um `Orchestrator` com o loop ligado —
**naquela instância**. Entre processos ela não garantia nada, e isso deixou de ser teórico
quando a adoção passou a acontecer sozinha no boot: antes, um segundo processo só operava um
run depois de um comando humano; depois, bastava existir.

Foi medido com processos de sistema operacional separados, portas efêmeras e o mesmo
`repoRoot`: os dois abriam o mesmo `.agentic/state.db`, os dois adotavam o mesmo run e cada um
se declarava dono. O event log do run guarda a colisão:

```
policy.invalid_transition  READY→RUNNING   GUARD_FAILED:workspace-acquired
                                           (caminho de worktree ja existe)
policy.invalid_transition  BLOCKED→FAILED  ATTEMPT_FAILED  NOT_LISTED
```

O primeiro é o caminho da worktree, derivado de `attemptCount + 1` e portanto igual nos dois
processos. O segundo é pior: uma tentativa terminou contra uma task que o outro dono já havia
movido, e **o trabalho foi descartado em silêncio**.

Três coisas que pareciam proteger e não protegem:

- **`control-plane.json`** é publicado *depois* do `listen`, com escrita não atômica e sem
  identidade além do pid. Último a escrever vence, e um dono vivo some do mapa.
- **A checagem de reuso da CLI** é conselho, não guarda: é TOCTOU, vive só no `serve`, e
  `--port` a desliga por completo (`resolveEndpoint` devolve a flag antes de olhar a
  descoberta).
- **SQLite WAL no `state.db`** serializa escritas; não impede dois escritores legítimos.

E o estado não se defende: o tick lê fora da transação e grava com `upsert` incondicional —
não há compare-and-swap nem versão de linha.

## Decisão

Posse do projeto é uma transação `BEGIN EXCLUSIVE` mantida aberta, pela vida do processo,
sobre um banco SQLite **dedicado**: `.agentic/control-plane.lock.db`.

O banco não guarda nada. Sem tabela, sem linha, sem migração, sem `PRAGMA` — o arquivo fica
com zero byte para sempre. O que vale não é o conteúdo: é o **lock de arquivo** que o SQLite
pede ao sistema operacional (`fcntl` em Linux/macOS/WSL, `LockFileEx` em Windows) para
sustentar a transação.

A chave é `<repoRoot>/.agentic` **canonicalizado** (`realpath`): o mesmo diretório que guarda
o `state.db`. Não é a porta, e não é o texto do caminho — `/repo` e `/atalho-para-repo` são o
mesmo projeto e disputam a mesma posse.

Duas propriedades vêm do sistema operacional, e são as duas mais difíceis do problema:

1. **Exclusividade atômica.** Não existe janela entre "ver se há dono" e "virar dono": é um
   ato só, arbitrado pelo kernel. Medido com oito processos concorrentes, dez rodadas:
   exatamente um vencedor em todas.
2. **Liberação sem cleanup.** O lock morre com o processo — `SIGKILL`, OOM, queda de energia,
   reboot. Não há arquivo stale para interpretar, não há heurística de vivacidade, e um
   `release()` que falhe não tranca o projeto. Medido: depois de um `SIGKILL`, o processo
   seguinte assume em ~1ms.

Disso decorre que **o PID sai da cadeia de autoridade**. Ele continua no registro de
descoberta como informação para o humano ler; quem decide é o lock. PID reutilizado por outro
programa não muda nada.

Duas consequências de desenho:

- **Posse é adquirida antes de `createControlPlane`**, porque `createControlPlane` já escreve:
  abre o banco em `readwrite`, liga WAL e roda as migrações. Quem perde a disputa sai por
  `ControlPlaneBusyError` sem ter tocado em nada.
- **Posse e descoberta continuam sendo dois arquivos**, ligados por `instanceId`. O de posse é
  adquirido primeiro e nunca é removido por terceiros; o de descoberta é publicado tarde,
  removido no encerramento e limpo quando aponta para processo morto. Fundir os dois
  transformaria cada limpeza existente num roubo de posse.

### Ajuste ao protocolo diagnosticado

O diagnóstico previa uma linha commitada no banco de lock com a identidade do dono. Ela foi
**removida**, e o motivo é uma corrida real: commitar solta a transação que sustenta a posse,
e entre soltar e retomar existe exatamente a janela que este ADR existe para eliminar. Manter
a linha exigiria escolher entre identidade legível e posse contínua.

A identidade mora onde já havia lugar para ela: `control-plane.json` ganhou `instanceId` (e
`repoRoot`), publicado pelo dono depois de adquirir a posse. Perder a descoberta não perde a
posse — o perdedor recebe `SQLITE_BUSY` de qualquer forma, e a descoberta só decide a
qualidade da mensagem.

### Espera antes de recusar

A aquisição usa `busy_timeout = 250ms`, não zero. Não é para esperar o dono sair — o dono não
sai. É para atravessar o instante em que dois processos **criam** o arquivo ao mesmo tempo.
Com zero, essa disputa de criação virava recusa: medido em oito processos por doze rodadas,
uma rodada terminou com **zero vencedores** — ninguém subiria, e o projeto pareceria possuído
por um dono que não existe. Com 250ms, doze de doze com exatamente um vencedor.

## Alternativas

- **Lock file com `O_EXCL`/`wx`.** Também atômico (medido: 8 processos × 15 rodadas, um
  vencedor sempre). Rejeitado pelo que vem *depois* da aquisição: sem liberação pelo SO, é
  preciso inventar como saber que o dono morreu — e nenhuma resposta baseada em arquivo é
  honesta. `pid` mente sob reuso, heartbeat mente sob pausa do SO, `os.uptime()` mente em
  container. O lock do SQLite não precisa responder essa pergunta.
- **`BEGIN EXCLUSIVE` no próprio `state.db`.** Bloqueia as escritas do próprio orquestrador
  (`withTransaction` não pode aninhar `BEGIN`), impede checkpoint do WAL e faz o arquivo
  crescer sem limite.
- **Linha em tabela com compare-and-swap.** Atômica dentro do SQLite, mas devolve o problema
  do stale: linha marcada não morre com o processo. E exigiria migração no `state.db`, que é
  justamente o que a posse precisa proteger antes de abrir.
- **Socket de domínio Unix / named pipe.** Dois mecanismos diferentes por sistema
  operacional, e o nome do pipe no Windows é global à máquina, não ao sistema de arquivos —
  quebra o isolamento em Dev Containers.
- **`flock` via addon nativo.** Node não expõe `flock`. Precisaria de dependência nativa nova
  para obter exatamente o lock que o SQLite já obtém.
- **Porta fixa como exclusão.** Já foi medido furando: `agentic serve --port N` cria um
  segundo dono sobre o mesmo banco. E o produto precisa suportar porta por projeto.

## Consequências

- **I14** passa a existir, e I13 deixa de ter a nota de rodapé que a esvaziava: "naquela
  instância" vira "naquele projeto", porque só existe uma instância com direito a instâncias.
- `startServer` e `agentic mission start` (no ramo que orquestra em primeiro plano) disputam a
  posse. Um segundo `agentic serve` — **com ou sem `--port`** — não sobe: informa o endereço
  do dono e termina com sucesso.
- `adoptRecoverableRuns()` e `open()` recusam quando o plane declarou posse e a perdeu. O
  perdedor da disputa nem chega lá.
- Comandos de leitura continuam abrindo plane sem posse. Eles não possuem orquestrador nem
  despacham — mas hoje abrem em `readwrite`, e isso fica registrado como D9.
- `ensureAgenticRunning(repoRoot)`, para a futura extensão, fica implementável sem `ps`, sem
  `kill`, sem porta fixa e sem `sleep`: lê a descoberta, tenta o endereço, e no silêncio manda
  subir um control plane — que ou vira dono, ou informa quem é.

### Limites declarados

- **Threat model.** O lock impede duas instâncias **legítimas do próprio produto** de operar o
  mesmo projeto. Não é barreira contra alguém com acesso ao disco: apagar
  `control-plane.lock.db` com o dono vivo derruba a exclusividade, e nenhum mecanismo de
  arquivo resolveria isso. Não vamos construir sandbox contra o usuário administrador da
  própria máquina.
- **Sistema de arquivos de rede.** Locks POSIX não são confiáveis em NFS/SMB. `.agentic/` é
  local por desenho (ADR-0003). Um repositório montado ao mesmo tempo no host e dentro de um
  container por um sistema de arquivos que não propaga locks pode render dois donos — é
  limite documentado, não mecanismo alternativo.
- **A garantia é por diretório de estado.** Dois `repoRoot` distintos apontando para o mesmo
  `.agentic` disputam a mesma posse (correto); um `repoRoot` cujo `state.db` foi movido por
  `databasePath` sai da chave (não acontece no uso normal).
