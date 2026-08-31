# DA-PRODUCT-001 — relatório final

> Product Readiness, UX Real e Operação Diária.
> Números observados pelo control plane, não relatados por agente.

## Veredito

**Missão: `COMPLETED`** · **Produto: `READY_FOR_DAILY_LOCAL_USE`**
(`DUAL_PROVIDER_VALIDATION: PENDING_ENVIRONMENT`)

## Baseline × final

| | Baseline | Final |
| --- | --- | --- |
| Testes unitários/integração | 1.940 | **2.095** |
| E2E | 52 | 52 |
| Navegador real | **0** | **10** |
| Build / verify / e2e | PASS | PASS |
| Execução real com fornecedor | 0 tentativas nesta missão | 8 tentativas |

O baseline **falhou** na primeira execução, com 262 testes vermelhos. Não era regressão: o
reboot trocou o Node de 24 para 20 e o módulo nativo `better-sqlite3` estava compilado para
outra ABI. O `doctor` do produto diagnosticou na primeira linha da saída, e reportou
`unknown` para agentes em voo em vez de inventar número. Isso virou a task P06.

## Promoção para a linha principal

Histórico linear: toda branch de missão era ancestral de `mission/DA-CORE-002`, e `main`
também. Zero commit exclusivo em risco. Promovido por **fast-forward**, preservando os 29
commits com granularidade por task — sem squash e sem fabricar um merge que não aconteceu.
Branches mantidas como marcadores.

## DAG final

```
P01 ✔ baseline + promoção
 ├── P02 ✔ infra de navegador ──┐
 ├── P04 ✔ explicabilidade ─────┼── P03 ✔ aceitação em navegador ──┐
 ├── P05 ✔ pause/resume ────────┼── P07 ✔ documentação ────────────┼── P08 ✔ run real
 └── P06 ✔ partida limpa ───────┘                                  └── P09 ✔ aceitação
```

9 tasks, 5 waves, caminho crítico 22, **zero conflito de touches**.
Compilado pelo próprio produto: 0 ERROR, 0 WARNING, 1 INFO entendido.

O compilador **reprovou este plano três vezes** antes de aceitar: duas por `DA1008`
(declarar escrita em `.agentic/`, protegido por `denyPaths`; depois por não declarar escopo
algum) e uma por `DA2006`, apontando P02 como trabalho órfão — a dependência de P09 para P02
era real e eu tinha esquecido de declará-la.

## Aceitação em navegador

Dez specs em Chromium real, contra servidor Fastify, SQLite, SSE, scheduler, worktrees de
git e gates reais. A única substituição é o provider, guardada por `assertZeroQuota`.

| Cenário | Estado |
| --- | --- |
| jornada principal | `PASS` |
| START MISSION: clique único, duplo não cria dois runs | `PASS` |
| tempo real sem refetch | `PASS` |
| viewport e seleção estáveis sob rajada | `PASS` |
| refresh durante o run | `PASS` |
| console limpo | `PASS` |
| 1366×768 e 1920×1080 | `PASS` |
| acessibilidade básica | `PASS` |
| fixture de 28 nós | `PASS` |
| smoke de infraestrutura | `PASS` |

Dois detalhes que elevam a qualidade da prova: a linha do tempo por `MutationObserver`
enxerga estados de milissegundos, então "o dependente acendeu depois da dependência
concluir" é observação e não inferência; e o cenário de tempo real **conta as chamadas de
`/snapshot` e exige exatamente uma**, fechando a porta do refetch disfarçado.

## Execução real com Claude Code

```
DA-REAL-002 · run 01M1C22MX19XTX50HMEA102BKY · BLOCKED
  T01 ∥ T02 DONE na 1ª tentativa (1m29s, 1m00s)
  T03 destravou sozinho; falhou 2× e escalou
  dashboard ao vivo: claude-code ●● 2/2 → ●○ 1/2

DA-REAL-003 · run 01M1C2RQW2ZRVD6DXA5RS7DMFJ · COMPLETED
  T01 DONE em 4m17s, 1ª tentativa
  executor claude-code · execute:T01-a1-...
  revisor  claude-code · review:5:...      ← identidades diferentes
  veredito PASS · fresh-session · satisfied
```

Orçamento: **6 de 6 despachos, 3 de 3 revisões** — no teto exato.

## Bugs reais encontrados

Nove defeitos, dos quais **os mais valiosos só apareceram usando o produto**:

| # | Defeito | Como apareceu |
| --- | --- | --- |
| 1 | `attachServer` publicava a porta pedida, não a ligada — com `port: 0` anunciava `:0` | implementação |
| 2 | CLI só tentava o endereço fixo do `project.yaml` | implementação |
| 3 | Pausar **matava** o processo: o modo primeiro plano encerrava quando `drain()` retornava | implementação |
| 4 | `logRefsFromEvents` procurava chaves que o orquestrador nunca emite | implementação |
| 5 | Nó parado trocava executor+duração pelo motivo da espera | implementação |
| 6 | **Dashboard não carregava em nenhum projeto que não fosse o produto** | **subindo para uso real** |
| 7 | Válvula de escape do teste de navegador podia escrever sem guarda de quota | revisão independente |
| 8 | **Enquadramento inicial deixava 2 de 8 nós fora do canvas em 1366×768** | **revisão independente, medindo** |
| 9 | **Prompt de revisão não exigia o veredito de forma inequívoca** | **agente real, em run de verdade** |

O defeito 9 é o mais instrutivo. O revisor real produziu uma análise detalhada — achados por
linha, conferência caso a caso — e a tentativa foi perdida com `AGENT_ERROR: revisor nao
emitiu veredito`. O parser estava **certo** em recusar: existe teste garantindo que a palavra
`PASS` em prosa não vira aprovação. Quem falhou foi o prompt. E os testes não pegaram porque
o `MockAgentProvider` **sempre** formata certo — nenhum teste modelava um revisor que analisa
bem e formata mal, que é o comportamento normal de um agente de verdade.

O defeito 8 mereceu três tentativas de correção. As duas primeiras funcionavam para o
sintoma mas desfaziam o pan do usuário ao abrir o painel de detalhe — e o teste de componente
que já existia **pegou as duas**. Nenhuma asserção foi afrouxada; a solução é que mudou até
respeitar a regra.

## Mutações / testes negativos

~35 mutações nesta missão. As que mais importaram:

| Invariante quebrado deliberadamente | Detectado por |
| --- | --- |
| redutor de eventos do dashboard | 2 specs de navegador |
| todas as guardas de duplo START | contagem de `POST /api/runs` pela API |
| `fitView` a cada evento SSE | spec de viewport, com a mensagem exata |
| seleção perdida a cada evento | mesmo spec, por outro caminho |
| `console.error` injetado | spec de console (a allowlist está vazia de propósito) |
| suíte de navegador vazia | `No tests found`, exit 1 — não existe verde vazio |
| inclusão silenciosa no vitest | contagem salta de 154 para 155 com falha |

## Recovery e SSE

Órfã vira `INTERRUPTED` sem presumir sucesso · nenhuma tentativa duplicada · capacidade
devolvida · lock liberado · reconexão SSE com `since` sem perda nem duplicata · refresh
durante o run reconstrói o estado a partir do backend.

## Quality gate final

```
npm run build      exit 0
npm run verify     exit 0   2.095 testes · lint 499 arquivos · fronteiras ok
npm run test:e2e   exit 0   52 testes (+4 opt-in pulados)
npx playwright     10 passed
```

## Desvios

1. **Escopo de P08 excedido para corrigir o produto.** O defeito 9 estava em
   `packages/providers`, fora do `touches` de P08. Corrigi como control plane, seguindo o
   item 53 ("se agente real revelar bug, prioridade máxima"), com regressão e revalidação.
2. **Um script temporário meu** (`p08-shot.mjs`) chegou a poluir o lint. O gate pegou;
   removido antes do commit.
3. **Dois testes existentes foram atualizados**, não afrouxados: a sequência de eventos do
   happy-path (evento novo) e o texto do prompt de revisão (contrato mudou de propósito).
   Ambos continuam exigindo o que exigiam.

Nenhum desvio silencioso.

## Bloqueios de ambiente

`Codex` sem quota até 2026-09-05 → bloqueia execução real e revisão cruzada real.
**Nenhum product blocker.**

## Próxima missão recomendada

**`DA-CORE-003`**, quando a quota do Codex voltar (≥ 05/09):

1. Fechar execução real do Codex ponta a ponta, com o mesmo fixture e os mesmos gates
2. Revisão cruzada real nos dois sentidos — Codex executa/Claude revisa e vice-versa
3. Ampliar a amostra de confiabilidade: 8 tentativas não autorizam falar em taxa de acerto
4. Reavaliar o qualificador `DUAL_PROVIDER_VALIDATION`
