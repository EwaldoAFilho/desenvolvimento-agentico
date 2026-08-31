import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nodeProcess from 'node:process'
import { PLAN_BLOCK_BEGIN, PLAN_BLOCK_END } from '../planner.js'

/**
 * Planejadores de mentira, por script. Nenhum teste toca CLI real de fornecedor e nenhum
 * consome quota de assinatura: o adapter de planejamento e validado contra estes dubles
 * (missao DA-UX-001, U05).
 */
export const PLANNER_PROMPT_FILE = 'planner-prompt.txt'
export const PLANNER_ARGV_FILE = 'planner-argv.txt'
export const PLANNER_ENV_FILE = 'planner-env.txt'
export const PLANNER_CWD_FILE = 'planner-cwd.txt'
export const PLANNER_FAKE_VERSION = '9.9.9'

export const PLANNER_RATIONALE = 'duas tasks porque contrato e uso nascem juntos'

/** Plano que passa no contrato: o mesmo do arquivo de missao, menos apiVersion e kind. */
export const VALID_PLAN = {
  id: 'DA-EXEMPLO-001',
  title: 'Exemplo de missao proposta por planejador',
  objective: 'Provar que a porta de planejamento devolve proposta validada',
  description: 'Missao de fixture: existe para exercitar o contrato, nao para ser executada',
  scope: ['Contrato da proposta'],
  outOfScope: ['Qualquer execucao de verdade'],
  constraints: ['Nenhuma API key; somente CLI local ja autenticada'],
  acceptanceCriteria: ['A proposta atravessa o contrato do plano sem remendo'],
  defaults: { requireReview: true, maxAttempts: 3, gate: 'unit' },
  phases: [{ id: 'contrato', title: 'Contrato' }],
  tasks: [
    {
      id: 'T01',
      phase: 'contrato',
      title: 'Declarar o contrato',
      objective: 'Escrever o contrato que o resto usa',
      dependencies: [],
      touches: ['packages/exemplo/src/contrato.ts'],
      validation: ['o contrato recusa entrada invalida com motivo legivel'],
      risk: 'medium',
      estimate: 2,
    },
    {
      id: 'T02',
      phase: 'contrato',
      title: 'Usar o contrato',
      objective: 'Consumir o contrato declarado na task anterior',
      dependencies: ['T01'],
      touches: ['packages/exemplo/src/uso.ts'],
      validation: ['a suite continua verde'],
      risk: 'low',
      estimate: 1,
    },
  ],
}

/** Mesmo plano, com um campo a mais: chave desconhecida reprova o plano inteiro. */
export const PLAN_WITH_API_VERSION = { apiVersion: 'agentic/v1', kind: 'Mission', ...VALID_PLAN }

/** Dois defeitos de contrato: id de task fora do padrao e criterio de aceite vazio. */
export const INVALID_PLAN = {
  ...VALID_PLAN,
  acceptanceCriteria: [],
  tasks: [
    {
      id: 'primeira-task',
      phase: 'contrato',
      title: 'Task com id fora do padrao',
      objective: 'Falhar no contrato de proposito',
      dependencies: [],
      risk: 'medium',
      estimate: 1,
    },
  ],
}

export const VALID_PLAN_JSON = JSON.stringify(VALID_PLAN)

export function envelopeAround(plan: unknown, rationale = PLANNER_RATIONALE): string {
  return JSON.stringify({ rationale, plan })
}

export function planBlock(payload: string): string {
  return `${PLAN_BLOCK_BEGIN}\n${payload}\n${PLAN_BLOCK_END}`
}

const CHATTER_BEFORE = [
  'lendo o projeto em modo de leitura...',
  'nenhum arquivo foi alterado',
]
const CHATTER_AFTER = ['pronto. o control plane decide o que fazer com a proposta.']

/** Saida completa de um planejador conversador que acerta o formato. */
export const GOOD_OUTPUT = [
  ...CHATTER_BEFORE,
  planBlock(envelopeAround(VALID_PLAN)),
  ...CHATTER_AFTER,
].join('\n')

const NOISE_LINE = 'A'.repeat(999)
const NOISE_LINES = 2_000

function heredoc(name: string, body: string): string {
  return `cat <<'${name}'\n${body}\n${name}\n`
}

function script(readiness: string, body: string): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "planejador-falso ${PLANNER_FAKE_VERSION}"
  exit 0
fi
# As CLIs reais perguntam prontidao com verbos diferentes; o duble atende os dois.
if { [ "$1" = "login" ] || [ "$1" = "auth" ]; } && [ "$2" = "status" ]; then
${readiness}
fi
ultimo=""
for arg in "$@"; do ultimo="$arg"; done
# Captura fora da raiz de leitura quando o teste pede: assim da para observar argv, prompt
# e ambiente sem que o processo do planejador escreva onde ele nao pode escrever.
if [ -n "$CAPTURA" ]; then
  printf '%s' "$ultimo" > "$CAPTURA/${PLANNER_PROMPT_FILE}"
  printf '%s\\n' "$@" > "$CAPTURA/${PLANNER_ARGV_FILE}"
  env > "$CAPTURA/${PLANNER_ENV_FILE}"
  pwd > "$CAPTURA/${PLANNER_CWD_FILE}"
else
  env > ${PLANNER_ENV_FILE}
fi
${body}
`
}

const READY = '  exit 0'
const NOT_READY = '  echo "sessao nao autenticada" >&2\n  exit 1'

const CHATTER_ECHO = CHATTER_BEFORE.map((line) => `echo "${line}"`).join('\n')

const MODES: Readonly<Record<string, string>> = {
  /** Bloco marcado, com envelope e conversa em volta. */
  plano: script(READY, `${CHATTER_ECHO}\n${heredoc('PLANO', planBlock(envelopeAround(VALID_PLAN)))}exit 0`),
  /** Bloco marcado com o plano cru, sem envelope: rationale ausente, plano valido. */
  'plano-cru': script(READY, `${heredoc('PLANO', planBlock(VALID_PLAN_JSON))}exit 0`),
  /** Sem marcadores: so um bloco cercado por crases, como uma CLI conversadora faz. */
  cercado: script(READY, `${heredoc('PLANO', `\`\`\`json\n${VALID_PLAN_JSON}\n\`\`\``)}exit 0`),
  /** Ecoa o prompt recebido (que contem o MODELO do bloco) e so depois responde. */
  eco: script(READY, `printf '%s\\n' "$ultimo"\n${heredoc('PLANO', planBlock(envelopeAround(VALID_PLAN)))}exit 0`),
  /** Plano que fere o contrato: a recusa precisa dizer onde. */
  invalido: script(READY, `${heredoc('PLANO', planBlock(JSON.stringify(INVALID_PLAN)))}exit 0`),
  /** Declara apiVersion e kind: escolher a versao do formato nao e do planejador. */
  versionado: script(
    READY,
    `${heredoc('PLANO', planBlock(JSON.stringify(PLAN_WITH_API_VERSION)))}exit 0`,
  ),
  /** Conversa e termina bem, sem nada que se pareca com plano. */
  'sem-plano': script(READY, `${CHATTER_ECHO}\necho "nao consegui propor nada"\nexit 0`),
  falha: script(READY, 'echo "o planejador quebrou" >&2\nexit 3'),
  lento: script(READY, 'sleep 30\nexit 0'),
  /** ~2 MB de conversa antes do plano: nao pode travar nem sumir com o plano. */
  volumoso: script(
    READY,
    `i=0\nwhile [ $i -lt ${NOISE_LINES} ]; do\n  echo "${NOISE_LINE}"\n  i=$((i+1))\ndone\n${heredoc('PLANO', planBlock(envelopeAround(VALID_PLAN)))}exit 0`,
  ),
  'sem-login': script(NOT_READY, `${heredoc('PLANO', planBlock(envelopeAround(VALID_PLAN)))}exit 0`),
}

export interface FakePlannerBundle {
  readonly dir: string
  readonly plano: string
  readonly planoCru: string
  readonly cercado: string
  readonly eco: string
  readonly invalido: string
  readonly versionado: string
  readonly semPlano: string
  readonly falha: string
  readonly lento: string
  readonly volumoso: string
  readonly semLogin: string
  /** Caminho absoluto que nao existe: planejador indisponivel. */
  readonly ausente: string
  /** PATH so para os utilitarios do proprio script. Sem credencial. */
  readonly env: Readonly<Record<string, string>>
  cleanup(): void
}

export function makeTempDir(prefix = 'agentic-planner-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

export function makeFakePlannerCli(): FakePlannerBundle {
  const dir = makeTempDir('agentic-fake-planner-')
  for (const [mode, source] of Object.entries(MODES)) {
    const path = join(dir, `planejador-${mode}`)
    writeFileSync(path, source, { mode: 0o755 })
    chmodSync(path, 0o755)
  }
  return {
    dir,
    plano: join(dir, 'planejador-plano'),
    planoCru: join(dir, 'planejador-plano-cru'),
    cercado: join(dir, 'planejador-cercado'),
    eco: join(dir, 'planejador-eco'),
    invalido: join(dir, 'planejador-invalido'),
    versionado: join(dir, 'planejador-versionado'),
    semPlano: join(dir, 'planejador-sem-plano'),
    falha: join(dir, 'planejador-falha'),
    lento: join(dir, 'planejador-lento'),
    volumoso: join(dir, 'planejador-volumoso'),
    semLogin: join(dir, 'planejador-sem-login'),
    ausente: join(dir, 'planejador-que-nao-existe'),
    env: { PATH: nodeProcess.env.PATH ?? '/usr/bin:/bin' },
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
