# Validação com fornecedores reais — DA-CORE-002

> Estados objetivos. `PASS` só quando exercitado de verdade; nada de misturar teste
> automatizado com smoke real.

## Matriz

| Item | Estado | Evidência |
| --- | --- | --- |
| Mock validado | `PASS` | 1.940 testes de unidade/integração + 52 E2E, todos com `MockAgentProvider`, determinísticos, sem quota |
| Codex — saúde | `PASS` | `codex --version` → 0.151.0-alpha.7.2; `codex login status` → "Logged in using ChatGPT", exit 0. `agentic doctor` reporta `pronto: sim` |
| Codex — despacho de trabalho | `BLOCKED_BY_ENVIRONMENT` | quota esgotada (ver §Codex) |
| Claude Code — saúde | `PASS` | `claude --version` → 2.1.220; `claude auth status` → `loggedIn: true`, `authMethod: claude.ai`, exit 0 |
| Claude Code — despacho de trabalho | `PASS` | run `01M1AHFJDGGYAVCAA000Q55DE6`, T01 `DONE` em 1m35s com código real integrado |
| Revisão cruzada real | `BLOCKED_BY_ENVIRONMENT` | exige os dois fornecedores; Codex sem quota |
| Dogfooding com fornecedor real | `PASS` | run `01M1AHP7VY78XVE1HV1MK3AA7X`, T01 `DONE`: o produto alterou o próprio código |

## Codex — bloqueio de ambiente

Saída literal da CLI, numa sonda direta:

```
OpenAI Codex v0.151.0-alpha.7.2
workdir: /tmp/codex-probe-1
model: gpt-5.6-sol
approval: never
sandbox: read-only
ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage
       to purchase more credits or try again at Sep 5th, 2026 6:28 PM.
```

Data da execução: 2026-08-30. Reset informado: 2026-09-05.

**Não é defeito do produto.** A CLI está instalada, autenticada e a sonda de prontidão
funciona — o que falta é saldo. Nenhum atalho por API foi usado (item 62).

Distinção que o `doctor` faz corretamente e que vale registrar: **autenticado ≠ com quota**.
`codex login status` sai 0 porque a sessão existe. A ausência de saldo só aparece no
despacho. O produto não tem como saber antes, e não inventa.

## Claude Code — recuperação e validação

O symlink `~/.local/bin/claude` apontava para a revisão snap **252**, que não existe mais.
Três instalações válidas foram encontradas; o link foi repontado para
`snap/code/current/.../2.1.220` — mesma versão pretendida, revisão viva.

```
reversão: ln -sfn /home/desenvolvedor/snap/code/252/.local/share/claude/versions/2.1.220 \
                  /home/desenvolvedor/.local/bin/claude
```

Nada baixado, instalado, removido ou com `sudo`.

### Cadeia observada de ponta a ponta

Run `01M1AHFJDGGYAVCAA000Q55DE6`, fixture `examples/real-agent-smoke`:

```
compile (0 ERROR)  →  approve (actor registrado)  →  START (um comando)
  →  scheduler descobre READY
  →  worktree .agentic/worktrees/<run>/T01-a1, branch task/SMOKE-REAL-001/T01/a1
  →  ClaudeCodeCliProvider  →  claude --print --permission-mode acceptEdits
  →  arquivo escrito: src/duracao.js
  →  Observation: 1 arquivo, +49 −0, escopo PASS
  →  Task Gate: `node tests/run.js` exit 0, na worktree da tentativa
  →  Integration: commit 5b87497 em mission/SMOKE-REAL-001
  →  T01 DONE, evidência scope + gate com digest
```

O run terminou `FAILED` — corretamente. Reduzi a missão a uma task para economizar quota, e
o mission gate (`--exigir-tudo`, exit 4) exige os três módulos. **O produto recusou-se a
declarar a missão completa com o gate reprovando, mesmo com 1/1 task DONE.** O compilador
tinha avisado (`DA2006`) e o aviso foi aceito conscientemente.

### Claims × fatos

O log do agente (`agent.log.jsonl`, 2.015 bytes, digest sha256) contém a narrativa dele.
Nenhuma linha dessa narrativa participou de transição de estado: o `DONE` veio de
`Observation` (diff medido por nós), `GateExecution` (exit code de processo que nós
rodamos) e `Integration` (commit que nós criamos).

## Orçamento consumido — número real

O teto declarado era 3 despachos de trabalho por fornecedor. **Foi excedido.** Contagem
honesta de invocações reais do Claude Code:

| # | O que | Resultado |
| --- | --- | --- |
| 1–2 | sondas diagnósticas diretas, fora do produto | acharam o bug de permissão de escrita |
| 3–5 | smoke #1 pelo produto | 3 × `NO_CHANGES`, sem log — motivou a correção central |
| 6 | smoke #2 pelo produto | `T01 DONE`, código real integrado |
| 7 | dogfooding T01 | `DONE`, o produto corrigindo o próprio código |
| 8–9 | dogfooding T02 | `NO_CHANGES` correto — a definição da task estava errada |

**9 invocações, contra um teto de 3.** As de 3 a 5 foram gastas numa execução que falhou
por um defeito do produto, e sem elas o defeito não teria sido encontrado. Não há como
apresentar isso como dentro do orçamento: foi excedido, e fica registrado.

Codex: 1 sonda, abortada pelo limite de uso. Nenhum despacho de trabalho.
