# ADR-0010 — Dois providers reais locais no MVP e suíte de contrato única

**Status:** Aceita · **Data:** 2026-08-30

## Contexto

O MVP precisa provar que `AgentProvider` é uma porta de verdade, e não uma abstração
desenhada em volta de uma única implementação. Precisa também viabilizar revisão cruzada
entre fornecedores (ADR-0011), que exige dois fornecedores.

## Decisão

Três adapters no MVP:

```text
AgentProvider
     ├── MockAgentProvider        determinístico, sem rede, sem quota
     ├── ClaudeCodeCliProvider    processo local (ADR-0009)
     └── CodexCliProvider         processo local (ADR-0009)
```

1. **Uma única suíte de contrato** roda igual nos três. O que ela cobre: execução com `cwd`
   informado, streaming quando suportado, cancelamento, timeout, status de saída, CLI
   inexistente (`PROVIDER_UNAVAILABLE`), CLI presente mas não autenticada
   (`PROVIDER_NOT_READY`) e respeito a `maxConcurrent`.
2. **Nenhum teste automatizado consome quota real.** Adapters reais são testados com stubs de
   processo e fixtures de saída gravadas. Validação contra as CLIs de verdade é roteiro
   manual documentado, não parte da suíte.
3. **O domínio não conhece nenhum dos dois.** `ProviderId` é string opaca vinda de
   configuração; os nomes das CLIs aparecem apenas em `packages/providers` e em
   `project.yaml`. Verificado por lint (T01/T02).
4. **Saúde honesta.** `ProviderCapabilities.readinessProbe` declara se a CLI permite observar
   prontidão. Quando não permite, `ProviderHealth.ready = 'unknown'`. `--version` responder
   **não** é prova de autenticação. Não inventamos suporte que a ferramenta não oferece.

## Alternativas

- **Um provider real + mock.** Mais barato, mas a porta fica sem prova e a revisão cruzada
  vira promessa de roadmap. A segunda implementação é justamente o que revela o que era
  premissa específica do primeiro CLI.
- **Vários providers.** Custo de manutenção sem valor adicional no MVP: dois já provam a
  porta e habilitam a revisão cruzada.
- **Assumir `ready: true` quando o binário existe.** Simplifica a UI e mente para o operador.
  Recusado: `unknown` é informação, otimismo é ruído.

## Consequências

+ A porta é validada por construção, não por convicção.
+ Revisão cruzada entre fornecedores torna-se possível no MVP.
+ Suíte de contrato única transforma "adicionar provider" em tarefa mecânica e verificável.
− `T09` cresce de 5 para 7 unidades e fica com folga 1 na cadeia quase crítica (risco R4).
− Duas dependências externas instáveis em vez de uma.
