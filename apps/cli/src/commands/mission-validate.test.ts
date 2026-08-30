import { afterEach, describe, expect, it } from 'vitest'
import {
  captureDeps,
  createWorkspace,
  MISSION_WITH_ERROR,
  MISSION_WITH_WARNING,
  type Workspace,
} from '../__fixtures__/harness.js'
import { EXIT_ERROR, EXIT_OK } from '../result.js'
import { missionValidateCommand } from './mission-validate.js'

let workspace: Workspace | undefined

afterEach(async () => {
  await workspace?.cleanup()
  workspace = undefined
})

describe('mission validate', () => {
  it('sai 0 quando a missao nao tem ERROR', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({ cwd: workspace.dir })
    const result = await missionValidateCommand({ file: workspace.missionPath }, captured.deps)

    expect(result.exitCode).toBe(EXIT_OK)
    expect(captured.stdout()).toContain('nenhum diagnostico')
    expect(captured.stdout()).toContain('ok: 3 tasks')
    expect(captured.stdout()).toContain('0 ERROR')
  })

  it('sai 1 e mostra o diagnostico quando ha ERROR', async () => {
    workspace = await createWorkspace({ mission: MISSION_WITH_ERROR })
    const captured = captureDeps({ cwd: workspace.dir })
    const result = await missionValidateCommand({ file: workspace.missionPath }, captured.deps)

    expect(result.exitCode).toBe(EXIT_ERROR)
    expect(result.error?.code).toBe('VALIDATION_FAILED')
    expect(captured.stdout()).toContain('DA1003')
    expect(captured.stdout()).toContain('ERROR')
    expect(captured.stdout()).toContain('T99')
  })

  it('imprime linha e coluna do diagnostico localizavel', async () => {
    workspace = await createWorkspace({ mission: MISSION_WITH_ERROR })
    const captured = captureDeps({ cwd: workspace.dir })
    await missionValidateCommand({ file: workspace.missionPath }, captured.deps)

    expect(captured.stdout()).toMatch(/\(linha \d+, coluna \d+\)/)
  })

  it('WARNING nao reprova: sai 0 com o aviso visivel', async () => {
    workspace = await createWorkspace({ mission: MISSION_WITH_WARNING })
    const captured = captureDeps({ cwd: workspace.dir })
    const result = await missionValidateCommand({ file: workspace.missionPath }, captured.deps)

    expect(result.exitCode).toBe(EXIT_OK)
    expect(captured.stdout()).toContain('DA2005')
    expect(captured.stdout()).toContain('1 WARNING')
  })

  it('--json emite o envelope estavel com o CompileReportDto', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({ cwd: workspace.dir })
    const result = await missionValidateCommand(
      { file: workspace.missionPath, json: true },
      captured.deps,
    )

    expect(result.exitCode).toBe(EXIT_OK)
    expect(captured.stdout()).toBe('')
    expect(result.data).toMatchObject({
      missionId: 'TESTE-001',
      ok: true,
      diagnostics: [],
      stats: { tasks: 3, phases: 2, errors: 0, warnings: 0, infos: 0 },
    })
    expect(result.data).toHaveProperty('specHash')
  })

  it('--json com ERROR mantem o report na carga util', async () => {
    workspace = await createWorkspace({ mission: MISSION_WITH_ERROR })
    const captured = captureDeps({ cwd: workspace.dir })
    const result = await missionValidateCommand(
      { file: workspace.missionPath, json: true },
      captured.deps,
    )

    expect(result.exitCode).toBe(EXIT_ERROR)
    expect(result.data).toMatchObject({ ok: false })
    const data = result.data as { readonly diagnostics: readonly { readonly code: string }[] }
    expect(data.diagnostics.map((item) => item.code)).toContain('DA1003')
  })

  it('arquivo de missao inexistente vira erro com mensagem, nao excecao', async () => {
    workspace = await createWorkspace()
    const captured = captureDeps({ cwd: workspace.dir })
    await expect(
      missionValidateCommand({ file: 'nao-existe.yaml' }, captured.deps),
    ).rejects.toThrow(/arquivo nao encontrado/)
  })

  it('projeto sem .agentic e recusado com instrucao de init', async () => {
    const captured = captureDeps({ cwd: '/' })
    await expect(missionValidateCommand({ file: 'x.yaml' }, captured.deps)).rejects.toThrow(
      /agentic init/,
    )
  })
})
