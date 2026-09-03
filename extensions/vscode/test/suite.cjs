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

async function until(label, predicate, timeoutMs, ctx) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) {
      const view = ctx?.api?.host?.view()
      throw new Error(
        `timeout: ${label}${view === undefined ? '' : ` — estado: ${JSON.stringify(view)}`}`,
      )
    }
    await sleep(250)
  }
}

/** Rotulos das abas abertas; a aba da webview aparece de forma assincrona, entao quem checa espera. */
function tabLabels() {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.label))
}
async function untilTab(predicate, label) {
  return until(label, () => (tabLabels().some(predicate) ? true : undefined), 10_000)
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
    ['agentic.status', 'agentic.missions', 'agentic.activeRun'],
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
    ctx,
  )
  assert.ok(view.live?.url.startsWith('http://'), 'endereco descoberto')
  ctx.firstPid = view.live?.pid
})

step('status, providers e missions lidos do control plane', async (ctx) => {
  const data = await until(
    'providers',
    () => (ctx.api.host.data.providers ? ctx.api.host.data : undefined),
    60_000,
    ctx,
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

step('Open Mission abre a aba na rota da mission selecionada', async (ctx) => {
  await vscode.commands.executeCommand('agentic.openMission', ctx.mission.file)
  await untilTab(
    (label) => label.includes(ctx.mission.id),
    `aba na rota da mission ${ctx.mission.id}`,
  )
})

step('Open Agentic abre a aba do dashboard; New Mission muda a rota', async () => {
  await vscode.commands.executeCommand('agentic.open')
  await untilTab((label) => label.startsWith('Agentic'), 'aba Agentic')
  await vscode.commands.executeCommand('agentic.newMission')
  await untilTab((label) => label.includes('nova mission'), 'aba na rota nova mission')
})

step(
  'aprovar e iniciar a mission de exemplo pelo control plane; Active Run mostra o run',
  async (ctx) => {
    if (process.env.AGENTIC_IT_SKIP_RUN === '1') return
    const client = ctx.api.host.client()
    assert.ok(client, 'cliente do control plane')
    const mission = ctx.api.host.data.missions.find((m) => m.id === 'EXEMPLO-001') ?? ctx.mission
    const approved = await client.post(
      `/api/missions/${encodeURIComponent(mission.file)}/approve`,
      {
        actor: 'integracao@vscode',
        note: 'jornada do MVP-002',
      },
    )
    assert.ok(approved.runId, 'aprovacao devolve runId')
    const started = await client.post('/api/runs', {
      missionId: mission.id,
      acceptWarnings: true,
      actor: 'integracao@vscode',
    })
    assert.equal(started.runId, approved.runId, 'um clique, um run: start reutiliza o run aprovado')
    ctx.runId = started.runId
    await vscode.commands.executeCommand('agentic.refresh')
    const active = await until(
      'run ativo na sidebar',
      () => ctx.api.host.data.runs?.find((run) => run.id === ctx.runId),
      30_000,
      ctx,
    )
    assert.ok(
      ['RUNNING', 'PAUSED', 'VERIFYING', 'BLOCKED', 'COMPLETED', 'FAILED'].includes(active.status),
    )
    await vscode.commands.executeCommand('agentic.openRun', ctx.runId)
    await untilTab((label) => label.includes('run …'), 'aba na rota do run')
    // Os gates do template (`npm run lint/test`) nao existem num repositorio vazio: o run
    // ficaria em retry ate esgotar tentativas. O que a extensao prova aqui e o run ATIVO
    // visivel e a aba na rota; a partir dai ele e cancelado pelo control plane.
    await client
      .post(`/api/runs/${encodeURIComponent(ctx.runId)}/stop`, { actor: 'integracao@vscode' })
      .catch(() => undefined)
    const final = await until(
      'run cancelado',
      async () => {
        await vscode.commands.executeCommand('agentic.refresh')
        const run = ctx.api.host.data.runs?.find((r) => r.id === ctx.runId)
        return run !== undefined && ['CANCELLED', 'COMPLETED', 'FAILED'].includes(run.status)
          ? run
          : undefined
      },
      90_000,
      ctx,
    )
    assert.ok(
      ['CANCELLED', 'COMPLETED', 'FAILED'].includes(final.status),
      `run terminou em ${final.status}`,
    )
  },
)

step('Restart Agentic: novo dono, nunca dois', async (ctx) => {
  await vscode.commands.executeCommand('agentic.restart')
  const view = await until(
    'RUNNING apos restart',
    () => (ctx.api.host.view()?.state === 'RUNNING' ? ctx.api.host.view() : undefined),
    120_000,
    ctx,
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
    ctx,
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
