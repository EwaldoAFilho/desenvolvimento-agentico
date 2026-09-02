// Roda DENTRO do extension host do VS Code de teste. Sem mocha: uma sequencia de passos com
// asserts, que e a jornada da missao — Activity Bar, projeto detectado, Start, status,
// providers, missions, webview, restart, stop — medida pela API da extensao, nao por
// screenshot.
const assert = require('node:assert/strict')
const vscode = require('vscode')

const EXTENSION_ID = 'desenvolvimento-agentico.desenvolvimento-agentico-vscode'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function until(label, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`)
    await sleep(250)
  }
}

const steps = []
function step(name, fn) {
  steps.push({ name, fn })
}

step('extensao instalada e ativada', async (ctx) => {
  const extension = vscode.extensions.getExtension(EXTENSION_ID)
  assert.ok(extension, `extensao ${EXTENSION_ID} nao encontrada`)
  ctx.api = await extension.activate()
  assert.ok(ctx.api?.host, 'activate nao devolveu a API')
  const pkg = extension.packageJSON
  assert.equal(pkg.contributes.viewsContainers.activitybar[0].id, 'agentic', 'Activity Bar Agentic')
  assert.deepEqual(
    pkg.contributes.views.agentic.map((v) => v.id),
    ['agentic.status', 'agentic.missions'],
  )
})

step('comandos registrados', async () => {
  const commands = await vscode.commands.getCommands(true)
  for (const id of [
    'agentic.start',
    'agentic.stop',
    'agentic.restart',
    'agentic.open',
    'agentic.refresh',
    'agentic.openMission',
    'agentic.showLog',
  ]) {
    assert.ok(commands.includes(id), `comando ausente: ${id}`)
  }
})

step('projeto detectado automaticamente', async (ctx) => {
  const project = await until('deteccao do projeto', () => ctx.api.host.project, 15_000)
  assert.ok(project.repoRoot.length > 0)
  assert.ok(project.git.repository, 'repositorio git detectado')
  assert.ok(typeof project.git.branch === 'string', 'branch detectada')
  ctx.project = project
})

step('Start Agentic: control plane no ar sem terminal', async (ctx) => {
  await vscode.commands.executeCommand('agentic.start')
  const view = await until(
    'RUNNING',
    () => (ctx.api.host.view()?.state === 'RUNNING' ? ctx.api.host.view() : undefined),
    90_000,
  )
  assert.ok(view.live?.url.startsWith('http://'), 'endereco descoberto')
  ctx.firstPid = view.live?.pid
})

step('status, providers e missions lidos do control plane', async (ctx) => {
  const data = await until(
    'providers',
    () => (ctx.api.host.data.providers ? ctx.api.host.data : undefined),
    60_000,
  )
  assert.ok(data.providers.length > 0, 'ao menos um provider')
  for (const provider of data.providers) {
    assert.ok(['boolean', 'string'].includes(typeof provider.ready))
  }
  assert.ok(Array.isArray(data.runs), 'runs apurados')
  assert.ok(data.missions.length > 0, 'ao menos uma mission listada')
  assert.ok(
    data.missions.every((m) => m.runsKnown),
    'runs conhecidos com o control plane no ar',
  )
  ctx.mission = data.missions[0]
})

step('Open Agentic abre o painel e a mission selecionada tem detalhes', async (ctx) => {
  await vscode.commands.executeCommand('agentic.open')
  await vscode.commands.executeCommand('agentic.openMission', ctx.mission.file)
  const detail = await ctx.api.host.missionDetail(ctx.mission.file)
  assert.equal(detail.summary.file, ctx.mission.file)
  assert.ok(Array.isArray(detail.runs))
})

step('Restart Agentic: novo dono, nunca dois', async (ctx) => {
  await vscode.commands.executeCommand('agentic.restart')
  const view = await until(
    'RUNNING apos restart',
    () => (ctx.api.host.view()?.state === 'RUNNING' ? ctx.api.host.view() : undefined),
    120_000,
  )
  if (ctx.firstPid !== undefined && view.live?.pid !== undefined) {
    assert.notEqual(view.live.pid, ctx.firstPid, 'restart trocou o processo')
  }
})

step('Stop Agentic: Stopped so com prova', async (ctx) => {
  await vscode.commands.executeCommand('agentic.stop')
  const view = await until(
    'STOPPED',
    () => (ctx.api.host.view()?.state === 'STOPPED' ? ctx.api.host.view() : undefined),
    120_000,
  )
  assert.equal(view.live, undefined)
})

async function run() {
  const ctx = {}
  const results = []
  for (const { name, fn } of steps) {
    try {
      await fn(ctx)
      results.push(`PASS ${name}`)
    } catch (error) {
      results.push(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
      console.log(results.join('\n'))
      throw error
    }
  }
  console.log(results.join('\n'))
}

module.exports = { run }
