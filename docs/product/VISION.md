# VISION — Desenvolvimento Agêntico

> Status: aprovado como base do produto (Missão DA-DISCOVERY-000)
> Última revisão: 2026-08-30

## 1. Definição oficial

**Desenvolvimento Agêntico é uma plataforma e um método de engenharia de software para
coordenar múltiplos agentes de IA através de grafos explícitos de trabalho, dependências
verificáveis, paralelismo controlado, isolamento de tarefas, revisão independente, quality
gates reproduzíveis, evidências objetivas e observabilidade completa da execução.**

A plataforma existe para responder, a qualquer instante:

> **O que está sendo desenvolvido, por quem, por que está executando agora, do que depende,
> o que foi validado e qual evidência permite considerar esse trabalho concluído?**

Se a arquitetura não responde isso com um dado persistido (e não com uma narrativa de
agente), ela ainda não está correta.

## 2. O problema

Agentes de IA já escrevem código, rodam testes e alteram projetos. Também já é possível
rodar vários ao mesmo tempo. O gargalo deixou de ser "o agente consegue programar?" e
passou a ser **"como coordenar vários agentes sobre a mesma entrega sem perder controle?"**.

Uma feature real é um grafo, não uma lista:

```text
            ┌── Banco ────── Backend ────┐
            │                            │
MISSÃO ─────┤                            ├── Integração ── E2E
            │                            │
            └── Componentes ─ Frontend ──┘
```

Sem uma camada formal de coordenação, o que acontece na prática:

| Sintoma | Causa estrutural |
| --- | --- |
| Agentes editam o mesmo arquivo e se sobrescrevem | Ausência de isolamento declarado de escrita |
| Trabalho executa fora de ordem | Dependência implícita, escrita em prosa no prompt |
| "Terminei, está funcionando" sem prova | Conclusão é opinião do executor, não fato verificado |
| Autor aprova o próprio trabalho | Revisão sem independência formal |
| Ninguém sabe por que a tarefa falhou | Tentativas não são registradas nem versionadas |
| Contexto se perde entre sessões | Conhecimento durável mora no chat, não no repositório |
| Gerente não enxerga o progresso | Não existe projeção observável do estado real |

Esses não são problemas de prompt. São problemas de **arquitetura de execução**.

## 3. A visão

Desenvolvimento Agêntico é um **Control Plane para engenharia de software agêntica**.

```text
                DESENVOLVIMENTO AGÊNTICO
                    (control plane)
                         │
                    ORCHESTRATOR
                         │
             ┌───────────┼───────────┐
             ▼           ▼           ▼
          AGENTE A    AGENTE B    AGENTE C
             │           │           │
           TASK        TASK        TASK
        (workspace)  (workspace)  (workspace)
```

A plataforma **controla o processo**. Os agentes **executam trabalho**. A separação é
rígida: agentes produzem artefatos (código, diffs, saídas de comando); apenas o control
plane decide transições de estado.

Consequência direta, e talvez o diferencial mais importante do produto:

> **Evidência é coletada pelo control plane, nunca declarada pelo agente.**

O diff vem do git, computado por nós. O resultado de teste vem do processo que nós
executamos, com o exit code que nós lemos. O relatório do agente é registrado, mas
classificado como *claim* — entra na auditoria, nunca na decisão.

## 4. Unidade central: a Mission

Uma **Mission** é uma entrega de engenharia declarada em arquivo, versionada no repositório
do projeto-alvo, decomposta em **Tasks** com dependências explícitas. O compilador
transforma essa declaração em um **DAG executável e validado**. O orquestrador executa o
DAG com paralelismo seguro.

```text
mission.yaml ──► Graph Compiler ──► DAG validado ──► Orchestrator ──► Run auditável
```

## 4.1 Independência: de organização e de fornecedor

Desenvolvimento Agêntico é um produto autônomo. Não é ferramenta interna de ninguém, não
assume stack e não se casa com um fornecedor de IA.

**Requisitos do projeto orquestrado** — a lista inteira:

1. ser um repositório **git** (para isolamento por worktree; sem git, modo `shared`
   sequencial);
2. declarar seus **quality gates como comandos de shell** que já funcionam hoje;
3. ter um `.agentic/` com `project.yaml`, `gates.yaml` e ao menos uma missão.

Não exigimos linguagem, framework, gerenciador de pacotes, CI específico ou estrutura de
pastas. Um monorepo TypeScript, um serviço Python, um projeto Java com Maven ou um binário
Rust são orquestrados pelo mesmo control plane, porque a fronteira é sempre a mesma:
**comandos e git**.

## 4.2 Local subscription-first

A plataforma roda **agentes locais**: os CLIs que o usuário já instalou e autenticou com a
assinatura que já paga. Não pedimos chave de API, não guardamos credencial e não
transformamos custo de API em pré-requisito de uso.

```text
AgentProvider  (porta do domínio)
     ├── MockAgentProvider        (determinístico, para teste — sem rede)
     ├── ClaudeCodeCliProvider    (processo local, autenticado pelo próprio CLI)
     └── CodexCliProvider         (processo local, autenticado pelo próprio CLI)
```

Adapters por API podem existir no futuro, pela mesma porta, como opção — nunca como
requisito. O domínio não sabe se por trás há assinatura, chave ou nada disso.

**Dois providers reais no MVP não é redundância**: é o que torna possível a *revisão cruzada
entre fornecedores* (§ Diferenciais) e o que prova, na prática, que a porta é real.

## 5. Público-alvo

1. **Tech lead / arquiteto** — decompõe a entrega, aprova a missão, decide o que é bloqueio
   arquitetural. É a autoridade humana do processo.
2. **Desenvolvedor sênior operando agentes** — acompanha execução, destrava tarefas,
   interpreta falhas de review, corrige o plano.
3. **Gestor de engenharia** — precisa ver progresso, caminho crítico, retrabalho e
   gargalos sem ler logs de agente.
4. **Auditoria / qualidade** — precisa reconstruir depois: quem fez, quando, com qual
   evidência.

Público explicitamente **não** alvo no MVP: usuário não técnico, equipe multi-tenant,
operação remota gerenciada.

## 6. Casos de uso do MVP

- **UC1 — Planejar**: escrever `mission.yaml`, rodar `agentic mission compile`, receber
  erros de ciclo, dependência inexistente, conflito de escrita e tarefas sem contrato.
- **UC2 — Executar**: rodar a missão com múltiplos executores simultâneos, isolamento de
  working tree por tentativa e capacidade respeitada por fornecedor.
- **UC3 — Validar**: cada task passa por task gate reproduzível e por revisor independente.
- **UC4 — Recuperar**: task reprovada volta para nova tentativa com histórico preservado;
  ao esgotar tentativas, escala para o humano em estado BLOCKED.
- **UC5 — Observar e operar**: dashboard mostra o DAG vivo, estado por task, evidência,
  eventos e saúde dos providers — e é dele que se dá **START MISSION**, sem clicar task a task.
- **UC6 — Auditar**: relatório final da missão com tentativas, retries, falhas de review,
  caminho crítico real e evidências.

## 7. Princípios

Detalhados em [PRODUCT-PRINCIPLES.md](PRODUCT-PRINCIPLES.md). Em uma linha cada:

plano antes da execução · dependência explícita · paralelismo seguro acima de paralelismo
máximo · isolamento declarado · revisão independente · evidência antes de DONE · gates
reproduzíveis · execução observável · contexto durável · estado explícito · tentativas
auditáveis · autoridade humana sobre arquitetura.

## 8. Diferenciais

| Diferencial | O que significa na prática |
| --- | --- |
| Grafo é a fonte da execução | Ordem vem do DAG compilado, não de instrução textual |
| Evidência observada, não declarada | Diff e exit code produzidos pelo control plane |
| `touches` é contrato, não sugestão | Alteração fora do escopo declarado reprova a tentativa |
| Autor ≠ revisor é regra do sistema | Não é convenção de prompt; é invariante verificada |
| Isolamento físico por tentativa | Git worktree por tentativa; gate roda em árvore limpa |
| Histórico imutável de tentativas | Nada é apagado; falha é dado de produto |
| Fornecedor de IA é adapter | O domínio não conhece nenhum provider |
| Revisão cruzada entre fornecedores | Task de risco alto é revisada por um agente de **outro** fornecedor |
| Roda com a assinatura que o usuário já tem | CLIs locais autenticados; sem exigência de API key |

## 9. O que o produto **não** é

- Não é um lançador de vários agentes em paralelo.
- Não é uma workflow engine genérica (o domínio é engenharia de software).
- Não é uma plataforma de CI/CD (ele *chama* os gates do projeto, não os substitui).
- Não é um substituto do desenvolvedor: automatiza execução, não governança.

## 10. Evolução

**Hoje (MVP)** — ferramenta local de engenharia: uma missão, um repositório, um provider,
persistência embarcada, dashboard local.

**Depois** — múltiplos providers e especialização de agentes, phase gates, integração com
GitHub (issues/PR/CI), templates de missão, métricas históricas, custo e tokens por task,
políticas de organização.

**Longo prazo** — missões multi-repositório, execução remota, analytics de eficiência de
agentes. Nenhuma dessas capacidades pode contaminar o MVP.

## 11. Critério de sucesso

O MVP só é considerado útil quando executar uma **feature real de um projeto real** de ponta
a ponta. Demo artificial não valida o produto. Em seguida vem o dogfooding: Desenvolvimento
Agêntico passa a ser desenvolvido por Desenvolvimento Agêntico.
