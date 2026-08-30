# MÉTODO DE DESENVOLVIMENTO AGÊNTICO ORIENTADO A GRAFOS

> O método é independente da plataforma: dá para praticá-lo no papel. A plataforma existe
> para que ele deixe de depender de disciplina e passe a ser garantido por construção.

## 1. Premissa

Desenvolvimento com múltiplos agentes falha por **coordenação**, não por capacidade de
codificação. O método ataca coordenação: torna explícito o que normalmente fica implícito
(ordem, escopo, critério de pronto, prova) e mecânico o que normalmente fica na boa vontade
(revisão independente, histórico, evidência).

## 2. Os doze princípios operacionais

| # | Princípio | Prática concreta |
| --- | --- | --- |
| 1 | Plano antes da execução | Nenhuma task roda fora de missão compilada e aprovada |
| 2 | Dependência explícita | Ordem vem de aresta declarada, nunca de prosa |
| 3 | Paralelismo controlado | Limites configurados; concorrência derivada do grafo |
| 4 | Isolamento de task | `touches` declarado + worktree por tentativa |
| 5 | Revisão independente | `executor ≠ reviewer`, revisor recebe evidência, não narrativa; risco alto pede **outro fornecedor** |
| 6 | Evidência antes de DONE | Conclusão é predicado sobre fatos medidos |
| 7 | Gates reproduzíveis | Comandos versionados, executados pelo control plane |
| 8 | Execução observável | DAG vivo + stream de eventos |
| 9 | Contexto durável | Missão, gates, ADRs e relatório no repositório |
| 10 | Estado explícito | Máquina de estados formal; `BLOCKED` é estado real |
| 11 | Tentativas auditáveis | Append-only; falha nunca é apagada |
| 12 | Autoridade humana | Arquitetura, aprovação e release são do humano |

## 3. Ciclo de vida de uma missão

```text
1. REQUISITO      humano descreve a entrega
2. DECOMPOSIÇÃO   humano (com apoio de agente planejador) escreve mission.yaml
3. COMPILAÇÃO     agentic mission compile → erros, warnings, DAG, caminho crítico
4. CORREÇÃO       ajusta granularidade, dependências e escopos até compilar limpo
5. APROVAÇÃO      humano aprova → gate humano do plano
6. EXECUÇÃO       orquestrador executa o DAG com paralelismo seguro
7. VERIFICAÇÃO    task gates + revisão independente por tentativa
8. INTEGRAÇÃO     consolidação na branch da missão
9. MISSION GATE   validação da entrega inteira
10. RELATÓRIO     evidências, métricas, caminho crítico real, retrabalho
11. DECISÃO       humano revisa e decide o PR/release
```

Etapas 3 e 4 são onde o método paga por si: a maior parte dos problemas de execução
multiagente é detectável **antes** de qualquer agente rodar.

## 4. Como decompor bem

Uma boa task:

- tem **um** objetivo verificável ("endpoint PATCH persiste e valida permissão"), não um
  tema ("mexer no backend");
- declara escopo de escrita que um agente consegue respeitar;
- tem critério de aceitação que outro agente consegue conferir olhando o diff;
- cabe em uma sessão de agente sem estourar contexto;
- não depende de decisão arquitetural em aberto — se depende, a decisão é uma task anterior
  (ou um bloqueio humano).

Sinais de decomposição errada:

| Sintoma | Correção |
| --- | --- |
| `touches` cobre meio repositório | quebrar por fronteira de módulo |
| Task com 6 objetivos no `objective` | uma task por objetivo |
| Cadeia linear de 8 microtasks | fundir; paralelismo zero não paga o overhead |
| Duas tasks concorrentes no mesmo diretório | criar dependência ou fundir |
| Task sem `validation` e sem `gate` | definir como se prova que ficou pronta |

Regra prática de granularidade: **se dois agentes não conseguem trabalhar simultaneamente
sem se atrapalhar, o corte está errado; se uma task não cabe em uma sessão, o corte está
grosso.**

## 5. O contrato do executor

O executor recebe **contexto mínimo suficiente**:

```text
MISSÃO      objetivo, constraints, o que está fora de escopo
TASK        objetivo, descrição, critérios de validação
ESCOPO      caminhos onde pode escrever (e os proibidos)
DEPENDÊNCIAS o que já ficou pronto e onde está
QUALIDADE   quais comandos vão julgar o trabalho
PROJETO     convenções do repositório
```

O que ele **não** recebe: o histórico das outras tasks, a narrativa de tentativas
anteriores de outros agentes, ou o dump do projeto. Contexto irrelevante é ruído que degrada
resultado e custa dinheiro.

Ao final, o executor entrega alterações no workspace. O que ele *diz* vai para o histórico
como `claims`; o que ele *fez* é medido pelo control plane.

## 6. O contrato do revisor

O revisor recebe contrato da task + diff + resultados de gate + critérios de validação.
**Não** recebe a explicação do executor — narrativa convincente enviesa revisão.

Ele devolve:

```text
verdict: FAIL
evidence:
  - npm run test -w @exemplo/api → 35 passed, 2 failed
findings:
  - severity: blocker
    path: apps/api/src/bpm/propriedades/controller.ts:48
    message: ContractList deveria retornar 403 para usuário sem permissão
```

Veredito sem evidência citável é tratado como revisão inválida e refeita.

## 6.1 Independência do revisor tem graus

"Revisor independente" não é binário. O método reconhece três graus, escolhidos por política
de projeto e não por improviso:

```text
fresh-session              contexto zero, mesmo fornecedor
cross-provider-preferred   outro fornecedor quando houver; rebaixa e registra quando não
cross-provider-required    outro fornecedor obrigatório; sem ele, a task bloqueia
```

Ponto de partida sugerido: `low → fresh-session`, `medium → cross-provider-preferred`,
`high → cross-provider-required`.

O motivo de existir revisão cruzada é concreto: dois agentes do mesmo fornecedor
compartilham vieses de treino e tendem a concordar sobre o que "parece certo". Um revisor de
outro fornecedor não elimina o problema, mas quebra a correlação — e o custo é baixo quando
o usuário já tem as duas CLIs instaladas sob assinaturas que já paga.

Rebaixamento nunca é silencioso: fica no registro da revisão e no log de eventos.

## 7. Definição de pronto

```text
DONE(task) ⟺  escopo respeitado
          ∧  task gate PASS (quando declarado)
          ∧  revisão independente PASS (quando exigida)
          ∧  integração concluída
          ∧  evidência persistida e citável
```

"Terminei" não é um estado do sistema.

## 8. Falha como dado

Toda tentativa reprovada permanece: quem executou, o que mudou, qual comando falhou, o que o
revisor apontou. Depois de algumas missões isso responde perguntas de processo que hoje
ninguém consegue responder: quais tipos de task reprovam mais, onde o retrabalho se
concentra, se granularidade menor reduz retry, se um perfil de agente é melhor em backend.

## 9. Escalonamento

Depois de aprovada a missão, tasks normais não pedem confirmação. Escalam para o humano:

- ambiguidade arquitetural (revisor devolve `ESCALATE`);
- risco alto inesperado;
- operação irreversível (migração destrutiva, remoção de dados);
- expansão de escopo (a task precisa de algo fora do `touches`);
- questão de segurança;
- tentativas esgotadas.

Escalonamento leva a `BLOCKED` com motivo — nunca a uma task fingindo que está executando.

## 10. Antipadrões do desenvolvimento multiagente

| Antipadrão | Por que falha |
| --- | --- |
| "Roda 10 agentes que alguém acerta" | multiplica conflito e custo, não throughput |
| Ordem no prompt em vez de aresta | não é verificável nem visualizável |
| Agente valida o próprio trabalho | viés de autoria; a falha some do registro |
| Teste rodado pelo agente, resultado relatado por ele | evidência não reproduzível |
| Contexto gigante "por segurança" | degrada qualidade e aumenta custo |
| Estado da execução no chat | some na próxima sessão |
| Retry infinito | esconde problema de plano |
| Revisor do mesmo fornecedor em decisão crítica | vieses correlacionados; concordância não é validação |
| Exigir API paga quando o usuário já tem assinatura | custo artificial para rodar o próprio método |

## 11. Dogfooding

Assim que o MVP estabilizar, a evolução da própria plataforma passa a ser conduzida por
missões executadas na própria plataforma. É o teste mais duro disponível: se o método não
sustenta o desenvolvimento de um control plane concorrente e auditável, não sustenta os
projetos dos outros.
