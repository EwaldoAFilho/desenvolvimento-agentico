# ADR-0015 — Extensão VS Code como cliente do control plane

**Status:** aceita (DA-VSCODE-MVP-001)
**Data:** 2026-09-02

## Contexto

O produto já tinha CLI e dashboard no navegador. A jornada principal — abrir o repositório,
subir o control plane, ver providers e missions, parar e reiniciar — exigia terminal, porta
e `control-plane.json`. Queríamos a mesma jornada dentro do VS Code, sem chat próprio, sem
duplicar o dashboard e sem mover o orquestrador para dentro do editor.

Os ADRs 0013 (posse por `repoRoot`) e 0014 (ciclo de vida com nome) já previam a extensão:
`ensureAgenticRunning(repoRoot)` implementável sem `ps`, `kill -9`, porta fixa ou `sleep`, e
um `stop` que a extensão chamaria.

## Decisão

1. **A extensão é cliente/shell.** `extensions/vscode` não contém o orquestrador, o servidor
   nem o banco. Ela detecta o projeto, descobre ou sobe um processo `agentic serve` e lê por
   HTTP. O bundle é verificado por teste: nenhuma marca de Fastify, SQLite ou orquestrador.

   ```text
   VS Code Extension → AgenticHost (cliente/serviço) → Control Plane (processo) → Orchestrator
   ```

2. **Um control plane por `repoRoot`, também entre janelas.** `Start` primeiro procura o
   dono vivo (`control-plane.json` com pid vivo **e** `/api/health` respondendo pelo mesmo
   `repoRoot` canônico) e o reutiliza; só no silêncio sobe `agentic serve -C <projectDir>` (o diretório que contém
   `.agentic/project.yaml`; a identidade continua sendo o `repoRoot` canônico).
   Se duas janelas correm, a que perde vê o `serve` sair com 0 ("já há dono") e adota o
   vencedor. Projetos diferentes têm donos independentes.

3. **Stop é ordem graciosa com prova.** Filho desta janela: SIGTERM e espera pela **saída**
   do processo. Dono externo: SIGTERM ao pid publicado e espera pelo **silêncio** da
   descoberta. Prazo vencido não vira `STOPPED`: vira `FAILED`, com o processo mantido, e
   `stop` de novo tenta outra vez (I15). `kill -9` não é fluxo da extensão.

4. **Restart é stop provado e depois start**, serializado numa fila; `start`/`stop`
   concorrentes compartilham a mesma operação.

5. **A webview não tem rede.** CSP sem `connect-src`; tudo passa por `postMessage` ao
   extension host, que é quem fala com o control plane. Isso prepara Remote SSH, WSL e Dev
   Containers, onde o `localhost` da webview não é o do control plane.

6. **O extension host não é o Node do projeto.** O control plane nasce num `node` >= 22
   real (configuração, `PATH`, nvm), porque o driver SQLite é nativo. A CLI é a do
   repositório aberto (`apps/cli/bin/agentic.mjs`), a de `node_modules/.bin` ou a do `PATH`.

7. **O filho recebe uma allowlist de ambiente, nunca `process.env`.** O extension host herda
   a sessão do usuário, e ali pode haver token ou chave de API; nada disso é injetado no
   control plane (P17). Só o operacional passa (`PATH`, `HOME`, locale, proxy, certificados);
   a lista é fechada — um passthrough configurável seria a porta de volta do token.

8. **A webview só abre caminhos autorizados**: dentro do `repoRoot`, do diretório de
   configuração ou publicados pelo host (worktrees das tentativas), comparados após
   `realpath` (symlink não escapa). Diff só sobre `path`/refs que o host publicou, e refs
   nunca começam com `-` (nada vira opção do git). O payload de cada mensagem é validado
   por inteiro, sem chaves extras.

9. **Ações nativas sobre dados existentes.** Abrir arquivo/pasta e diff (`git show` dos dois
   lados num `TextDocumentContentProvider`) usam o editor; nada de editor próprio.

## Alternativas rejeitadas

- **Rodar o orquestrador dentro do extension host.** Amarra o core ao ciclo de vida do
  editor e ao Node do Electron; fere a independência do core e a posse por processo.
- **Endpoint HTTP de shutdown.** Qualquer processo local poderia derrubar o control plane;
  o sinal ao pid publicado, com prova pelo silêncio, é o mesmo caminho do Ctrl+C.
- **Reaproveitar o dashboard inteiro na webview (na MVP-001).** `apps/web` roteava por
  `window.location` e chamava `/api` relativo; a primeira fatia reaproveitou só as projeções
  puras. **Revisto na MVP-002**: o dashboard ganhou três costuras — transporte injetável,
  navegação em memória e um contexto de ações de editor — e passou a rodar inteiro na
  webview atrás da ponte (ver adendo abaixo).

## Consequências

- Nova fronteira no lint: `vscode: ['schemas', 'server', 'web']`, todos como `import type`
  (ou projeção pura), e o teste de bundle é a prova.
- Só Linux/macOS na primeira versão (SIGTERM).
- Multi-root: a primeira pasta com `.agentic/project.yaml` é o projeto da janela.
- A dívida conhecida da 004B (cancelamento humano com gate/integração em voo) aparece na
  extensão como `Stop` → `FAILED` com o processo mantido — visível, não escondida.

## Adendo (DA-VSCODE-MVP-002) — o dashboard inteiro atrás da ponte

O `App` de `apps/web` é o mesmo no navegador e na aba do editor. O que muda é injetado:

- **Transporte.** `setApiTransport` troca o `fetch` relativo por mensagens `api` à ponte; o
  host executa contra o control plane do projeto detectado, com o header de guarda do
  `repoRoot`, e devolve status e corpo. Só `/missions/plan` ganha prazo longo (15 min).
- **Stream.** O host abre o SSE (`fetch` em stream, parser próprio) e repassa evento a
  evento; a webview vê um `EventSourceLike`. Reconexão com cursor continua sendo do hook.
- **Navegação.** `navigation: 'memory'`: a rota (Home / Mission / Run) vive no host, que a
  usa para o título da aba e para a sidebar navegar.
- **Ações de editor.** `EditorActionsContext`: abrir arquivo/worktree/log e diff nativo.
  A autorização continua a do host: `repoRoot`, `projectDir` e as worktrees que o próprio
  control plane devolveu em respostas de detalhe de task.
- **Portão.** Sem control plane no ar não há dashboard: a webview mostra o estado do serviço
  e o botão Start (mesmo `lifecycle` do host).

Nada do core entrou no bundle da webview além do contrato (`@agentic/schemas` e seu
`@agentic/domain` puro, como já ocorre no dashboard do navegador).
