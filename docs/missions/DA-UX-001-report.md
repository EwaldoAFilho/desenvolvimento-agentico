# DA-UX-001 — relatório final

> Escrito pelo supervisor, não por agente. Contém o que foi **medido**, e diz explicitamente
> onde a evidência não existe.

## A. VEREDITO

```text
PARTIAL
```

Não `COMPLETED`: a missão executada foi uma **espinha reduzida de 8 tasks**, decidida pelo
supervisor no meio do caminho. O plano completo, de 17 tasks, está no commit `8dbbc25` e
continua válido. E das 8, apenas 3 fecharam pelo ciclo do produto.

Não `BLOCKED`: as 8 estão resolvidas e integradas, com `build` e `verify` verdes.

## B. O QUE FOI ENTREGUE

| Task | Como fechou | Entrega |
| --- | --- | --- |
| U01 | **DONE** (1ª tentativa) | porta de planejamento no domínio, contrato da proposta, DTOs da Home, ADR-0016 |
| U02 | SKIPPED após correção | launcher `agentic` sem argumento, com abertura de navegador e uso headless |
| U04 | SKIPPED após correção | `GET /api/project`, listagem de missões enriquecida, rota de rascunho |
| U05 | SKIPPED após correção | planejador local implementando a porta |
| U06 | SKIPPED após correção | planejamento no control plane, gravação do arquivo, ciclo de reparo |
| U08 | **DONE** (2ª tentativa) | Home do projeto, fim do carregamento infinito, tela de erro com retry |
| U10 | **DONE** (2ª tentativa) | nova missão por linguagem natural |
| U16 | SKIPPED após correção | revisão do plano, inspeção de nó, aprovação vinculada ao plano inspecionado |

`SKIPPED` aqui significa: a task bloqueou, o supervisor corrigiu sobre o trabalho da última
tentativa, o Codex revisou de forma independente, e o resultado foi integrado. O `skip` foi
usado para registrar no control plane que o trabalho saiu do laço do agente — nunca para
fingir conclusão.

## C. O QUE FICOU DE FORA

Adiado por decisão do supervisor, declarado em `outOfScope` do próprio arquivo da missão:

- onboarding de projeto não configurado (U03, U07, U09) — detecção de stack e gates sugeridos
- guarda contra fornecedor de teste virar revisor real, e template do `init` (U12)
- regressões de launcher e partida limpa (U13)
- **aceitação em navegador dos cenários A–E (U11)**
- quickstart, README e matriz de prontidão (U14, U15)
- **smoke de planejamento com fornecedor real (U17)**

As duas em negrito importam para o veredito: **a jornada nova nunca foi exercitada num
navegador de verdade, e o planejador nunca foi acionado por uma CLI real.** Tudo que existe
sobre eles é teste com CLI falsa.

## D. VEREDITO DE PRODUTO

```text
NÃO É ZERO_FRICTION_READY
```

O critério do brief era: `cd projeto && agentic` → browser → nova missão → DAG, sem CLI
avançado. As peças existem e estão integradas, mas **a jornada não foi percorrida ponta a
ponta por um humano nem por um teste de navegador**. Sem isso, afirmar prontidão seria
exatamente o que o produto proíbe: relato sem medição.

## E. GATES

Medidos na branch `mission/DA-UX-001`, commit `96f04f7`, com Node v24.18.1:

| Gate | Resultado |
| --- | --- |
| `npm run build` | PASS |
| `npm run verify` | PASS — 189 arquivos, 2.516 testes (baseline: 167 / 2.095) |
| `npm run test:e2e` | PASS — 52 passed, 4 skipped (smoke real, opt-in) |
| `npm run test:browser` | **não executado** — U11 não entrou nesta rodada |

O Mission Gate **não fechou pelo produto**: ver §J.

## F. DEFEITOS DE PRODUTO ENCONTRADOS POR DOGFOODING

Cinco, todos só visíveis usando a ferramenta a sério. Três foram corrigidos nesta branch.

### F1 — worktree de tentativa não parecia instalação (corrigido, `932636c`)

`productWebDist()` sobe no máximo 6 níveis procurando `apps/web/dist`. Numa worktree esse
caminho não existe (`dist/` é gitignored), então `web-dist.test.ts` reprovava o gate `unit`
de **qualquer** task.

O que torna grave é como apareceu: U01 falhou e U02 **passou no mesmo gate**, porque o agente
de U02 rodou um build durante a tentativa e criou o `dist` por acaso (worktree 13:53, dist
14:12). O resultado do gate estava dependendo de sorte, não de fato medido.

### F2 — livelock ao reiniciar missão (não corrigido)

Cancelar um run e iniciar outro para a mesma missão colide nos nomes de branch de task.
`git worktree add` falha com exit 255 e o orquestrador **tenta de novo uma vez por segundo,
para sempre**: 3.053 eventos `policy.invalid_transition`, nenhum despacho, e a task nunca
escala para `BLOCKED`. É o antipadrão "retry infinito" que o próprio método lista, e infla o
event log sem limite. Contornado à mão renomeando branches e limpando worktrees.

### F3 — commit de tentativa perdia os arquivos criados (corrigido, `443e335`)

O staging usava `git add -A -- <touches> :(exclude)<link>`. Nas worktrees deste repositório
esse comando estagia **zero arquivo novo e sai 0**, enquanto `git ls-files --others` com os
mesmos pathspecs lista o arquivo — que é exatamente o que `matchingSpecs` consulta.

Efeito medido: o commit `0b7e797` de U02/a1 ficou com 5 arquivos e 240 linhas, quando a
tentativa havia produzido 12 arquivos e 1.447 linhas. O `program.ts` **dentro do commit**
importava quatro módulos ausentes dele. O gate rodou na árvore suja e registrou **PASS com
2.173 testes**. Checkout limpo daquele commit não compila.

Ou seja: evidência `PASS` atribuída a um artefato que não constrói — contradizendo a frase
que sustenta o produto. Quem pegou foi o revisor Codex; nenhum gate pegaria.

**Limitação admitida:** o mecanismo no git não foi isolado, e os testes que acompanham a
correção **não reproduzem** o defeito. Repositório comum, worktree vinculada, link real e
symlink, pathspec literal e de diretório: em nenhum deles o `:(exclude)` suprime o arquivo
novo. Os testes fixam a invariante correta e o comentário do arquivo diz, com todas as
letras, que não são regressão deste bug.

### F4 — gate reprova por contenção de máquina (não corrigido)

U04/a1 reprovou o gate em `RunDashboard.live.test.tsx` por timeout de 5s. U04 toca apenas
`apps/server`. Load average 18,42 em 16 CPUs, com uma VM QEMU a 93%. Com `maxParallelTasks:
5`, cada gate roda a suíte inteira na sua worktree somada aos CLIs dos agentes: o produto
satura a máquina e depois julga o trabalho com cronômetro. Uma tentativa perdida por
saturação, não por defeito.

### F5 — run reaberto não reexecuta o Mission Gate (não corrigido)

Ver §J.

## G. CORREÇÃO À DOCUMENTAÇÃO EXISTENTE

`docs/product/PRODUCT-READINESS.md:27` declara Codex `BLOCKED_BY_ENVIRONMENT`, "quota
esgotada até 05/09". Observado em 2026-08-31: `codex exec` responde normalmente, e a revisão
cruzada real funcionou em **todas** as tasks desta missão. A matriz está desatualizada.

## H. REVISÃO CRUZADA REAL

Primeira missão do projeto com revisão cruzada real funcionando em toda task de risco alto:
executor `claude-code`, revisor `codex`, política `cross-provider-required satisfied`.

O que ela pegou, e que nenhum gate pegaria:

- **U02** — launcher reaproveitava qualquer servidor na porta sem conferir `repoRoot`, fazendo
  `agentic` operar o control plane de outro projeto. É a regressão que a §36 do brief mandou
  travar por já ter mordido antes.
- **U01** — contrato de planejamento aceitava `run` em qualquer estado, inclusive `APPROVED`,
  e `report` com `ok: false`: uma "proposta" poderia ser um rascunho já aprovado. Também
  redescobriu, de forma independente, o vazamento de caminho absoluto do host que o
  mapeamento inicial havia encontrado.
- **U05** — a proteção de leitura do planejador era blacklist por igualdade; `--sandbox=workspace-write`
  escapava e o processo recebia raiz gravável.
- **U16** — aprovação julgada por `missionId` ignorando a versão do plano: um run aprovado
  antigo fazia um YAML novo nascer aprovado.

## I. INTERVENÇÕES MANUAIS

Cinco tasks exigiram intervenção do supervisor. Em **três** delas o revisor independente
achou defeito **na minha correção** — e em duas dessas eu havia afirmado que estava pronto.

| # | Onde | Por quê | Rodadas de revisão |
| --- | --- | --- | --- |
| 1 | `.agentic/project.yaml` | linkar `apps/web/dist` na worktree (F1) | — |
| 2 | `packages/workspace/src/ops.ts` | staging perdia arquivos novos (F3) | — |
| 3 | U02 · launcher | dois achados reincidentes | 2 — reprovou a 1ª |
| 4 | U04 · idempotência do rascunho | TOCTOU | 1 — PASS |
| 5 | U05 · planejador | três achados | 4 — reprovou as 2 primeiras |
| 6 | U06 · impressão digital | observava estado, não conteúdo | **11** — reprovou seis versões |
| 7 | U16 · aprovação | três achados de autoridade | 3 — reprovou as 2 primeiras |

Erros meus que a revisão expôs:

- **U02**: consultei `/health`, mas `httpLink.send` não prefixa `/api`. Nenhuma instância
  legítima seria reaproveitada. Meu teste passou porque o stub respondia a qualquer path.
- **U05**: colei fragmentos sem separador — o revisor mostrou que isso **conserta lixo**
  (`tr` + `ue` vira `true`), fazendo passar plano que o planejador não produziu. Depois usei
  o tamanho da linha como prova de fragmento; ele mostrou que uma linha real do tamanho do
  teto cai no mesmo buraco. Abandonei a remontagem e passei a recusar.
- **U16**: corrigi só um dos dois fluxos de aprovação; e declarei corrigido um ponto cuja
  edição **não chegou a aplicar** (replace silencioso, sem verificação). O revisor reapontou.

Também tentei importar `@agentic/process` de dentro de `packages/providers` e **o lint de
fronteiras me reprovou**, corretamente — a mesma regra que a missão proíbe afrouxar,
funcionando contra o supervisor exatamente como funcionaria contra um agente.

## J. O MISSION GATE NÃO FECHOU PELO PRODUTO

Depois do `skip` de U16, o run emitiu `run.resumed` e `run.verifying` às 11:16:49 e **parou
ali**: 32 minutos sem nenhum evento, sem worktree de mission gate criada, com o control plane
vivo (16h de uptime).

Diagnóstico: o run havia ido a `BLOCKED`, que é terminal. O `skip` reabriu o estado, mas nada
reanexou o orquestrador para executar o gate da missão. É o defeito F5, e por decisão do
supervisor **não foi corrigido** — a instrução era finalizar, não ampliar escopo.

Os comandos do gate foram então executados **diretamente**, fora do produto. Isso é medição
honesta, mas é preciso dizer o que ela não é: **o Mission Gate do produto não registrou
PASS**. O run permanece em `VERIFYING`.

## K. LIÇÕES SOBRE O PRÓPRIO MÉTODO

**Decomposição com `touches` de arquivo é armadilha.** A auditoria prévia salvou onze tasks
disso, e ainda assim três (U02, U05, U16) bloquearam pedindo mudanças **fora do escopo que eu
mesmo dei a elas**. O revisor cobrava, com razão, o que a task era proibida de fazer. Não é
falha dos executores.

**Task grande demais morre no relógio, não no gate.** U06 estourou o timeout duas vezes; a
segunda tentativa tinha 2.207 linhas quase prontas, descartadas. O `patch.diff` é preservado
— evidência não se perde — mas a tentativa seguinte recomeça do zero.

**Laço de revisão adversarial não tem regra de parada.** As onze rodadas de U06 foram todas
legítimas nas primeiras quatro; da quinta em diante cada achado exigia um planejador
adversarial. Parei por julgamento, registrando o limite residual no código. **O método não
tem mecanismo para "revisor e executor discordam sobre o modelo de ameaça, escale para o
humano"** — e deveria ter.

**A revisão independente vale para o supervisor também.** Sem ela eu teria integrado um
launcher que nunca reaproveita plane, um planejador que aceita plano corrompido, e uma
verificação de integridade que falha em silêncio.

## L. RECOMENDAÇÃO

Não promover para `main` ainda. Antes:

1. corrigir F2 e F5 (livelock e run reaberto sem executor) — são de infraestrutura e afetam
   qualquer missão futura;
2. executar U11 e U17 — sem eles não há evidência de navegador nem de planejador real, e o
   veredito de produto não pode subir;
3. rodar U12/U13 antes de qualquer release, pela lição do fornecedor de teste como revisor;
4. atualizar `PRODUCT-READINESS.md` quanto ao Codex.

Não recomendo `v0.1.0-rc.2` nesta branch: `test:browser` não foi executado e a jornada
principal não foi percorrida.
