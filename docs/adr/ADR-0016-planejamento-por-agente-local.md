# ADR-0013 — Planejamento de missão como porta própria do domínio

**Status:** Aceita · **Data:** 2026-08-31

## Contexto

A jornada `cd projeto && agentic` pede que uma missão **nasça de texto livre**: o
desenvolvedor descreve o que quer, um agente propõe o plano, o humano revisa o DAG e aprova.
Isso coloca um agente antes da missão existir — e é aí que o desenho atual não serve.

A porta que temos, `AgentProvider`, recebe `Assignment`. `Assignment` exige `taskId`,
`attemptId` e `workspacePath`, porque foi desenhada para o que ela de fato faz: executar uma
tentativa de uma task dentro de uma worktree arrendada. Nenhum desses três existe antes do
plano existir. Os invariantes que os sustentam também não se aplicam: **I8** (nenhuma task em
`RUNNING` sem workspace lease) e **I11** (`cwd` na worktree da tentativa) falam de tentativa,
e planejar não é tentativa.

O segundo problema é a saída. `AgentOutcome` devolve `claims`, e `claims` é — deliberadamente
— relato: não decide transição e não basta para `DONE` (P05). Um plano não é relato, é o
artefato. Pior: o adapter trunca `claims.detail` em 8000 caracteres
(`MAX_CLAIM_DETAIL_CHARS`). Um plano de 17 tasks passa disso com folga, e o corte seria
silencioso — o control plane receberia meio plano que ainda assim parece um plano.

Há ainda um problema menor de mesmo tipo, na outra ponta: os **cinco estados de fornecedor**
(`READY`, `NOT_READY`, `INSTALLED`, `NOT_INSTALLED`, `UNKNOWN`) só existiam em
`apps/cli`. O dashboard, que só pode importar `@agentic/schemas` (ADR-0001), teria de
recriá-los para não pintar de verde um fornecedor cuja prontidão nunca foi apurada.

## Decisão

**Uma porta nova no domínio: `MissionPlanner`.** Separada de `AgentProvider`, com quatro
consequências normativas.

**1. Planejar não pede contexto de execução.**

```ts
interface MissionPlanner {
  readonly id: ProviderId
  capabilities(): PlanningCapabilities
  plan(request: PlanningRequest): Promise<PlanningResult>
}
```

`PlanningRequest` carrega o pedido em linguagem natural, um limite de tempo e um
`PlanningContext` com o que o planejador precisa para propor algo que compile: a raiz que
pode **ler**, os ids de missão já ocupados, os gates que o projeto declara, as restrições e os
`denyPaths`. Não há `taskId`, `attemptId` nem `workspacePath`. `readRoot` não é workspace:
não tem lease, branch nem commit base, e o processo não recebe permissão de escrita.

**2. A proposta é dado, não arquivo.** `MissionProposal` carrega um `MissionSpec` validado —
não um documento, não um caminho. Quem serializa e grava o `.mission.yaml` é o control plane.
O contrato da proposta (`MissionPlanSchema`) é o do arquivo de missão **menos `apiVersion` e
`kind`**: um planejador que pudesse declarar a versão do formato escolheria o contrato contra
o qual seria julgado, e a validação viraria teatro. Esses dois campos entram em
`missionFileFromPlan`, do nosso lado.

Como a proposta não passa por `claims`, também não passa pelo truncamento em 8000 caracteres.

**3. Reparo é curto e para quando deixa de andar.** `PlanRevision` devolve ao planejador o
que ele produziu e os problemas encontrados; `MAX_PLAN_REVISIONS = 2` limita o ciclo, e
`canonicalMissionPlan` dá a forma canônica que permite detectar que a "correção" repetiu a
proposta anterior. Esgotado o crédito, a decisão volta ao humano (P15) com
`PlanningFailure` — código, frase legível e onde o plano feriu o contrato. Falha de
planejamento é diagnóstico, nunca plano parcial: meia missão compila e engana.

**4. A porta não tem afordância para aprovar, executar ou escrever.** `MissionPlanner` expõe
`id`, `capabilities` e `plan`. Não há método que altere política, gate ou código, e
`PlanningCapabilities.simulated` obriga cada planejador a declarar se é simulado — é o que
impede um planejador de fixture de ser oferecido como planejamento de verdade, e o que
permite avisar o consumo de assinatura **antes** de acionar o que é real (P17).

**Junto:** `PROVIDER_STATES` e `providerStateOf` passam a morar em `@agentic/schemas`, o
único pacote que terminal e navegador compartilham. A CLI reexporta os nomes que já publicava.

P17 e P18 seguem intactos: o planejador é CLI local já autenticada, nenhuma credencial é
lida, guardada ou injetada, e `ProviderId` continua sendo string opaca de configuração.

## Alternativas

- **Um terceiro `kind` em `Assignment` (`'plan'`).** O caminho mais curto, e o que mais
  estraga: obrigaria a inventar uma task, uma tentativa e um arrendamento de worktree para
  algo que não tem nenhum dos três. I8 e I11 passariam a valer "menos quando `kind` for
  `plan`" — invariante com exceção não é invariante, é convenção. E a saída continuaria
  descendo por `claims`, truncada.
- **Deixar o agente gravar o arquivo da missão.** Elimina uma tradução, e quebra P04 e P09
  de uma vez: `.agentic/` está em `denyPaths` justamente para que agente não escreva
  política. Também devolveria ao agente a escolha de `apiVersion` e do caminho do artefato.
- **Um formato de plano próprio, mais frouxo que o da missão.** Dois formatos quase iguais
  envelhecem em direções diferentes. Pior: o mais frouxo aceitaria proposta que não compila,
  empurrando a falha para o compilador — mais tarde, e mais difícil de explicar.
- **Planejamento só na camada de aplicação, sem porta no domínio.** O adapter viveria em
  `providers`, que precisaria conhecer `orchestrator` para achar o contrato — inversão da
  regra de dependência (ADR-0001), verificada por lint.
- **Recriar os cinco estados de fornecedor no dashboard.** Duas derivações com a mesma
  intenção divergem; a divergência aparece como fornecedor verde de um lado e amarelo do
  outro, e o modo de falha é o que o produto mais recusa: afirmar prontidão não apurada.
- **Afrouxar `scripts/boundaries.config.mjs` para o dashboard importar o domínio.** Resolveria
  o sintoma destruindo a fronteira que ADR-0001 estabelece — e a missão veda explicitamente.

## Consequências

+ Planejar deixa de depender de task, tentativa e worktree; I8 e I11 continuam sem exceção.
+ O plano viaja como saída estruturada e validada, sem o truncamento de `claims`.
+ O arquivo da missão é montado e gravado pelo control plane, com a versão do formato vinda
  de nós — o agente propõe conteúdo, nunca formato.
+ Terminal e dashboard passam a derivar estado de fornecedor do mesmo lugar.
+ Adapter de planejamento entra pela porta, sem tocar domínio; um planejador por API, se um
  dia existir, entra igual e continua opcional (ADR-0009).
− Uma porta a mais para manter, com sua própria suíte de contrato.
− `MissionSpec` passa a ter dois produtores: o compilador, a partir de arquivo escrito por
  humano, e o planejador. O segundo é sempre validado pelo mesmo contrato do primeiro, mas a
  simetria precisa ser preservada de propósito a cada mudança de formato.
− A detecção de plano repetido é sintática sobre a forma canônica: um planejador que reescreve
  o mesmo plano trocando palavras não é detectado, e gasta uma das duas correções.
