#!/usr/bin/env node
/**
 * Partida em ambiente limpo.
 *
 * Reproduz a primeira experiencia de quem instala o produto: copia o repositorio sem
 * nenhum artefato local, instala do zero, compila e exercita os ENTRYPOINTS OFICIAIS —
 * `apps/cli/bin/agentic.mjs`. Nenhum modulo TypeScript interno substitui a entrada
 * publicada: o que se prova aqui e exatamente o que o usuario digita.
 *
 * Passos:
 *   1. guarda de engine: `.npmrc` com `engine-strict=true`
 *   2. copia do repositorio sem node_modules, dist, .git e .agentic/state.db
 *   3. (opcional) prova que Node incompativel e recusado — CLEAN_START_LEGACY_NODE
 *   4. `npm ci`
 *   5. `npm run build`
 *   6. `node apps/cli/bin/agentic.mjs doctor` (humano + --json)
 *   7. `node apps/cli/bin/agentic.mjs serve --port <livre>` e GET /api/health
 *   8. derruba tudo
 *
 * LENTO por natureza (instalacao + compilacao). NAO entra em `npm run verify`.
 * Ver README.md deste diretorio para o comando e as variaveis de ambiente.
 */
import { spawn } from 'node:child_process'
import { cp, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const CLI_ENTRYPOINT = 'apps/cli/bin/agentic.mjs'

/** Diretorios que sao artefato local, nunca fonte. Nenhum deles pode ir para a copia. */
const SKIP_NAMES = new Set(['node_modules', 'dist', 'coverage', '.git', '.vitest'])
/** Estado local do control plane: a copia comeca sem historia. */
const SKIP_PREFIXES = ['.agentic/state.db', '.agentic/runs', '.agentic/worktrees']
const SKIP_SUFFIXES = ['.tsbuildinfo', '.log']
/** Configuracao local de maquina. `.env.example` e fonte versionada; o resto, nao. */
const isLocalEnv = (name) => /^\.env(\..+)?$/.test(name) && name !== '.env.example'

const KEEP = process.env.CLEAN_START_KEEP === '1'
const VERBOSE = process.env.CLEAN_START_VERBOSE === '1'
const LEGACY_NODE = process.env.CLEAN_START_LEGACY_NODE

class StepError extends Error {}

function fail(message) {
  throw new StepError(message)
}

function check(condition, message) {
  if (!condition) fail(message)
}

function log(text = '') {
  process.stdout.write(`${text}\n`)
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`
}

function tail(text, lines = 20) {
  const all = text.trimEnd().split('\n')
  return all.slice(Math.max(0, all.length - lines)).join('\n')
}

/** Executa um comando e devolve o resultado inteiro. Nunca lanca por codigo de saida. */
function run(file, args, options) {
  const { cwd, timeoutMs = 600_000, env = process.env } = options
  return new Promise((done) => {
    const started = Date.now()
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (VERBOSE) process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (VERBOSE) process.stderr.write(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      done({
        code: -1,
        stdout,
        stderr: `${stderr}${error.message}`,
        timedOut,
        ms: Date.now() - started,
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code: code ?? -1, stdout, stderr, timedOut, ms: Date.now() - started })
    })
  })
}

/** Falha com o rabo da saida quando o comando nao sai 0 — erro sem contexto nao ajuda. */
function requireSuccess(result, what) {
  if (result.timedOut) fail(`${what}: estourou o tempo limite`)
  if (result.code !== 0) {
    fail(
      `${what}: saiu ${result.code}\n--- stdout ---\n${tail(result.stdout)}\n--- stderr ---\n${tail(result.stderr)}`,
    )
  }
}

function keepEntry(source) {
  const rel = relative(REPO_ROOT, source)
  if (rel === '') return true
  const parts = rel.split(sep)
  if (parts.some((part) => SKIP_NAMES.has(part))) return false
  if (parts.some(isLocalEnv)) return false
  const path = parts.join('/')
  if (
    SKIP_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}-`),
    )
  ) {
    return false
  }
  return !SKIP_SUFFIXES.some((suffix) => path.endsWith(suffix))
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Porta livre de verdade: o SO escolhe e devolve. Nunca reusar a porta do projeto — */
/** um control plane alheio no ar responderia `health` e o teste passaria por engano. */
function freePort() {
  return new Promise((done, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => done(port))
    })
  })
}

async function stepEngineGuard() {
  const npmrc = await readFile(`${REPO_ROOT}/.npmrc`, 'utf8').catch(() => undefined)
  check(npmrc !== undefined, '.npmrc ausente: sem ele o npm instala sob Node incompativel')
  check(
    /^\s*engine-strict\s*=\s*true\s*$/m.test(npmrc),
    '.npmrc sem `engine-strict=true`: a instalacao voltaria a aceitar Node fora de `engines`',
  )
  const manifest = JSON.parse(await readFile(`${REPO_ROOT}/package.json`, 'utf8'))
  const declared = manifest.engines?.node
  check(typeof declared === 'string', 'package.json sem `engines.node`: nao ha o que o npm exigir')
  log(`      .npmrc exige engines.node ${declared} · rodando node ${process.versions.node}`)
}

async function stepCopy(workdir) {
  await cp(REPO_ROOT, workdir, { recursive: true, filter: (source) => keepEntry(source) })
  for (const forbidden of ['node_modules', 'dist', '.git', '.agentic/state.db']) {
    check(
      !(await exists(`${workdir}/${forbidden}`)),
      `a copia levou ${forbidden}: nao e ambiente limpo`,
    )
  }
  check(await exists(`${workdir}/package-lock.json`), 'a copia ficou sem package-lock.json')
  check(await exists(`${workdir}/${CLI_ENTRYPOINT}`), `a copia ficou sem ${CLI_ENTRYPOINT}`)
  // `git clone` entrega um repositorio; a copia nao. `git init` devolve o que o usuario
  // realmente tem — sem a historia, que e justamente o que nao queremos carregar.
  requireSuccess(
    await run('git', ['init', '-q', '.'], { cwd: workdir, timeoutMs: 60_000 }),
    'git init',
  )
}

/** `.npmrc` so vale se recusar de verdade. Opt-in: exige um Node antigo instalado. */
async function stepLegacyNodeRefused(workdir) {
  const binDir = basename(LEGACY_NODE) === 'node' ? dirname(LEGACY_NODE) : LEGACY_NODE
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` }
  const version = await run('node', ['-v'], { cwd: workdir, env, timeoutMs: 60_000 })
  requireSuccess(version, `node antigo em ${binDir}`)
  const legacy = version.stdout.trim()
  const result = await run('npm', ['ci'], { cwd: workdir, env, timeoutMs: 600_000 })
  const output = `${result.stdout}${result.stderr}`
  check(result.code !== 0, `npm ci aceitou ${legacy}: engine-strict nao esta valendo`)
  check(
    output.includes('EBADENGINE'),
    `npm ci sob ${legacy} falhou sem citar EBADENGINE:\n${tail(output)}`,
  )
  check(
    output.includes('Required'),
    `a recusa sob ${legacy} nao citou o \`engines\` exigido:\n${tail(output)}`,
  )
  check(
    !(await exists(`${workdir}/node_modules`)),
    `npm ci sob ${legacy} recusou mas ja tinha instalado: a falha nao foi cedo`,
  )
  log(`      ${legacy} recusado com EBADENGINE antes de instalar qualquer coisa`)
}

async function stepInstall(workdir) {
  const result = await run('npm', ['ci'], { cwd: workdir, timeoutMs: 900_000 })
  requireSuccess(result, 'npm ci')
  check(await exists(`${workdir}/node_modules`), 'npm ci saiu 0 sem criar node_modules')
}

async function stepBuild(workdir) {
  requireSuccess(
    await run('npm', ['run', 'build'], { cwd: workdir, timeoutMs: 900_000 }),
    'npm run build',
  )
  check(
    await exists(`${workdir}/apps/cli/dist/index.js`),
    'build nao produziu apps/cli/dist/index.js',
  )
}

/**
 * O `doctor` e a primeira coisa que alguem roda depois de instalar. Exigir 0 aqui
 * amarraria o teste as CLIs de agente instaladas na maquina; o que a partida limpa tem
 * de garantir e a cadeia de ferramentas: Node, projeto, git e — o canario de tudo — o
 * modulo nativo do banco, que so responde `state.running` se carregou.
 */
async function stepDoctor(workdir) {
  const human = await run('node', [CLI_ENTRYPOINT, 'doctor'], { cwd: workdir, timeoutMs: 300_000 })
  check(!human.timedOut, 'doctor nao respondeu dentro do tempo limite')
  check(
    human.stdout.includes('doctor ·'),
    `doctor nao imprimiu diagnostico:\n${tail(human.stdout)}\n${tail(human.stderr)}`,
  )

  const json = await run('node', [CLI_ENTRYPOINT, 'doctor', '--json'], {
    cwd: workdir,
    timeoutMs: 300_000,
  })
  check(!json.timedOut, 'doctor --json nao respondeu dentro do tempo limite')
  let envelope
  try {
    envelope = JSON.parse(json.stdout)
  } catch {
    fail(`doctor --json nao devolveu JSON:\n${tail(json.stdout)}\n${tail(json.stderr)}`)
  }
  check(envelope.command === 'doctor', `envelope de outro comando: ${envelope.command}`)
  const checks = envelope.data?.checks
  check(Array.isArray(checks) && checks.length > 0, 'doctor respondeu sem nenhum check')
  const statusOf = (id) => checks.find((entry) => entry.id === id)
  const detailOf = (id) => statusOf(id)?.detail ?? '(check ausente)'
  for (const id of [
    'node.version',
    'project.files',
    'git.installed',
    'git.repository',
    'state.running',
  ]) {
    const entry = statusOf(id)
    check(entry !== undefined, `doctor nao verificou ${id}`)
    check(entry.status === 'ok', `ambiente limpo reprovou em ${id}: ${entry.detail}`)
  }
  const mock = statusOf('provider.mock')
  check(
    mock !== undefined && mock.status === 'ok',
    `fornecedor in-process indisponivel: ${detailOf('provider.mock')}`,
  )

  const problems = checks.filter((entry) => entry.status !== 'ok')
  log(`      ${detailOf('node.version')}`)
  log(`      ${detailOf('state.running')} — o modulo nativo do banco carregou`)
  if (problems.length > 0) {
    log(
      `      ${problems.length} check(s) fora de \`ok\` — dependem das CLIs desta maquina, nao da partida:`,
    )
    for (const entry of problems) log(`        [${entry.status}] ${entry.id}: ${entry.detail}`)
  }
  return human.stdout
}

async function stepServe(workdir) {
  const port = await freePort()
  const child = spawn('node', [CLI_ENTRYPOINT, 'serve', '--port', String(port)], {
    cwd: workdir,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
    if (VERBOSE) process.stdout.write(chunk)
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
    if (VERBOSE) process.stderr.write(chunk)
  })
  let exit
  child.on('close', (code, signal) => {
    exit = { code, signal }
  })

  try {
    const deadline = Date.now() + 90_000
    let body
    while (body === undefined) {
      if (exit !== undefined) fail(`serve morreu antes de responder:\n${tail(output)}`)
      if (Date.now() > deadline) fail(`/api/health nao respondeu em 90s:\n${tail(output)}`)
      // So a recusa de conexao autoriza tentar de novo. Resposta ruim e resposta: falha.
      let response
      try {
        response = await fetch(`http://127.0.0.1:${port}/api/health`)
      } catch {
        await new Promise((wait) => setTimeout(wait, 250))
        continue
      }
      check(response.status === 200, `/api/health respondeu ${response.status}`)
      body = await response.json()
    }
    check(body.status === 'ok', `/api/health respondeu status ${body.status}`)
    check(body.service === '@agentic/server', `/api/health veio de outro servico: ${body.service}`)
    // Prova que respondeu o servidor DESTA copia, e nao um control plane alheio na maquina.
    check(
      (await realpath(body.repoRoot)) === (await realpath(workdir)),
      `/api/health respondeu por outro repoRoot: ${body.repoRoot}`,
    )
    log(
      `      GET http://127.0.0.1:${port}/api/health -> 200 ${JSON.stringify(body.status)} · ${body.service}`,
    )
  } finally {
    if (exit === undefined) {
      child.kill('SIGTERM')
      const deadline = Date.now() + 15_000
      while (exit === undefined && Date.now() < deadline) {
        await new Promise((wait) => setTimeout(wait, 100))
      }
      if (exit === undefined) child.kill('SIGKILL')
    }
  }
  check(exit !== undefined, 'serve nao encerrou com SIGTERM')
  check(exit.code === 0, `serve encerrou mal: codigo ${exit.code} sinal ${exit.signal}`)
  log('      SIGTERM encerrou o control plane com codigo 0')
}

async function main() {
  const base = process.env.CLEAN_START_DIR ?? tmpdir()
  const workdir = await mkdtemp(`${resolve(base)}${sep}agentic-clean-start-`)
  const steps = [
    ['guarda de engine (.npmrc)', () => stepEngineGuard()],
    ['copia limpa do repositorio', () => stepCopy(workdir)],
    ...(LEGACY_NODE === undefined
      ? []
      : [['Node antigo recusado', () => stepLegacyNodeRefused(workdir)]]),
    ['npm ci', () => stepInstall(workdir)],
    ['npm run build', () => stepBuild(workdir)],
    [`node ${CLI_ENTRYPOINT} doctor`, () => stepDoctor(workdir)],
    [`node ${CLI_ENTRYPOINT} serve + GET /api/health`, () => stepServe(workdir)],
  ]

  log('partida em ambiente limpo')
  log(`  repositorio  ${REPO_ROOT}`)
  log(`  copia        ${workdir}`)
  log(`  node ${process.versions.node}`)
  if (LEGACY_NODE === undefined) {
    log('  (defina CLEAN_START_LEGACY_NODE=<bin de um Node antigo> para provar a recusa do npm)')
  }
  log()

  let doctorOutput
  const started = Date.now()
  try {
    for (const [index, [name, action]] of steps.entries()) {
      log(`[${index + 1}/${steps.length}] ${name}`)
      const at = Date.now()
      const produced = await action()
      if (typeof produced === 'string') doctorOutput = produced
      log(`      ok em ${seconds(Date.now() - at)}`)
    }
  } catch (error) {
    log()
    log(`FALHOU: ${error instanceof Error ? error.message : String(error)}`)
    log()
    log(`copia preservada para inspecao: ${workdir}`)
    process.exitCode = 1
    return
  } finally {
    if (!KEEP && process.exitCode !== 1) await rm(workdir, { recursive: true, force: true })
  }

  if (doctorOutput !== undefined) {
    log()
    log('--- saida real do `doctor` no ambiente limpo -------------------------------')
    log(doctorOutput.trimEnd())
    log('---------------------------------------------------------------------------')
  }
  log()
  log(`partida limpa ok em ${seconds(Date.now() - started)}`)
}

await main()
