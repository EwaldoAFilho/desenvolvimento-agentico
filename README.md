# Desenvolvimento Agêntico

**Um control plane para coordenar múltiplos agentes de IA numa mesma entrega de software —
com dependências explícitas, isolamento real, revisão independente e evidência medida pela
plataforma, nunca declarada pelo agente.**

```
mission.yaml  ──►  Graph Compiler  ──►  DAG validado  ──►  Orchestrator  ──►  Run auditável
                         │                                      │
                erros, avisos,                    executor → gate → revisor
                caminho crítico,                  independente → integração
                conflitos de escopo                     → DONE com evidência
```

---

## O problema

Agentes de IA já escrevem código, rodam testes e alteram projetos. Também já dá para rodar
vários ao mesmo tempo. O gargalo deixou de ser *"o agente consegue programar?"* e passou a
ser **"como coordenar vários agentes sobre a mesma entrega sem perder o controle?"**.

Uma feature real não é uma lista de tarefas. É um grafo:

```
            ┌── Banco ────── Backend ────┐
            │                            │
MISSÃO ─────┤                            ├── Integração ── E2E
            │                            │
            └── Componentes ─ Frontend ──┘
```

Sem uma camada formal de coordenação, o que acontece na prática:

| Sintoma | Causa estrutural |
| --- | --- |
| Dois agentes editam o mesmo arquivo e se sobrescrevem | não existe isolamento declarado de escrita |
| O trabalho executa fora de ordem | a dependência estava em prosa no prompt, não no grafo |
| *"Terminei, está funcionando"* — sem prova | a conclusão é opinião do executor, não fato verificado |
| O autor aprova o próprio trabalho | a revisão não tem independência formal |
| Ninguém sabe por que a tarefa falhou | as tentativas não são registradas nem versionadas |
| O contexto se perde entre sessões | o conhecimento durável mora no chat, não no repositório |

Esses não são problemas de prompt. São problemas de **arquitetura de execução**.

---

## A ideia central

> **Evidência é coletada pelo control plane, nunca declarada pelo agente.**

O diff vem do `git`, calculado por nós. O resultado do teste vem do processo que nós
executamos, com o exit code que nós lemos. O relatório do agente é registrado — e chamado
de `claims` no código, deliberadamente — mas **nunca decide uma transição de estado**.

Daí decorre o resto:

- **`touches` é contrato, não sugestão.** A task declara onde pode escrever. Alteração fora
  disso reprova a tentativa com `SCOPE_VIOLATION`, mesmo que o código esteja bom.
- **Autor ≠ revisor é invariante do sistema**, não instrução de prompt. E em tasks de risco
  alto a revisão pode exigir um **fornecedor diferente**.
- **`DONE` é um predicado, não uma opinião:**
  ```
  DONE(task) ⟺ escopo respeitado ∧ gate PASS ∧ revisão PASS (reviewer ≠ executor)
                ∧ integração concluída ∧ evidência persistida e citável
  ```
- **Cada tentativa roda numa git worktree própria**, em branch própria. O gate roda lá
  dentro, sobre código isolado — é isso que torna a evidência atribuível quando há
  paralelismo.

---

## Subscription-first: roda com o que você já paga

O produto aciona os **CLIs que você já tem instalados e autenticados**. Não pede chave de
API, não guarda credencial, não transforma custo de API em pré-requisito.

```
AgentProvider  (porta do domínio — não conhece nenhum fornecedor)
     ├── MockAgentProvider       determinístico, sem rede, sem quota — usado nos testes
     ├── ClaudeCodeCliProvider   processo local, autenticado pelo próprio CLI
     └── CodexCliProvider        processo local, autenticado pelo próprio CLI
```

O domínio não sabe se por trás há assinatura, chave ou nada disso. Trocar de fornecedor é
escrever um adapter — nenhuma linha do domínio muda.

---

## Como usar

### Requisitos

- **Node ≥ 22** — o control plane usa um módulo nativo (`better-sqlite3`); versão errada
  falha na instalação, de propósito
- **git** — o isolamento por worktree depende dele
- **um CLI de agente autenticado** por assinatura (Claude Code e/ou Codex), ou apenas o
  provider `mock` para experimentar sem consumir nada

### Instalação

```bash
git clone https://github.com/EwaldoAFilho/desenvolvimento-agentico.git
cd desenvolvimento-agentico
npm ci
npm run build
```

### Primeiro contato: o ambiente aguenta?

```bash
node apps/cli/bin/agentic.mjs doctor
```

```
  ok       versao do Node                     node 24.18.1
  ok       git disponivel                     git version 2.53.0
  ok       repositorio git valido             ...
  ok       fornecedor claude-code             READY · 2.1.220 · sonda `claude auth status` saiu 0
  unknown  fornecedor outro-cli               nao apurado: a CLI nao expoe estado de autenticacao

  `unknown` significa que nao foi possivel apurar — nunca conte como pronto.
```

Aquele `unknown` é a regra da casa: quando o produto não consegue observar, ele diz que não
consegue. Um `--version` que respondeu prova instalação, **não** autenticação.

### Declarar uma missão

```yaml
# .agentic/missions/MINHA-001.mission.yaml
apiVersion: agentic/v1
kind: Mission
id: MINHA-001
title: Painel de propriedades
objective: Painel lê e grava propriedades via API, com validação e teste.
acceptanceCriteria:
  - Alterar propriedade persiste e sobrevive a reload
phases:
  - { id: backend, title: Backend }
tasks:
  - id: T01
    phase: backend
    title: Endpoint de gravação
    objective: PATCH persiste propriedades validando permissão do usuário.
    dependencies: []
    touches: [apps/api/src/propriedades/]   # contrato: escrever fora daqui reprova
    validation:
      - Usuário sem permissão recebe 403
    gate: unit
    risk: high
    reviewPolicy: cross-provider-required   # revisor de OUTRO fornecedor
```

### Compilar antes de gastar um único agente

```bash
node apps/cli/bin/agentic.mjs mission compile .agentic/missions/MINHA-001.mission.yaml
```

O compilador recusa planos ruins **antes** de qualquer execução — ciclos, dependência
inexistente, id duplicado, gate que não existe, escopo dentro de caminho proibido, e
**conflito de escrita entre tasks concorrentes**. São 22 diagnósticos. Ele também calcula:

```
waves (earliest start)
  1. T01 T02
  2. T03 T04
caminho critico (5 tasks, comprimento 13)
  T01 -> T03 -> T05 -> T07 -> T08
conflitos de touches: 0
```

> O compilador é implacável inclusive com quem o escreveu: ele **reprovou o plano das
> próprias missões deste repositório três vezes** antes de aceitar — uma delas apontando
> trabalho órfão que passaria despercebido.

### Executar e acompanhar

```bash
node apps/cli/bin/agentic.mjs mission approve <arquivo> --actor "seu-nome"
node apps/cli/bin/agentic.mjs serve            # control plane + dashboard em 127.0.0.1:4317
node apps/cli/bin/agentic.mjs mission start <arquivo>
```

Abra **http://127.0.0.1:4317**. Um clique em **START MISSION** e o orquestrador descobre
sozinho todas as tasks prontas e despacha — você não inicia task por task.

Investigando enquanto roda:

```bash
agentic mission status              # estado do run, providers, métricas
agentic task inspect T04            # worktree, branch, gate, evidência, log do agente
agentic events tail                 # linha do tempo
agentic mission pause / resume
agentic run report --md             # relatório final com caminho crítico real
```

---

## Stack

Escolhida para ser previsível e local, não para impressionar.

| Camada | Escolha | Por quê |
| --- | --- | --- |
| Linguagem | **TypeScript** estrito, Node 22+ | um só modelo de tipos do YAML até o pixel do dashboard |
| Monorepo | **npm workspaces** | `npm` já vem com o Node — zero pré-requisito para clonar e contribuir |
| Validação / formato | **zod** + **yaml** | YAML porque humano escreve e comenta; o parser não vaza para o domínio |
| Persistência | **SQLite** (WAL) + artefatos em arquivo | transação real, zero operação, arquivo único descartável |
| HTTP / tempo real | **Fastify** + SSE | um processo, uma fonte de verdade |
| Dashboard | **React 19** + **Vite** + **@xyflow/react** + **dagre** | SPA servida pelo próprio control plane; sem segundo backend |
| Testes | **vitest** + **Playwright** | 2.088 unitários/integração, 52 E2E, aceitação em Chromium real |
| Lint / formato | **biome** | e um verificador próprio de fronteiras arquiteturais |

**Nada disso define o produto.** Engine de orquestração, domínio, máquina de estados,
protocolo dos agentes e contratos de execução são implementação própria.

E a stack **não restringe o projeto orquestrado**: a fronteira com ele são comandos de shell
e operações de git. Um monorepo TypeScript, um serviço Python, um projeto Java com Maven ou
um binário Rust são coordenados pelo mesmo control plane.

### Arquitetura

```
interfaces (cli · server · web)  ──►  application  ──►  domain  ◄──  adapters
```

`packages/domain` não importa Fastify, React, SQLite, git nem fornecedor algum. As portas
são declaradas no domínio e implementadas fora — e **essa regra é verificada por lint**, não
confiada à disciplina: um import proibido quebra o build, e um nome de fornecedor dentro do
domínio também.

```
packages/  domain · schemas · graph · compiler · process · persistence
           gates · agent-runtime · workspace · providers · orchestrator
apps/      cli · server · web
```

---

## Como este projeto foi construído

Ele se desenvolve pelo próprio método que propõe. As missões estão versionadas em
[`.agentic/missions/`](.agentic/missions/) e os relatórios de evidência em
[`docs/missions/`](docs/missions/).

Em `DA-DOGFOOD-001`, o produto executou uma missão que **alterava o próprio código**: criou
worktrees isoladas, rodou o gate dentro delas, integrou na branch da missão. Numa das tasks
o agente investigou, concluiu que a premissa da task era falsa, **recusou-se a inventar
trabalho fora do escopo declarado** e recomendou corrigir o plano. O produto registrou
`NO_CHANGES` — não fingiu sucesso. O agente estava certo; a definição da task é que estava
errada.

Os defeitos mais valiosos apareceram **usando** o produto, não testando:

- os adapters não davam permissão de escrita ao agente na worktree que o próprio produto
  criava para ele — as CLIs falsas dos testes sempre escreviam, então o falso era mais
  permissivo que o real;
- o log do agente era transmitido e **descartado**: três tentativas reais falharam e não
  havia como descobrir por quê;
- o dashboard não carregava em nenhum projeto que não fosse o próprio produto — e a
  mensagem de erro mandava rodar um build que não resolveria nada.

---

## Documentação

| Documento | Conteúdo |
| --- | --- |
| [VISION](docs/product/VISION.md) | por que existe, para quem, casos de uso |
| [PRODUCT-PRINCIPLES](docs/product/PRODUCT-PRINCIPLES.md) | 18 princípios, cada um com sua verificação |
| [ARCHITECTURE](docs/architecture/ARCHITECTURE.md) | componentes, camadas, persistência, segurança |
| [DOMAIN-MODEL](docs/architecture/DOMAIN-MODEL.md) | entidades, portas, linguagem ubíqua |
| [STATE-MACHINES](docs/architecture/STATE-MACHINES.md) | 12 estados de Task, 9 de Run, invariantes |
| [MISSION-FORMAT](docs/architecture/MISSION-FORMAT.md) | especificação dos arquivos declarativos |
| [MÉTODO](docs/development/AGENTIC-DEVELOPMENT-METHOD.md) | o método orientado a grafos |
| [ADRs](docs/adr/) | 12 decisões arquiteturais com alternativas recusadas |
| [PRODUCT-READINESS](docs/product/PRODUCT-READINESS.md) | matriz de prontidão, sem porcentagem inventada |

---

## Estado atual

`READY_FOR_CONTROLLED_REAL_USE` — executa trabalho real com fornecedor real, isola,
verifica, integra e audita. Validação com dois fornecedores simultâneos ainda pendente por
quota externa.

**Ainda não é** uma ferramenta para deixar rodando sozinha. É uma ferramenta para trabalhar
**com** você olhando o grafo.

## Fora de escopo, deliberadamente

Multi-tenant, billing, marketplace, Kubernetes, filas distribuídas, execução remota,
integração com GitHub, providers por API paga, editor visual de missões, analytics.
Primeiro o produto local precisa ser excelente.

---

## Licença

MIT
