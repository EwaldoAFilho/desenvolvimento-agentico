import { describe, expect, it } from 'vitest'
import { isWorkspaceBusyError, toFailureReason, WorkspaceError } from './errors.js'
import { Mutex, WriteGate } from './lease.js'

describe('WriteGate', () => {
  it('concede o primeiro lease imediatamente', async () => {
    const gate = new WriteGate()
    await gate.acquire()
    expect(gate.held).toBe(true)
  })

  it('faz o segundo lease esperar ate a liberacao', async () => {
    const gate = new WriteGate()
    await gate.acquire()
    let concedido = false
    const second = gate.acquire('wait').then(() => {
      concedido = true
    })
    await Promise.resolve()
    expect(concedido).toBe(false)
    expect(gate.waiting).toBe(1)
    gate.release()
    await second
    expect(concedido).toBe(true)
  })

  it('recusa explicitamente quando a politica e fail', async () => {
    const gate = new WriteGate()
    await gate.acquire()
    await expect(gate.acquire('fail')).rejects.toSatisfy(isWorkspaceBusyError)
  })

  it('expira a espera quando o timeout vence', async () => {
    const gate = new WriteGate()
    await gate.acquire()
    await expect(gate.acquire('wait', 10)).rejects.toSatisfy(isWorkspaceBusyError)
    expect(gate.waiting).toBe(0)
  })

  it('libera para a fila na ordem de chegada', async () => {
    const gate = new WriteGate()
    await gate.acquire()
    const order: number[] = []
    const a = gate.acquire('wait').then(() => order.push(1))
    const b = gate.acquire('wait').then(() => order.push(2))
    gate.release()
    await a
    gate.release()
    await b
    expect(order).toEqual([1, 2])
  })
})

describe('Mutex', () => {
  it('serializa execucoes concorrentes', async () => {
    const mutex = new Mutex()
    const order: string[] = []
    const slow = mutex.run(async () => {
      order.push('inicio-a')
      await new Promise((resolve) => setTimeout(resolve, 15))
      order.push('fim-a')
    })
    const fast = mutex.run(async () => {
      order.push('inicio-b')
    })
    await Promise.all([slow, fast])
    expect(order).toEqual(['inicio-a', 'fim-a', 'inicio-b'])
  })

  it('nao trava a fila quando uma execucao falha', async () => {
    const mutex = new Mutex()
    await expect(mutex.run(() => Promise.reject(new Error('x')))).rejects.toThrow('x')
    await expect(mutex.run(() => Promise.resolve('ok'))).resolves.toBe('ok')
  })
})

describe('WorkspaceError', () => {
  it('traduz qualquer falha para WORKSPACE_ERROR', () => {
    const error = new WorkspaceError('setup', 'falhou', { detail: 'npm ci' })
    expect(error.toFailureReason()).toEqual({ code: 'WORKSPACE_ERROR', detail: 'falhou: npm ci' })
    expect(toFailureReason(new Error('bruto')).code).toBe('WORKSPACE_ERROR')
  })
})
