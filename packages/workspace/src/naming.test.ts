import { describe, expect, it } from 'vitest'
import {
  attemptDirName,
  attemptWorktreePath,
  missionBranchName,
  resolveAttemptNumber,
  slugifyBranch,
  taskBranchName,
} from './naming.js'

describe('naming', () => {
  it('deriva a branch da missao com o prefixo padrao', () => {
    expect(missionBranchName('DA-CORE-001')).toBe('mission/DA-CORE-001')
  })

  it('respeita prefixo configurado para a branch da missao', () => {
    expect(missionBranchName('DA-CORE-001', 'entrega/')).toBe('entrega/DA-CORE-001')
  })

  it('nomeia a branch por tentativa', () => {
    expect(taskBranchName('DA-CORE-001', 'T08', 2)).toBe('task/DA-CORE-001/T08/a2')
  })

  it('nomeia o diretorio da tentativa', () => {
    expect(attemptDirName('T08', 3)).toBe('T08-a3')
  })

  it('monta o caminho <worktreeRoot>/<runId>/<taskId>-a<N>', () => {
    expect(attemptWorktreePath('/tmp/wt', 'RUN1', 'T08', 1)).toBe('/tmp/wt/RUN1/T08-a1')
  })

  it('usa o numero de tentativa explicito quando informado', () => {
    expect(resolveAttemptNumber(4, 'qualquer')).toBe(4)
  })

  it('cai no sufixo do attemptId quando o numero nao vem', () => {
    expect(resolveAttemptNumber(undefined, 'RUN:T08:a3')).toBe(3)
  })

  it('assume a primeira tentativa quando nada identifica o numero', () => {
    expect(resolveAttemptNumber(undefined, 'opaco')).toBe(1)
    expect(resolveAttemptNumber(0, 'opaco')).toBe(1)
  })

  it('nao confunde id opaco terminado em digito com numero de tentativa', () => {
    expect(resolveAttemptNumber(undefined, '01JBXQ7T9K4M2N8P6R3S5V7W92')).toBe(1)
  })

  it('transforma nome de branch em nome de diretorio', () => {
    expect(slugifyBranch('task/DA-CORE-001/T08/a1')).toBe('task-DA-CORE-001-T08-a1')
  })
})
