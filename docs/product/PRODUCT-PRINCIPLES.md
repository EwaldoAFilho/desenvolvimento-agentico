# PRODUCT PRINCIPLES — Desenvolvimento Agêntico

Princípios não negociáveis. Cada um traz **como é verificado no sistema** — princípio que
não vira invariante verificável é decoração.

---

## P01 — Plano antes da execução

Nenhuma task executa sem pertencer a uma missão compilada e aprovada.

*Verificação:* `Run` só é criado a partir de um `CompiledGraph` sem diagnósticos de
severidade `ERROR`, e a missão precisa estar `APPROVED`.

---

## P02 — Dependência é explícita ou não existe

Ordem de execução vem do grafo. Texto em prosa ("provavelmente faça depois") não é
dependência.

*Verificação:* o scheduler só considera `dependencies` declaradas. Não existe heurística
de ordem baseada em linguagem natural.

---

## P03 — Paralelismo seguro acima de paralelismo máximo

O objetivo não é maximizar agentes, é maximizar trabalho independente simultâneo.

*Verificação:* `maxParallelTasks`, `maxExecutors`, `maxReviewers` são configuração, nunca
constante no domínio. Duas tasks concorrentes com `touches` sobrepostos nunca são
despachadas juntas.

---

## P04 — Escopo declarado é contrato

`touches` declara onde a task pode escrever. Não é documentação, é fronteira.

*Verificação:* ao fim de cada tentativa o control plane calcula os arquivos alterados. Se
houver caminho fora de `touches` (ou dentro de `denyPaths`), a tentativa falha com
`SCOPE_VIOLATION`, independentemente de o código estar bom.

---

## P05 — Evidência é observada, nunca declarada

O relatório do agente é um *claim*. Fato é o que o control plane mediu.

*Verificação:* o tipo `AgentOutcome.claims` é explicitamente não confiável e não participa
de nenhuma transição de estado. Transições consomem `Observation` (diff calculado por nós,
exit code de processo executado por nós).

---

## P06 — DONE exige prova, não afirmação

`DONE` é um predicado, não uma opinião:

```text
DONE(task) ⟺  scopeCheck = PASS
          ∧  (taskGate ausente ∨ taskGate = PASS)
          ∧  (¬requireReview ∨ (review = PASS ∧ reviewer ≠ executor))
          ∧  integration = MERGED
          ∧  evidência persistida e referenciável
```

*Verificação:* a transição para `DONE` é implementada como avaliação desse predicado sobre
registros persistidos.

---

## P07 — Autor não é revisor

Quando `requireReview = true`, a revisão é feita por outro agente, com contexto novo,
recebendo evidência — não a narrativa do executor.

*Verificação:* invariante `review.reviewerId ≠ attempt.executorId` validada na transição;
violação é erro de sistema, não warning.

---

## P08 — Quality gates são reproduzíveis por humanos

Gate é lista ordenada de comandos declarada no repositório, executada pelo control plane.

*Verificação:* toda `GateExecution` grava comando exato, cwd, exit code, duração e saída.
Um humano consegue colar o comando no terminal e obter o mesmo resultado.

---

## P09 — Agentes nunca definem as próprias regras de qualidade

Gates vêm de `.agentic/gates.yaml`, versionado e escrito por humanos.

*Verificação:* `denyPaths` inclui `.agentic/` por padrão; alteração de gate por agente é
`SCOPE_VIOLATION`.

---

## P10 — Uma única fonte de verdade

O estado operacional vive no control plane. Dashboard e CLI são projeções.

*Verificação:* o orquestrador é o único escritor do estado do run. Nenhum agente tem acesso
de escrita ao banco de estado.

---

## P11 — Estado explícito, transições formais

Não existe estado implícito nem transição arbitrária. `BLOCKED` é estado de primeira classe:
nada fica artificialmente `RUNNING` esperando decisão humana.

*Verificação:* máquina de estados declarada como tabela de transições permitidas; transição
inválida lança erro e é registrada como evento.

---

## P12 — Histórico é imutável

Tentativa anterior nunca é apagada nem sobrescrita. Falha é dado de produto.

*Verificação:* `attempts` e `events` são append-only. Não há UPDATE sobre tentativa
encerrada.

---

## P13 — Contexto durável mora no repositório

Definição de missão, gates, políticas, ADRs e relatório final são arquivos versionados.
Chat não é memória do projeto.

*Verificação:* `mission.yaml`, `.agentic/*.yaml` e `docs/missions/*-report.md` são
commitados; artefatos brutos de run ficam locais e descartáveis.

---

## P14 — Contexto mínimo suficiente para o agente

O executor recebe objetivo, escopo permitido, dependências satisfeitas e contrato de
validação. Não recebe o dump do projeto inteiro nem a narrativa das outras tasks.

*Verificação:* o `Assignment` é um contrato tipado e fechado; não existe caminho para
"mandar tudo".

---

## P15 — Autoridade humana sobre arquitetura

O humano decide direção de produto, arquitetura, aprovação de missão, risco alto e release.
Aprovada a missão, tasks normais não pedem confirmação individual; escalonam apenas
ambiguidade arquitetural, risco alto inesperado, operação irreversível, expansão de escopo e
questão de segurança.

*Verificação:* estado `BLOCKED` com `reason` e `escalation`, exigindo ação humana explícita
para retomar.

---

## P16 — Simplicidade é vantagem competitiva

Ferramenta local antes de plataforma distribuída. Nenhum componente entra sem caso de uso
presente e demonstrável.

*Verificação:* a seção "Out of scope" do MVP é parte do contrato de entrega, não uma nota.

---

## P17 — Local subscription-first

Por padrão, a plataforma usa os agentes disponíveis através de **clientes/CLIs locais já
instalados e autenticados pelo usuário**, aproveitando a assinatura que ele já tem. Não
exigimos chave de API paga para operar.

Consequências diretas:

- Um provider real do MVP é considerado inválido se **exigir** API key para funcionar.
- A autenticação é responsabilidade do CLI, não nossa: não guardamos, não pedimos e não
  repassamos credencial de modelo.
- Adapters baseados em API são evolução **opcional**, entram pela mesma porta e nunca se
  tornam pré-requisito.

*Verificação:* `agentic doctor` opera sem nenhuma variável de credencial de IA definida; a
suíte de contrato dos providers roda sem rede; o domínio não tem nenhum tipo relacionado a
autenticação de fornecedor.

---

## P18 — Independência de organização e de fornecedor

O produto não pertence a nenhuma empresa, projeto ou fornecedor de IA. Nenhuma decisão
arquitetural pode ser justificada por conveniência de um ecossistema específico.

- **Organização:** orquestra qualquer repositório que atenda aos requisitos mínimos (git +
  comandos de verificação executáveis). Linguagem, framework e gerenciador de pacotes do
  projeto-alvo são irrelevantes para o control plane.
- **Fornecedor:** o domínio não conhece nome de CLI, empresa ou modelo. `ProviderId` é uma
  string opaca vinda de configuração.

*Verificação:* nenhuma ADR justifica escolha por compatibilidade com uma organização; uma
busca por nome de fornecedor em `packages/domain` não retorna ocorrência (verificado por
lint em T01); a suíte do orquestrador roda inteira com provider `mock`.
