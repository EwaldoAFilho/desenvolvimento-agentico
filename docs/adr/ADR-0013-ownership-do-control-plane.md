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

### Canonicalização não pode falhar aberta

`realpath` é o que faz `/repo` e `/atalho-para-repo` disputarem a mesma posse. Se ele falhar,
a alternativa natural — usar o caminho textual — manteria o boot de pé ao custo de uma chave
que não unifica aliases: trocaria a invariante por disponibilidade, exatamente na função que
existe para sustentar a invariante. Então falhar ali **recusa o boot**
(`OwnershipPathError`). O diretório já foi criado antes da chamada, então o único jeito de
chegar lá é problema real de ambiente — permissão, ciclo de links — e para esse caso recusar
é a resposta certa.

### Espera antes de recusar

A aquisição usa `busy_timeout = 250ms`, não zero. Não é para esperar o dono sair — o dono não
sai. É para atravessar o instante em que dois processos **criam** o arquivo ao mesmo tempo.
Com zero, essa disputa de criação virava recusa: medido em oito processos por doze rodadas,
uma rodada terminou com **zero vencedores** — ninguém subiria, e o projeto pareceria possuído
por um dono que não existe. Com 250ms, doze de doze com exatamente um vencedor.

### Adotar exige posse DECLARADA

Para as demais operacoes a guarda e "nao perdeu a posse"; para `adoptRecoverableRuns()` ela é
"tem a posse". A diferença importa porque a adoção é o único efeito que o control plane
produz sozinho, no boot, sem ninguém pedir — foi o que transformou D4 de risco em dano. Um
plane construído sem lease (comando de leitura, teste) não pode cair nesse caminho por
esquecimento de quem o construiu: ali a ausência de lease é recusa, não permissão.

### Encerrar não devolve o projeto com efeito vivo

A ordem do encerramento é garantia tanto quanto a do boot, e ela vive numa função com nome
(`shutdownControlPlane`), com um teste por regra:

1. Parar de atender vem primeiro, mas **não pode bloquear o resto**: um socket que se recusa
   a fechar não é razão para deixar loop despachando agente. A falha é guardada e relançada
   no fim, para não virar silêncio.
2. Se os **efeitos** não pararem, a posse **não** é devolvida. Entregar o projeto com loop
   andando é o dano de D4 voltando por um caminho de falha; um projeto que continua possuído
   por um processo defeituoso é o mal menor, porque a posse morre junto com o processo.
3. Soltar a posse é o último ato.

### Descobrir não escreve

`discoverControlPlane` deixou de apagar o registro de um processo morto. Parecia limpeza e era
uma corrida: entre ler o registro morto e removê-lo, um control plane novo pode ter publicado
o dele, e não existe *compare-and-delete* atômico em sistema de arquivos que impeça o registro
do vivo de ser o apagado. Quem chama a descoberta é **cliente** — não tem a posse e portanto
não tem como provar que ninguém publicou naquele instante.

O registro velho também não precisa sumir: ele já é ignorado (o pid está morto) e o próximo
dono o sobrescreve ao publicar. Escrever em `control-plane.json` passou a ser exclusividade do
dono, e é isso que torna segura a remoção no encerramento — ali o lock ainda está na mão, e
nenhum outro processo consegue publicar antes de ele ser solto.

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
  `.agentic` disputam a mesma posse (correto). A saída por `databasePath` que este parágrafo
  registrava foi **removida** em 003C: o banco é sempre `<runtimeDir>/state.db`, derivado, e
  não há mais como um `repoRoot` sair da própria chave.

## Correção de 003B — a chave existia, mas não era a mesma para todos

A decisão acima estava certa e implementada pela metade. O lock funcionava; o que faltava
era todo mundo pedir **a mesma chave**. Medido empiricamente, com dois processos e a CLI de
verdade:

- com `project.repoRoot: .` — o caso comum — `<dir do project.yaml>/.agentic` e
  `<repoRoot>/.agentic` são o mesmo diretório, e a divergência ficava invisível;
- com `repoRoot` apontando para fora, `agentic serve` disputava um diretório e
  `agentic mission start` disputava outro. **Dois donos reais para um projeto só**, cada um
  com o seu `state.db`.

E a guarda de mutação lia a **ausência de posse como permissão**: um plane construído sem
lease — `agentic mission approve` pelo caminho local, uma composição esquecida — criava run
e gravava aprovação no projeto de outro processo.

### O que passou a valer

**Uma conta só, em `projectIdentityOf`.** Todo entrypoint mutável passa por ela: `serve`,
`mission start`, `mission approve`, `startServer`, o binário `agentic-server` e a
descoberta. Ela separa três âncoras que estavam confundidas:

| Âncora | O que é | O que resolve contra ela |
| --- | --- | --- |
| `projectDir` | diretório que contém `.agentic/project.yaml` | **configuração**: `repoRoot` e `gates.file`, porque foi contra ele que o humano escreveu os caminhos |
| `repoRoot` | repositório alvo, canonicalizado | **identidade**: é ele que dá nome ao projeto (I14) |
| `runtimeDir` | `<repoRoot>/.agentic` | **estado**: posse, `state.db`, `control-plane.json`, `runs/`, `worktrees/` |

O estado acompanha o **repositório**, não o arquivo de configuração, porque é o repositório
que as worktrees e os branches modificam — `execution.worktreeRoot` já se resolvia assim.
`loadProjectSources` deixou de ignorar `project.repoRoot`, então o servidor standalone chega
à mesma chave que a CLI sem nunca ter visto a CLI.

**Ausência de posse é recusa, nunca permissão.** `createRun`, `approveMission`, `startRun`,
`open` e `adoptRecoverableRuns` exigem lease **declarado e vivo**. Um plane sem lease
continua existindo — ele **lê** —, e é isso que mantém `status`, `report` e `inspect` sem
disputa nenhuma. O que ele não faz é mutar.

**O cliente prova que o endereço é do projeto certo.** `connectHttp` confere o `repoRoot`
do `/api/health` contra o do projeto, por caminho real. Descoberta velha, `.agentic` copiado
junto com o diretório ou porta reaproveitada colocam do outro lado um control plane
**real** — de outro repositório. Sem essa conferência, `approve`, `pause` e `stop` mutariam
o run errado. Não é autenticação, e não pretende ser: é o mínimo que impede um comando de
mutação atravessar de projeto.

### O que a primeira revisão independente cobrou

Três achados, todos legítimos, todos fechados na mesma fatia:

- **A chave não pode ser escolhida pelo chamador.** `startServer` ainda aceitava um
  `runtimeDir`, e depois que esse diretório virou a chave de posse, duas chamadas para o
  mesmo `repoRoot` com diretórios diferentes venciam **duas** posses. A opção foi
  **removida**: o diretório de estado sai de `projectIdentityOf` e de mais lugar nenhum.
  `databasePath` continuou por um tempo como a única saída declarada da chave — e foi
  removido em 003C, junto com o `baseDir` de `createControlPlane`.
- **A prova de identidade tem de viajar com o comando.** Sondar o `/api/health` antes e
  mandar o POST depois deixa uma janela: o dono encerra, outro control plane — de outro
  repositório — reaproveita a porta, e o comando muta o run errado. Agora cada requisição da
  CLI declara o projeto no cabeçalho `x-agentic-repo-root`, e **o servidor** confere contra o
  projeto que possui, respondendo `409 PROJECT_MISMATCH`. Ausência do cabeçalho passa, e isso
  não é o `undefined` permissivo de antes: quem não declara é o dashboard, servido por este
  mesmo control plane, na mesma origem — quem pode errar de endereço é a CLI, e ela declara
  sempre.
- **Um plane sem posse precisa ser somente-leitura de fato.** `plane.createRun` recusava, mas
  `plane.persistence.runs.createRun` chegava ao banco. Sem lease, os quatro caminhos de
  escrita da persistência (`runs.createRun`, `runs.withTransaction`, `events.append`,
  `artifacts.write`) passam a recusar; a leitura fica inteira. Isso **não** é a fatia do modo
  `readonly` da conexão (D9): a conexão continua `readwrite`, e o que muda é a capacidade
  exposta. *Esse era exatamente o defeito de forma que 003C viria fechar — ver abaixo.*

### O que a segunda revisão independente cobrou

Três achados, os três reais, os três fechados:

- **O espelho somente-leitura tinha porta dos fundos.** Ele fechava métodos e deixava passar
  qualquer valor que não fosse função — inclusive a conexão SQLite crua, alcançável por
  `persistence.database`, `runs.db`, `events.db`, `artifacts.db` e `queries.db`. Um SQL
  arbitrário passava sem allowlist e sem evento (I1). As cinco portas passam a exigir posse.
- **A capacidade era decidida na construção e não morria com o lease.** Um plane aberto com
  posse continuava com a persistência inteira depois de `release()` — enquanto outro processo,
  já dono legítimo, escrevia o mesmo banco. A fachada consultava `held` a cada chamada; a
  persistência, não. Agora as duas perguntam a mesma coisa, na mesma hora.
- **O lease não estava amarrado ao projeto que protege.** `OwnershipLease` só dizia
  `instanceId` e `held`, então uma posse legítima de `/repo-A` autorizava um plane aberto
  sobre `/repo-B`. O lease passa a declarar `ownedDir`, e `createControlPlane` recusa a
  construção quando ele não bate com o `baseDir` — por caminho real, como a própria posse.

### Limite que continua declarado

`release()` marca a posse como perdida **antes** de tentar fechar a conexão. Se o `close`
falhasse, este processo já não poderia agir (nenhuma mutação passa com `held: false`), mas o
lock de arquivo continuaria preso até o processo morrer — atrasando o *takeover*, nunca
criando um segundo dono. É o mesmo modelo de sempre: a posse morre com o processo.

## Correção de 003C — a fronteira é a conexão, não o espelho

A revisão de promoção da 003B encontrou quatro furos, e o padrão entre eles importava mais
que qualquer um deles:

1. uma função capturada antes de `lease.release()` continuava escrevendo;
2. a reflexão (`Reflect.get`, descriptor) alcançava capacidade que o acesso normal negava;
3. `createControlPlane` conferia o lease contra o `baseDir` que o **chamador** escolheu, e
   não contra o diretório que o **repositório** determina;
4. `databasePath` movia o `state.db` mutável para fora do diretório que a posse protege.

Os dois primeiros não são bugs independentes: são a mesma coisa dita duas vezes. Uma
fronteira construída **escondendo capacidade** — Proxy, allowlist, trap de propriedade —
perde por construção, porque quem já tem a referência não precisa reencontrá-la. Fechar
*reflection tricks* um a um é uma corrida sem linha de chegada.

### A decisão

**Sem posse não existe conexão capaz de escrever.**

`createControlPlane` abre `readwrite` quando há lease vivo **deste** projeto, e `readonly` em
qualquer outro caso. `readonly` não é convenção: é `better-sqlite3` abrindo o arquivo com
`SQLITE_OPEN_READONLY`, e é o próprio SQLite que recusa `INSERT`, `UPDATE`, `DELETE`,
`CREATE TABLE` e transação de escrita. Não há capacidade escondida para a reflexão encontrar,
porque não há nada escondido — há uma conexão que não sabe escrever.

Três consequências:

- **O lease revoga o escritor.** `ControlPlaneLease.onRelease` amarra o tempo de vida da
  conexão mutável ao da posse, e `release()` fecha os escritores **antes** de soltar o lock do
  arquivo. No instante em que outro processo pode virar dono, o escritor deste já fechou.
  É o que mata a função capturada: não adianta ter a referência quando o banco saiu de baixo
  dela. O método é **obrigatório** no tipo — um lease que não sabe revogar não pode autorizar
  escrita, e o compilador cobra isso de todo produtor de lease, inclusive de dublê de teste.
- **Uma identidade só, derivada.** `baseDir` e `databasePath` saem da API de produção
  (`ControlPlaneConfig`, `OpenPersistenceOptions`, `ServerConfig`). O estado sai de
  `runtimeDirOf(repoRoot)`, que desceu para `@agentic/persistence` porque `@agentic/
  orchestrator` não pode importar um app; `projectIdentityOf` reexporta a **mesma** função.
  Nenhum call site de produção usava `databasePath`: era escape hatch puro.
- **Ler não inicializa projeto.** `readonly` sobre um `state.db` inexistente levanta
  `DatabaseNotInitializedError` em vez de criar o banco — criar e migrar são escritas, e
  escrita pertence a quem possui o projeto. `doctor` distingue *"não inicializado"* (zero
  runs, fato conhecido) de *"não apurado"* (dúvida), para não voltar a exibir a contabilidade
  em memória do processo.

O espelho da 003B (`comPosse`, `persistenciaSobPosse` e as allowlists) foi **removido**: duas
pseudo-fronteiras em conflito são piores que uma real. A fachada mantém `exigirPosse`, agora
por um motivo declarado e diferente — dar a **frase** que explica o que fazer, em vez de
deixar `SQLITE_READONLY` vazar do driver para o usuário.

### Medido, não assumido

WAL era o risco não óbvio: um leitor `readonly` precisa alcançar o `-shm` para achar o
snapshot, e o `-shm` só nasce de uma conexão que escreve. Medido contra um control plane de
verdade em outro processo:

| Estado | `-wal` / `-shm` | Leitura `readonly` |
| --- | --- | --- |
| dono vivo, escrevendo | presentes | passa, vê `journal_mode = wal` |
| dono encerrado (close limpo) | apagados no checkpoint | passa |
| dono encerrado por SIGTERM | costumam sobrar | passa |

Três leitores mantidos abertos durante uma escrita do dono não produziram `SQLITE_BUSY`, não
criaram segundo banco e não disputaram posse.

### O que a revisao independente da 003C cobrou

**Fechado nesta fatia:**

- **`artifacts.write` gravava o arquivo mesmo sem posse.** Era o unico caminho de escrita da
  persistencia com efeito FORA do banco — `mkdir` + `writeFile` primeiro, `INSERT` depois — e
  a guarda perguntava `handle.mode`, que diz como a conexao foi ABERTA e nunca muda quando
  ela fecha. `DatabaseHandle.writable` (`mode === 'readwrite' && db.open`) passa a ser a
  pergunta, e os tres caminhos de escrita a consultam antes de qualquer efeito.
- **Falha ao revogar um escritor soltava o projeto assim mesmo.** O `release` engolia a
  excecao do gancho e fechava o lock em seguida — ou seja, a conexao mutavel podia continuar
  aberta enquanto outro processo assumia. Dois escritores sobre o mesmo `state.db` e o dano
  de D4 voltando por um caminho de falha. Agora, gancho que falha **impede** a liberacao do
  lock e continua registrado para a proxima tentativa, que e o modelo ja declarado aqui:
  atrasar o takeover e o mal menor, e a posse morre com o processo de qualquer jeito.
- **Construcao que falhava vazava a conexao.** `gates.yaml` invalido ou registro de provider
  mal declarado lancavam com o `state.db` ja aberto. A montagem passou a acontecer sob `try`.
- **`plane.access` mentia depois do `release`.** Congelado na construcao, afirmava `owned`
  com a conexao fechada e o projeto possivelmente com outro dono. Virou getter sobre
  `lease.held`.

**NAO fechado — e por que fica fora desta fatia:**

Dois achados sobreviveram, e os dois sao da mesma familia: **efeito assincrono ja em voo
quando a posse e devolvida**. Nenhum deles e alcancado por chamador hostil; os dois vivem no
lifecycle legitimo.

1. **`artifacts.write` iniciado ANTES do `release`.** A guarda viva responde uma vez; depois
   dela ha dois `await` (`mkdir`, `writeFile`). Um `release` no meio nao cancela a operacao
   pendente, e a continuacao ainda grava — possivelmente depois de outro processo assumir.
2. **`Orchestrator.abandon()` nao drena o tick em execucao.** Ele espera o snapshot de
   `#jobs`, mas o tick e serializado a parte, em `#chain`. Um tick que ja passou pela
   checagem de `#closed` pode estar criando worktree ou dentro de `provider.start()` antes de
   se registrar em `#jobs` — entao `plane.close()` retorna, o servidor solta a posse, e o
   tick antigo ainda produz efeito depois do takeover.

Os dois sao **pre-existentes**: `orchestrator.ts` nao foi tocado nesta fatia, e a ordem
`mkdir`/`writeFile` do artefato tambem nao. O que a 003C mudou foi torna-los VISIVEIS, ao
afirmar pela primeira vez que "a capacidade morre com a posse" — uma promessa que a conexao
cumpre e que efeito em voo, worktree e processo de agente ainda nao cumprem.

Fecha-los exige drenar trabalho em voo antes de soltar a posse: barreira de encerramento,
cancelamento cooperativo do tick e revogacao de efeitos fora do banco. Isso e **service
lifecycle**, o assunto declarado da proxima fatia, e nao cabe em "posse na conexao" sem
reabrir o desenho do encerramento inteiro.

**Consequencia honesta:** a fronteira do BANCO e estrutural. A fronteira de MUTACAO como um
todo — arquivo, worktree, processo de agente — ainda depende de disciplina de lifecycle.
Dizer o contrario seria a afirmacao falsa que esta ADR existe para nao fazer.

### Limites que continuam declarados

- O threat model não mudou: **instâncias legítimas do produto**, não código hostil executando
  dentro do processo dono. Quem já roda no processo do dono tem o handle mutável por
  definição, e nenhuma fronteira em JavaScript mudaria isso.
- Depois de `release()`, o plane não lê **nem** escreve — a conexão fechou. É deliberado, e é
  o preço exato da propriedade: ou a conexão morre junto com a posse, ou a capacidade
  sobrevive a ela. Não custa nada em produção, onde a ordem já era essa (`withPlane` fecha no
  `finally` antes do `release`; `shutdownControlPlane` para os efeitos antes de devolver o
  projeto). Quem quiser ler depois abre um plane de leitura — o que é mais honesto, porque a
  essa altura o dono do banco pode ser outro processo.
