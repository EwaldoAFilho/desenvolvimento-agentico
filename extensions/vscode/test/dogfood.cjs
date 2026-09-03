// Dogfooding REAL dentro de um VS Code de verdade, sobre o proprio repositorio do produto:
// Nova Mission com planner real -> DRAFT -> aba com o DAG -> aprovar -> executar -> acompanhar
// -> DONE. Dirigido pelo extension host, pelo MESMO cliente HTTP que a ponte da webview usa
// (as telas React sao as de apps/web, cobertas pelos testes do dashboard). Consome assinatura:
// so roda quando pedido (AGENTIC_IT_DOGFOOD=1), e a mission e pequena de proposito.
const assert = require('node:assert/strict')
const vscode = require('vscode')

const EXTENSION_ID = 'desenvolvimento-agentico.desenvolvimento-agentico-vscode'
const PROMPT =
  process.env.AGENTIC_DOGFOOD_PROMPT ??
  'Atualize o arquivo extensions/vscode/CHANGELOG.md adicionando, na secao 0.2.0-alpha.1, um item ' +
    'de lista dizendo que a jornada Nova Mission -> DAG -> aprovacao -> Run foi exercitada por dogfooding ' +
    'real dentro do VS Code sobre o proprio repositorio. Uma unica task, so documentacao, sem tocar em ' +
    'codigo nem em testes. Risco baixo.'
const PLANNER = process.env.AGENTIC_DOGFOOD_PLANNER ?? 'claude-code'
const ACTOR = process.env.AGENTIC_DOGFOOD_ACTOR ?? 'dogfood@vscode'
const STOP_BEFORE_RUN = process.env.AGENTIC_DOGFOOD_STOP_BEFORE_RUN === '1'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
async function until(label, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`)
    await sleep(1_000)
  }
}
function tabLabels() {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.label))
}
const log = (line) => console.log(`[dogfood] ${new Date().toISOString()} ${line}`)

async function run() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID)
  assert.ok(extension, 'extensao ausente')
  const api = await extension.activate()
  const host = api.host
  await until('projeto', () => host.project, 15_000)
  log(`projeto ${host.project.name} em ${host.project.repoRoot}`)

  await vscode.commands.executeCommand('agentic.start')
  await until('RUNNING', () => host.view()?.state === 'RUNNING', 120_000)
  const client = host.client()
  assert.ok(client, 'cliente')
  log(`control plane em ${client.baseUrl}`)

  const planners = await client.get('/api/planners')
  log(`planners: ${JSON.stringify(planners)}`)
  const planner = planners.find((p) => p.providerId === PLANNER)
  assert.ok(planner, `planner ${PLANNER} ausente`)
  assert.equal(planner.state, 'READY', `planner ${PLANNER} nao esta READY: ${planner.state}`)

  await vscode.commands.executeCommand('agentic.newMission')
  await until('aba nova mission', () => tabLabels().some((l) => l.includes('nova mission')), 10_000)

  log('planejando (chamada longa ao control plane)…')
  const startedAt = Date.now()
  const planned = await client.raw(
    'POST',
    '/missions/plan',
    JSON.stringify({ prompt: PROMPT, plannerId: PLANNER, acceptsSubscriptionUse: true, actor: ACTOR }),
    15 * 60_000,
  )
  log(`plan: HTTP ${planned.status} em ${Math.round((Date.now() - startedAt) / 1000)}s`)
  assert.ok(planned.ok, `planejamento recusado: ${planned.text.slice(0, 800)}`)
  const result = JSON.parse(planned.text)
  log(`mission ${result.missionId} em ${result.file}; run ${result.run.id} ${result.run.status}; tasks=${result.report.stats.tasks}; erros=${result.report.stats.errors}; revisoes=${result.revisions}`)
  assert.equal(result.run.status, 'DRAFT')
  assert.equal(result.report.ok, true)

  await vscode.commands.executeCommand('agentic.refresh')
  await until('mission listada', () => host.data.missions.find((m) => m.id === result.missionId), 30_000)
  await vscode.commands.executeCommand('agentic.openMission', result.file)
  await until('aba da mission', () => tabLabels().some((l) => l.includes(result.missionId)), 10_000)
  log('DRAFT visivel na aba (rota da mission)')

  if (STOP_BEFORE_RUN) {
    log('parando ANTES da execucao (AGENTIC_DOGFOOD_STOP_BEFORE_RUN=1)')
    await vscode.commands.executeCommand('agentic.stop')
    await until('STOPPED', () => host.view()?.state === 'STOPPED', 120_000)
    return
  }

  const approved = await client.post(`/api/missions/${encodeURIComponent(result.file)}/approve`, {
    actor: ACTOR,
    note: 'dogfooding DA-VSCODE-MVP-002',
    specHash: result.report.specHash,
  })
  assert.equal(approved.runId, result.run.id, 'aprovacao vale para o run DRAFT do plano inspecionado')
  const started = await client.post('/api/runs', { missionId: result.missionId, acceptWarnings: true, actor: ACTOR })
  assert.equal(started.runId, result.run.id, 'um clique, um run')
  log(`run ${started.runId} iniciado`)
  await vscode.commands.executeCommand('agentic.openRun', started.runId)
  await until('aba do run', () => tabLabels().some((l) => l.includes('run …')), 10_000)

  let last = ''
  const final = await until(
    'run terminal',
    async () => {
      const snapshot = await client.snapshot(started.runId)
      const line = `${snapshot.run.status} · ${snapshot.tasks.map((t) => `${t.id}:${t.status}`).join(' ')}`
      if (line !== last) {
        last = line
        log(line)
      }
      return ['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(snapshot.run.status) ? snapshot : undefined
    },
    50 * 60_000,
  )
  log(`run terminou em ${final.run.status}`)
  assert.equal(final.run.status, 'COMPLETED', `run terminou em ${final.run.status}`)

  await vscode.commands.executeCommand('agentic.stop')
  await until('STOPPED', () => host.view()?.state === 'STOPPED', 180_000)
  log('control plane encerrado')
}

module.exports = { run }
