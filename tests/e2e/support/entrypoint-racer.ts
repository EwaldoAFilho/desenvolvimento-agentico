/**
 * Competidor da corrida de posse que chega pelo ENTRYPOINT de verdade.
 *
 * O `lock-racer` prova a exclusividade do primitivo: N processos pedindo a MESMA chave, um
 * vencedor. Este aqui prova a outra metade, que e a de 003B: dois entrypoints diferentes
 * CHEGAM a mesma chave. Cada um percorre o caminho do seu pacote, sem atalho:
 *
 * - `cli`    -> `loadProjectContext` de `@agentic/cli` (o que `mission start` e
 *              `mission approve` usam para disputar a posse);
 * - `server` -> `loadProjectSources` de `@agentic/server` (o que `startServer` usa, e o que
 *              o binario `agentic-server` faz sem nunca ver a CLI).
 *
 * Se as duas contas divergirem, a rodada termina com DOIS vencedores — que e exatamente o
 * defeito medido antes desta fatia, com `project.repoRoot` apontando para fora.
 *
 * Reporta `WIN <dir>` ou `LOSE <dir> <code>`: o diretorio faz parte do veredito, porque
 * "dois vencedores" e "um vencedor em cada diretorio" sao a mesma falha.
 */
import nodeProcess from 'node:process'
import { defaultDeps, loadProjectContext } from '@agentic/cli'
import { acquireControlPlaneOwnership } from '@agentic/persistence'
import { loadProjectSources } from '@agentic/server'

const [, , projectDirArg, entrypoint] = nodeProcess.argv
const at = Number(nodeProcess.argv[4] ?? '0')
if (projectDirArg === undefined || entrypoint === undefined) {
  throw new Error('uso: entrypoint-racer.ts <projectDir> <cli|server> <instanteMs>')
}
const projectDir = projectDirArg

async function runtimeDirDoEntrypoint(): Promise<string> {
  if (entrypoint === 'server') {
    const sources = await loadProjectSources({ repoRoot: projectDir })
    return sources.runtimeDir
  }
  // Dependencias REAIS da CLI, so com o diretorio de trabalho apontado para o projeto —
  // exatamente o que `agentic mission approve` recebe quando roda ali dentro.
  const context = await loadProjectContext({ ...defaultDeps(), cwd: projectDir })
  return context.runtimeDir
}

const baseDir = await runtimeDirDoEntrypoint()

while (Date.now() < at) {
  /* espera ativa: a disputa precisa ser simultanea de verdade */
}

const outcome = acquireControlPlaneOwnership({ baseDir })
if (outcome.ok) {
  nodeProcess.stdout.write(`WIN ${outcome.lease.ownedDir}\n`)
  /**
   * O vencedor segura a posse ate o pai mandar sair.
   *
   * Soltar por temporizador tornava o veredito dependente do tempo de PARTIDA dos
   * competidores: sob carga (a suite E2E inteira em paralelo), um processo que chega depois
   * do vencedor ja ter soltado ganha legitimamente, e a rodada aparece com "dois
   * vencedores" sem nunca ter havido dois donos ao mesmo tempo. Segurando ate o fim da
   * rodada, o que a contagem mede e o que interessa: quantos donos coexistiram.
   */
  await new Promise<void>((resolve) => {
    // O `setInterval` nao e enfeite: um processo que so registra tratador de sinal NAO fica
    // vivo — o handle de sinal do Node nao segura o event loop. Sem este temporizador o
    // vencedor saia na hora, soltando a posse, e o competidor seguinte ganhava
    // legitimamente: a rodada terminava com "oito vencedores" sem nunca ter havido dois
    // donos ao mesmo tempo. Medido, e corrigido aqui.
    const batimento = setInterval(() => undefined, 60_000)
    const encerrar = (): void => {
      clearInterval(batimento)
      resolve()
    }
    nodeProcess.once('SIGTERM', encerrar)
    nodeProcess.once('SIGINT', encerrar)
  })
  outcome.lease.release()
} else {
  nodeProcess.stdout.write(`LOSE ${outcome.ownedDir} ${outcome.code}\n`)
}
