# ADR-0011 — Política de revisão cruzada entre fornecedores

**Status:** Aceita · **Data:** 2026-08-30

## Contexto

`executor ≠ reviewer` garante que ninguém aprova o próprio trabalho. Não garante
independência real: dois agentes do mesmo fornecedor compartilham vieses de treino e tendem a
concordar sobre o que "parece certo". Em decisão de risco alto, concordância correlacionada
não é validação.

Com dois providers locais (ADR-0010), revisar com **outro fornecedor** passa a ser possível
sem custo adicional para quem já tem as duas CLIs.

## Decisão

Três níveis de independência, escolhidos por **política de configuração**:

```text
fresh-session              contexto zero, mesmo fornecedor permitido
cross-provider-preferred   outro fornecedor quando houver; rebaixa e REGISTRA quando não
cross-provider-required    outro fornecedor obrigatório; sem ele, a task BLOQUEIA
```

Regra universal em todos: `reviewer.identity ≠ executor.identity`. Em
`cross-provider-required` acrescenta-se `reviewer.providerId ≠ executor.providerId`.

**A política é resolvida por configuração, não codificada no domínio.** O domínio recebe uma
`ReviewPolicy` já resolvida por task. Precedência:

```text
task.reviewPolicy > mission.defaults.reviewPolicy
                  > project.policies.review.byRisk[task.risk]
                  > project.policies.review.default
```

Ponto de partida sugerido em `project.yaml`: `low → fresh-session`,
`medium → cross-provider-preferred`, `high → cross-provider-required`.

**Falha da política nunca é silenciosa:** `required` sem segundo fornecedor apto leva a task a
`BLOCKED` (`kind: POLICY`, `reason: CROSS_PROVIDER_UNAVAILABLE`); `preferred` rebaixa para
`fresh-session` gravando `policyOutcome: downgraded` e emitindo `review.policy_downgraded`. O
compilador avisa antes (`DA2008`).

## Alternativas

- **Mapear risco→política dentro do domínio.** Codificaria uma opinião de processo como regra
  de negócio. Equipes têm apetites de risco diferentes; isso muda sem tocar código.
- **Sempre exigir fornecedor cruzado.** Dobra o custo e trava projetos com um único CLI
  instalado.
- **Rebaixar silenciosamente quando não houver segundo fornecedor.** Destruiria a garantia:
  ninguém saberia que a revisão "cruzada" não foi cruzada. Rejeitado.
- **Definir a política só por missão.** Perde granularidade: numa mesma entrega, migração de
  schema e ajuste de texto não merecem o mesmo rigor.

## Consequências

+ Independência de revisão deixa de ser binária e passa a ser escolhida com intenção.
+ Quebra a correlação de vieses onde importa, sem impor custo onde não importa.
+ Registro permite medir, no futuro, se revisão cruzada reprova mais que revisão interna.
− Novo caminho de bloqueio operacional (`CROSS_PROVIDER_UNAVAILABLE`) — mitigado por aviso na
  compilação, no `doctor` e na tela de START MISSION.
− Seleção de revisor no orquestrador fica mais complexa (política × identidade × capacidade).
