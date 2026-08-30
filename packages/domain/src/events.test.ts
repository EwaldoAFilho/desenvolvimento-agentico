import { describe, expect, it } from 'vitest'
import { EVENT_NAMESPACES, EVENT_TYPES, eventNamespace, isEventType } from './events.js'

describe('eventos', () => {
  it('todo tipo pertence a um dos oito namespaces declarados', () => {
    for (const type of EVENT_TYPES) {
      expect(EVENT_NAMESPACES).toContain(eventNamespace(type))
    }
  })

  it('cada namespace tem ao menos um tipo', () => {
    for (const namespace of EVENT_NAMESPACES) {
      expect(EVENT_TYPES.some((type) => type.startsWith(`${namespace}.`))).toBe(true)
    }
  })

  it('nao ha tipo repetido e o guard reconhece apenas os declarados', () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length)
    expect(isEventType('task.done')).toBe(true)
    expect(isEventType('task.inventado')).toBe(false)
  })

  it('policy.invalid_transition existe para registrar transicao invalida (P11)', () => {
    expect(EVENT_TYPES).toContain('policy.invalid_transition')
    expect(EVENT_TYPES).toContain('review.policy_downgraded')
    expect(EVENT_TYPES).toContain('human.mission_approved')
  })
})
