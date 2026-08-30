import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TASK_STATUSES, type TaskStatus, taskStatusStyle } from '../lib/status.js'
import { TaskNodeCard, type TaskNodeData } from './TaskNode.js'

function data(status: TaskStatus): TaskNodeData {
  return {
    taskId: 'T04',
    title: 'Endpoint de gravação',
    phase: 'backend',
    status,
    attempt: 2,
    maxAttempts: 3,
    onCriticalPath: true,
    picked: false,
  }
}

describe('linguagem visual dos 12 estados', () => {
  it('o contrato tem exatamente 12 estados de task', () => {
    expect(TASK_STATUSES).toHaveLength(12)
  })

  it('icone e rotulo sao distintos entre todos os estados', () => {
    const icons = new Set(TASK_STATUSES.map((status) => taskStatusStyle(status).icon))
    const labels = new Set(TASK_STATUSES.map((status) => taskStatusStyle(status).label))
    expect(icons.size).toBe(12)
    expect(labels.size).toBe(12)
  })

  // Sem consultar cor: so texto e aria-label. Um daltonico e uma captura em P&B funcionam.
  for (const status of TASK_STATUSES) {
    it(`${status} rende com icone e rotulo textual`, () => {
      const style = taskStatusStyle(status)
      const view = render(<TaskNodeCard data={data(status)} />)
      expect(screen.getByText(style.label)).toBeTruthy()
      const card = screen.getByTestId('task-node-T04')
      expect(card.querySelector('.task-node__icon')?.textContent).toBe(style.icon)
      expect(card.getAttribute('aria-label')).toContain(`estado ${style.label}`)
      expect(card.getAttribute('aria-label')).toContain('fase backend')
      view.unmount()
    })
  }

  it('mostra id, titulo e tentativa N/M', () => {
    render(<TaskNodeCard data={data('RUNNING')} />)
    expect(screen.getByText('T04')).toBeTruthy()
    expect(screen.getByText('Endpoint de gravação')).toBeTruthy()
    expect(screen.getByText('2/3')).toBeTruthy()
  })

  it('o icone e escondido do leitor de tela — o rotulo e que informa', () => {
    render(<TaskNodeCard data={data('BLOCKED')} />)
    expect(screen.getByText('⊘').getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByText('BLOCKED').getAttribute('aria-hidden')).toBeNull()
  })
})
