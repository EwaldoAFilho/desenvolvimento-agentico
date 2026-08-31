import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { EVIDENCE_DIR } from './handoff.js'

/**
 * Screenshot de evidencia.
 *
 * Ela documenta; quem PROVA e a assercao ao lado. Por isso o conjunto e pequeno e fixo —
 * uma imagem por momento que um humano de fato quer rever (missao pronta, run andando,
 * detalhe da task, missao concluida, painel de providers). Dezenas de imagens sem leitor
 * seriam custo de manutencao disfarcado de rigor.
 *
 * Grava FORA do repositorio (`EVIDENCE_DIR`, em tmp): rodar a suite nao pode sujar o
 * working tree de quem esta no meio de uma missao.
 */
export interface Shootable {
  screenshot(options: { readonly path: string }): Promise<Buffer>
}

export async function evidence(target: Shootable, name: string): Promise<string> {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  const path = join(EVIDENCE_DIR, `${name}.png`)
  await target.screenshot({ path })
  return path
}
