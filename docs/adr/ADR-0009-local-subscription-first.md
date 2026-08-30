# ADR-0009 — Execução local subscription-first: agentes via CLIs já autenticadas

**Status:** Aceita · **Data:** 2026-08-30

## Contexto

Para executar trabalho, a plataforma precisa acionar agentes de IA. Existem dois caminhos:
chamar APIs dos fornecedores (exige chave, cobrança por token, gestão de credencial) ou
acionar os **clientes de linha de comando que o usuário já instalou e autenticou** com a
assinatura que já paga.

A escolha não é neutra. Ela determina se rodar o produto custa uma segunda conta paga, se
passamos a ser responsáveis por credenciais alheias, e quem é o usuário viável no dia um.

## Decisão

**Por padrão, agentes são processos locais.** A plataforma usa CLIs já instaladas e
autenticadas pelo usuário. Não exigimos, não pedimos, não armazenamos e não injetamos chave
de API.

Consequências normativas:

- Um provider real do MVP é **inválido** se exigir API key para funcionar.
- Autenticação é responsabilidade do CLI. O control plane não tem tipo, campo, variável de
  ambiente nem tela relacionada a credencial de fornecedor.
- O ambiente do processo do agente recebe apenas a allowlist declarada — não plantamos
  segredo nele.
- Adapters por API podem existir no futuro, pela **mesma porta** `AgentProvider`, sempre como
  opção. Nunca como pré-requisito.
- Onde a plataforma não consegue observar prontidão de forma confiável, reporta `unknown`
  (ADR-0010), em vez de inferir.

## Alternativas

- **API-first.** Contrato mais previsível e observável (uso, tokens, custo), mas transforma
  "experimentar a ferramenta" em "abrir uma conta paga e configurar chave", e nos coloca
  como custodiantes de credencial de terceiros. Custo de adoção e de responsabilidade alto
  demais para o valor que o MVP precisa provar.
- **Híbrido desde o início.** Dobra a superfície de teste e de erro antes de existir um
  caminho funcionando.
- **Um único provider local.** Barato, mas impede revisão cruzada entre fornecedores
  (ADR-0011) e deixa a porta sem prova de que é real (ADR-0010).

## Consequências

+ Roda com o que o usuário já tem; adoção sem custo adicional.
+ Zero superfície de gestão de segredo de IA no produto.
+ O domínio permanece ignorante sobre autenticação — a porta não menciona o assunto.
− Menos observabilidade de uso e custo: contabilidade de tokens depende do que cada CLI
  expõe (`reportsUsage` em `ProviderCapabilities`; frequentemente ausente).
− Dependemos do contrato de saída de CLIs externas, que muda sem aviso (risco R1 do MVP,
  contido em adapters finos e fixtures gravadas).
− Prontidão pode ser indeterminável; a primeira falha real pode só aparecer no despacho.
