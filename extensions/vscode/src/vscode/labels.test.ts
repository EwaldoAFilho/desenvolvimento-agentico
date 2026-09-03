import { PROVIDER_STATES, type ProviderHealthDto, providerStateOf } from '@agentic/schemas'
import { describe, expect, it } from 'vitest'
import type { BlockageDto } from '../core/contracts.js'
import { providerIcon, providerStateLabel, taskTooltip } from './labels.js'

/**
 * A extensao e CLIENTE: o bundle nao carrega o core (`src/bundle.test.ts`), entao a
 * derivacao dos cinco estados de fornecedor e uma COPIA. Este teste roda em Node, nao no
 * editor, e por isso PODE importar o contrato — e e ele que impede a copia de divergir.
 *
 * A divergencia nao e hipotetica: a tabela anterior tinha quatro rotulos e mostrava
 * `UNKNOWN` onde a CLI e o dashboard mostram `INSTALLED`.
 */
const TRISTATE = [true, false, 'unknown'] as const

function dto(
  installed: (typeof TRISTATE)[number],
  ready: (typeof TRISTATE)[number],
): ProviderHealthDto {
  return {
    providerId: 'fornecedor' as ProviderHealthDto['providerId'],
    installed,
    ready,
    version: 'unknown',
    detail: '',
    running: 0,
    capacity: null,
  }
}

describe('sidebar: os cinco estados do contrato', () => {
  it('a tabela copiada concorda com a derivacao canonica em TODA combinacao', () => {
    for (const installed of TRISTATE) {
      for (const ready of TRISTATE) {
        const health = dto(installed, ready)
        expect(providerStateLabel(health), `installed=${installed} ready=${ready}`).toBe(
          providerStateOf(health),
        )
      }
    }
  })

  it('os cinco estados sao alcancaveis, e nenhum rotulo paralelo sobrou', () => {
    const alcancados = new Set(
      TRISTATE.flatMap((installed) =>
        TRISTATE.map((ready) => providerStateLabel(dto(installed, ready))),
      ),
    )
    expect([...alcancados].sort()).toEqual([...PROVIDER_STATES].sort())
  })

  it('INSTALLED nao e READY e nao e falha: prontidao apenas nao apurada', () => {
    // O caso exato que a sidebar errava: instalado, sonda de sessao nao conclusiva.
    expect(providerStateLabel(dto(true, 'unknown'))).toBe('INSTALLED')
    expect(providerIcon('INSTALLED')).not.toBe(providerIcon('READY'))
    expect(providerIcon('INSTALLED')).not.toBe(providerIcon('NOT_INSTALLED'))
  })

  it('cada estado tem icone proprio: verde so em READY', () => {
    const icones = PROVIDER_STATES.map((state) => providerIcon(state))
    expect(new Set(icones).size).toBe(PROVIDER_STATES.length)
    expect(providerIcon('READY')).toBe('check')
  })
})

describe('sidebar: falha de execucao nao vira estado de fornecedor', () => {
  const blockage: BlockageDto = {
    kind: 'POLICY',
    reason: 'SIMULATED_REVIEWER_ONLY',
    raisedBy: 'orchestrator',
    raisedAt: '2026-09-03T00:00:00.000Z',
    needs: 'um fornecedor real declarado como revisor',
  }

  it('o motivo do bloqueio aparece NA TASK, com o conserto', () => {
    const tooltip = taskTooltip('Contrato compartilhado', blockage)
    expect(tooltip).toContain('SIMULATED_REVIEWER_ONLY')
    expect(tooltip).toContain('precisa de: um fornecedor real declarado como revisor')
  })

  it('sem bloqueio o tooltip continua sendo so o titulo', () => {
    expect(taskTooltip('Contrato compartilhado', undefined)).toBe('Contrato compartilhado')
    expect(taskTooltip('', undefined)).toBeUndefined()
  })

  it('um fornecedor READY continua READY mesmo com task bloqueada', () => {
    // Estado global e resultado de tentativa sao coisas separadas: a sidebar le a saude do
    // fornecedor da sonda, e o motivo da parada, do bloqueio da task.
    expect(providerStateLabel(dto(true, true))).toBe('READY')
  })
})
