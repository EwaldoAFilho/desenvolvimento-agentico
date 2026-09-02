/**
 * Regra de dependencia entre camadas (ADR-0001, ARCHITECTURE.md secao 2).
 *
 *   interfaces  ->  application  ->  domain  <-  adapters
 *
 * Cada pacote declara exatamente o que pode importar. Nao ha heranca implicita:
 * o que nao esta listado e violacao.
 */
export const ALLOWED = {
  domain: [],
  graph: [],
  process: [],
  schemas: ['domain'],
  persistence: ['domain'],
  workspace: ['domain'],
  'agent-runtime': ['domain', 'process'],
  gates: ['domain', 'schemas', 'process'],
  compiler: ['domain', 'schemas', 'graph'],
  providers: ['domain', 'schemas', 'agent-runtime'],
  orchestrator: [
    'domain',
    'schemas',
    'graph',
    'compiler',
    'persistence',
    'gates',
    'workspace',
    'providers',
    // ADR-0014 (004B): quem decide o encerramento precisa de UM fato de sistema operacional —
    // "este grupo de processos ainda existe?" — para sondar de novo um residuo cujo handle ja
    // nao esta a mao (gate, workspaceSetup). A sonda vive em `process`, o unico lugar com
    // codigo de SO; o orquestrador a chama, nao a reimplementa.
    'process',
  ],
  cli: [
    'domain',
    'schemas',
    'graph',
    'compiler',
    'persistence',
    'gates',
    'workspace',
    'providers',
    'orchestrator',
    'agent-runtime',
    'process',
    // ARCHITECTURE 4: `agentic serve` sobe o control plane. cli -> server e dependencia
    // entre interfaces, sem ciclo (server nao conhece cli) e sem tocar o dominio.
    'server',
  ],
  server: ['domain', 'schemas', 'compiler', 'persistence', 'orchestrator', 'graph'],
  web: ['schemas'],
  // DA-VSCODE-MVP-001: a extensao e CLIENTE do control plane. Ela pode conhecer o CONTRATO
  // (tipos dos DTOs em `schemas` e do servidor) e nada mais; `extensions/vscode/src/**`
  // importa esses pacotes apenas como `import type`, e o teste de bundle prova que nenhum
  // codigo do core entra em `dist/extension.js`.
  vscode: ['schemas', 'server', 'web'],
}

/** Pacotes que precisam ser puros: nenhum modulo de plataforma. */
export const NO_NODE_BUILTINS = ['domain', 'graph', 'schemas', 'compiler']

/**
 * P18 — o dominio nao pode citar fornecedor, CLI ou organizacao.
 * Verificado como texto: se o nome aparece, a fronteira vazou.
 */
export const NO_VENDOR_NAMES = ['domain', 'graph', 'compiler', 'orchestrator']
export const VENDOR_WORDS = ['claude', 'codex', 'anthropic', 'openai', 'gemini', 'copilot']
