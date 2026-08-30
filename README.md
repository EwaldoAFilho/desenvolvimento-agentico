# Desenvolvimento Agêntico

Plataforma e método de engenharia de software para coordenar múltiplos agentes de IA através
de grafos explícitos de trabalho, dependências verificáveis, paralelismo controlado,
isolamento de tarefas, revisão independente, quality gates reproduzíveis, evidências
objetivas e observabilidade completa da execução.

A pergunta que a plataforma responde a qualquer instante:

> **O que está sendo desenvolvido, por quem, por que está executando agora, do que depende,
> o que foi validado e qual evidência permite considerar esse trabalho concluído?**

## Estado atual

**Gate de planejamento concluído.** Discovery, domínio, arquitetura e plano do MVP estão
documentados. A implementação ainda não começou — a próxima missão é `DA-CORE-001`.

## Documentação

| Documento | Conteúdo |
| --- | --- |
| [product/VISION.md](docs/product/VISION.md) | Por que o produto existe, para quem, casos de uso, evolução |
| [product/PRODUCT-PRINCIPLES.md](docs/product/PRODUCT-PRINCIPLES.md) | 16 princípios não negociáveis, cada um com sua verificação |
| [architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md) | Componentes, camadas, processo, persistência, segurança |
| [architecture/DOMAIN-MODEL.md](docs/architecture/DOMAIN-MODEL.md) | Entidades, responsabilidades, portas, linguagem ubíqua |
| [architecture/STATE-MACHINES.md](docs/architecture/STATE-MACHINES.md) | Máquinas de estado de Task e Run, invariantes |
| [architecture/MISSION-FORMAT.md](docs/architecture/MISSION-FORMAT.md) | Especificação de `mission.yaml`, `project.yaml`, `gates.yaml` |
| [architecture/DASHBOARD.md](docs/architecture/DASHBOARD.md) | Visualização do DAG e linguagem visual de estados |
| [architecture/ARCHITECTURE-AUDIT.md](docs/architecture/ARCHITECTURE-AUDIT.md) | Auditoria crítica do plano, correções e riscos assumidos |
| [development/AGENTIC-DEVELOPMENT-METHOD.md](docs/development/AGENTIC-DEVELOPMENT-METHOD.md) | O método orientado a grafos |
| [development/MVP-PLAN.md](docs/development/MVP-PLAN.md) | Escopo, DAG, paralelização e caminho crítico do MVP |
| [adr/](docs/adr/) | Decisões arquiteturais registradas |

Configuração e missões de exemplo em [`.agentic/`](.agentic/).

## Conceitos em 30 segundos

```text
mission.yaml ──► Graph Compiler ──► DAG validado ──► Orchestrator ──► Run auditável
                       │                                  │
             erros, warnings,                    executor → gate → revisor
             caminho crítico,                    independente → integração
             conflitos de escopo                        → DONE com evidência
```

- **Mission**: uma entrega, declarada em arquivo versionado.
- **Task**: unidade com objetivo, dependências, escopo de escrita e critério de validação.
- **Evidência**: coletada pelo control plane. O relato do agente é registrado, nunca decide.
- **DONE**: predicado sobre fatos, não afirmação de quem executou.
- **Agentes locais**: os CLIs que você já instalou e autenticou. Sem API key.
- **Revisão cruzada**: task de risco alto é revisada por um agente de outro fornecedor.

## Requisitos do projeto orquestrado

A lista inteira: ser um repositório **git**, declarar seus **quality gates como comandos de
shell** que já funcionam, e ter um `.agentic/` com `project.yaml`, `gates.yaml` e uma missão.
Linguagem, framework, gerenciador de pacotes e CI são irrelevantes para o control plane — a
fronteira é sempre **comandos e git**.

## Próxima missão

`DA-CORE-001` — construir o MVP conforme [MVP-PLAN.md](docs/development/MVP-PLAN.md) e
[`.agentic/missions/DA-CORE-001.mission.yaml`](.agentic/missions/DA-CORE-001.mission.yaml).
