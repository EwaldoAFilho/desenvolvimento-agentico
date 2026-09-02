# ADR-0014 — Ciclo de vida do serviço: nenhum efeito sobrevive à posse (I15)

**Status:** Aceita · **Data:** 2026-09-02

## Contexto

ADR-0013 fez da posse do projeto uma propriedade estrutural: sem lease vivo não existe
conexão capaz de escrever, e `release()` fecha o escritor antes de soltar o lock. A revisão
que a promoveu encontrou dois efeitos que essa fronteira não alcança, e o padrão entre eles
importa mais que qualquer um: **efeito assíncrono já em voo quando a posse é devolvida.**

Medido, em código de produção e sem agente real:

| Efeito em voo no `close` | O que acontecia |
| --- | --- |
| tick do orquestrador dentro de `provider.start()` | `plane.close()` resolvia **antes** da cadeia; o tick continuava, registrava o handle e disparava `#afterExecutor` sobre um banco já fechado — erro engolido, posse já devolvida |
| processo de agente nascido nessa janela | `abandon()` só cancela handles que **já existiam**; o que `start()` devolvia depois ficava vivo, com neto e tudo, até o timeout da tentativa |
| mission gate (comando de 3s) | `close` **esperava** o comando terminar em vez de cancelá-lo — um gate de dez minutos seguraria o encerramento por dez minutos, e o resultado era descartado de qualquer forma |
| escrita de artefato entre `mkdir` e `writeFile` | `lease.release()` devolvia o projeto com o `writeFile` pendente; o segundo dono entrava; a linha do banco nunca era gravada |
| um cliente SSE conectado | `app.close()` do Fastify **não resolvia** — o `Stop` da extensão ficaria pendurado exatamente no caso comum, com a tela aberta |
| integração (rebase em voo) | o merge terminava na branch da missão e a task ficava `INTEGRATING` para sempre; o próximo dono reconciliava como `INTERRUPTED` e refazia trabalho já integrado (D6) |

Nenhum deles é alcançado por chamador hostil. Todos vivem no encerramento legítimo — o
Ctrl+C, o `Stop` e o `Restart` que a extensão vai chamar.

## Decisão

**I15 — Antes de um Control Plane Owner devolver a posse, nenhum efeito operacional
iniciado por ele permanece capaz de mutar o projeto.** Banco, arquivo de artefato, worktree,
branch e processo filho. "Capaz de mutar" é a formulação exata: um processo já morto e um
`await` já resolvido não contam; um processo vivo e um `writeFile` pendente contam.

A invariante é sustentada por **uma ordem com nome** (`shutdownControlPlane`), a mesma para
todo caminho de saída — `agentic serve` sob `SIGINT`/`SIGTERM`, `mission start` em primeiro
plano, `agentic-server` e o `stop()` do serviço:

```text
1. PARAR DE ACEITAR   plane.quiesce() ANTES de o servidor parar: open/createRun/approve/start/
                      adopt recusam, inclusive para a requisicao HTTP que ainda esta em voo;
                      depois streams SSE encerrados, porta fechada, descoberta removida
2. CANCELAR/DRENAR    por orquestrador: timer desligado, ticks recusados, despacho barrado;
                      handles de agente cancelados (tree-kill); gate e workspaceSetup abortados
                      por AbortSignal; a CADEIA do tick e TODOS os jobs esperados — inclusive
                      os registrados depois do retrato inicial — com prazo
3. COLHER             integração e mission gate que terminaram durante a espera são gravados,
                      uma mensagem por vez e SEM engolir falha: transação que falha mantém a
                      mensagem na caixa e faz o close rejeitar (posse retida; o próximo close
                      grava). O run só é DERIVADO se já estava em VERIFYING — nunca sobe de
                      RUNNING a VERIFYING aqui, porque o mission gate não iniciaria (I12)
4. FECHAR             escritas de artefato em voo terminam (settle); só então o banco fecha
5. DEVOLVER           lease.release() — e ele devolve `false` se algum escritor recusou fechar
```

Se o passo 2 vence o prazo com efeito vivo, `close` **rejeita** (`ShutdownTimeoutError`), o
banco fica aberto e a posse **não** é devolvida. Um projeto que continua possuído por um
processo que ainda está terminando é o mal menor: a posse morre com o processo de qualquer
jeito, e entregar o projeto com efeito vivo é o dano de D4 voltando por um caminho de falha.
Um `close` seguinte tenta de novo.

E **o processo não sai** nesse caso — nem `agentic serve`, nem `agentic-server`, nem
`mission start`. Sair soltaria o lock pelo sistema operacional com o efeito vivo, que é
exatamente o que a regra proíbe. Os três dizem o que houve e esperam o **próximo sinal**, que
tenta o `stop` de novo. `kill -9` continua sendo a saída de quem sabe o que faz.

Os sinais são assinados **antes** do boot, não depois: a adoção dos runs recuperáveis já
despacha agente, e um `SIGTERM` nessa janela caía no tratador padrão do Node. Um sinal que
chega durante o boot é atendido logo depois dele, pelo mesmo `stop`.

### O que é cancelado, o que é esperado, o que é colhido

| Efeito | Cancelável? | Decisão |
| --- | --- | --- |
| processo de agente (executor, revisor) | sim, pelo handle | cancelado na hora; resultado descartado; a tentativa fica `RUNNING`/`REVIEW` para o próximo dono reconciliar como `INTERRUPTED`. A unidade do efeito é o **grupo de processos**: quando o líder assenta — cancelado, por timeout ou saindo sozinho — o resto do grupo recebe SIGKILL. Um daemon que um agente ou um comando de setup deixe para trás não sobrevive ao processo que o criou (medido em revisão, nas duas formas) |
| processo de agente nascido **durante** o encerramento | sim | `#dispatchExecutor`/`#dispatchReviewer` cancelam o handle assim que `start()` devolve, e não observam |
| gate de task, mission gate, `workspaceSetup` | sim, por `AbortSignal` (SIGTERM, depois SIGKILL) | cancelado; gate cancelado **não vira resultado** — o próximo dono refaz (I12, ao menos uma vez) |
| integração (`git rebase` + fast-forward) | não | esperada (segundos); o resultado é **colhido** e gravado: a task vira `DONE` antes de a posse sair |
| `worktree add` em curso | não | esperada; se o encerramento chegou entre o `acquire` e a gravação da tentativa, a worktree é descartada e a task continua `READY` |
| escrita de artefato | não | esperada (`settle`); `release()` recusa enquanto houver uma em voo |
| escrita no `state.db` | atômica | nunca fica pela metade |
| tick em execução | cooperativo | verifica `#closed` entre as fases e antes de cada decisão de despacho |

Os desfechos de agente, gate de task e revisão que chegam durante a espera são
**descartados de propósito**: registrá-los levaria ao passo seguinte — gate, revisão,
integração — que é trabalho novo. Integração e mission gate são colhidos porque registrá-los
não cria efeito: o merge já está na branch, a medição já foi feita sobre um commit.

### O serviço

`createControlPlaneService` dá ao processo uma máquina de estados com nome — a que a CLI usa
hoje e a extensão do editor vai chamar:

```text
STOPPED ──start()──▶ STARTING ──ok──▶ RUNNING ──stop()──▶ STOPPING ──ok──▶ STOPPED
                        │ falha                              │ falha
                        ▼                                    ▼
                     STOPPED (nada ficou de pé)           FAILED (efeito vivo, posse retida)
```

- `start()` é idempotente: em `RUNNING` devolve o estado e **nunca** cria um segundo dono;
  chamadas concorrentes compartilham a mesma partida. Quando outro processo possui o
  projeto, rejeita com o dono no motivo e volta a `STOPPED`.
- `stop()` é idempotente: em `STOPPED` devolve o estado; chamadas concorrentes compartilham
  o mesmo encerramento. Só `FAILED` exige ação — `stop()` de novo tenta outra vez, e
  `start()` recusa enquanto isso.
- `restart()` é `stop` e depois `start`, serializados: a posse é devolvida **de fato** antes
  de o novo dono disputá-la, e o novo dono adota os runs recuperáveis.
- `status()` não muta. Não é um `RunStatus`: o run vive no banco e sobrevive ao processo;
  isto descreve o processo.

### D12, fechado aqui

O resultado do mission gate vivia só em memória. Um control plane que caísse entre gravar a
`GateExecution` e concluir o run — duas transações do mesmo tick — refazia o gate no próximo
dono e gravava uma segunda execução. A janela era estreita e passou a ser comum: o
encerramento gracioso colhe o resultado do mission gate e devolve o projeto; o próximo dono
**precisa** encontrá-lo. `#derive` agora lê `run.missionGateExecutionId` do banco antes de
decidir iniciar o gate. É a segunda metade de I12, que só estava escrita.

## Alternativas

- **`forceCloseConnections: true` no Fastify.** Resolve o SSE derrubando toda conexão,
  inclusive um `POST /api/runs` em voo. Rejeitado: parar de atender não é cortar quem já
  está sendo atendido. Os streams são encerrados explicitamente, antes de `app.close()`,
  porque o Fastify fecha o socket do servidor **antes** dos ganchos `onClose` registrados na
  montagem (ordem LIFO) — medido.
- **Assinar o sinal só quando o run pausa (`mission start`).** Era o desenho anterior, e a
  revisão o mediu como blocker: com agente, gate ou `workspaceSetup` em voo não havia
  tratador, o Node matava o processo, o SO soltava a posse e o efeito continuava. O
  supervisor de primeiro plano assina desde o início e corre o sinal contra o `drain`.
- **Esperar os agentes terminarem naturalmente antes de cancelar.** Tentativas não são
  retomadas depois de um reinício (STATE-MACHINES 1.4); esperar minutos por um resultado
  que será descartado só atrasa o `Stop`. Cancelar na hora é honesto.
- **Cancelar a integração também.** Um rebase pela metade é pior que um rebase inteiro, e
  ele leva segundos. Esperada, com prazo.
- **Registrar tudo o que chegou durante a espera.** Reconciliaria na saída o que o próximo
  dono reconcilia na entrada, ao custo de iniciar gates e revisões durante o encerramento.
  A regra "nenhum efeito novo" é mais simples de provar.
- **Reconciliar as tentativas descartadas na saída (`INTERRUPTED` na hora).** Deixaria o
  disco mais limpo, mas mudaria a semântica que o `SIGKILL` obriga a manter de qualquer
  forma: quem adota reconcilia. Uma regra só.
- **Devolver a posse no timeout, com aviso.** É exatamente o que I15 proíbe.

## Consequências

- **I15** entra na tabela de invariantes. I14 passa a valer também no encerramento: "no
  máximo um dono" inclui o instante em que a posse troca de mãos.
- `ControlPlaneLease.release()` devolve `boolean`. `false` = escritor recusou fechar, lock
  retido, chame de novo. `shutdownControlPlane` converte `false` em `OwnershipRetainedError`.
- `Persistence.close()` recusa com escrita de artefato em voo (`WritesInFlightError`);
  `Persistence.settle()` espera. `ControlPlane.close(options)` faz o `settle` antes de fechar
  e expõe `lifecycle: 'open' | 'closing' | 'closed'`.
- `Orchestrator.abandon({ graceMs })` drena de verdade. `DEFAULT_SHUTDOWN_GRACE_MS = 30 s`:
  processos recebem `SIGTERM` e `SIGKILL` em 2 s + 2 s; git leva segundos; o resto é margem.
- `RunSpec.signal`, `GateRunRequest.signal`, `AttemptLease.signal` e
  `MissionWorkspaceRequest.signal` levam o cancelamento cooperativo até o processo.
- Ticks disparados por evento ou timer registram a própria rejeição em `errors` em vez de
  virar `unhandledRejection` — um `#load` sobre banco fechado derrubava o processo inteiro.
- `agentic serve`, `agentic-server` e `mission start` encerram pela mesma primitiva. Um
  encerramento que não devolve a posse termina o comando com `SHUTDOWN_INCOMPLETE`, dizendo
  isso — o processo sai em seguida e o sistema operacional solta o lock.

### Limites declarados

- **Windows.** O tree-kill do runtime de processo usa `taskkill /T`, mas o abort de
  `workspaceSetup` (shell) mata só o processo do shell (`child.kill('SIGKILL')`), não a
  árvore, e o SIGKILL ao grupo remanescente é POSIX. Windows não está na suíte; fica
  registrado, não resolvido.
- **`SIGKILL` não drena.** A posse morre com o processo (ADR-0013), o próximo dono adota e
  reconcilia. Mas um comando de gate ou de `workspaceSetup` que o processo morto havia
  iniciado fica **órfão até terminar sozinho**: ele não alcança o banco (a conexão morreu com
  o dono) e a worktree da missão é reivindicada pelo próximo dono pela prova de posse
  (`mission-owner`), mas ele existe. Medido: o gate órfão de A termina por conta própria
  enquanto B já refaz o gate. Encerramento gracioso é o caminho normal; `SIGKILL` é queda.
- **Um segundo Ctrl+C durante o encerramento** tenta o encerramento de novo (o tratador é
  reinstalado a cada espera). Derrubar à força é `kill -9`, e cai no caso acima.
- **Descendente que trocou de sessão** (`setsid`) saiu do grupo de processos e do alcance
  do SIGKILL ao grupo. Não há sessão nova por desenho nos comandos do produto; um agente que
  o faça está fora do que o produto controla.
- **Ameaça continua sendo instância legítima**, não código hostil no mesmo processo.
