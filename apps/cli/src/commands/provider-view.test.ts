import type { ProviderHealthDto } from '@agentic/schemas'
import { describe, expect, it } from 'vitest'
import { MASK, sanitize } from '../redact.js'
import {
  PROVIDER_STATES,
  type ProviderState,
  providerStateOf,
  providerViewOf,
  renderProviderView,
} from './provider-view.js'

function dto(partial: Partial<ProviderHealthDto>): ProviderHealthDto {
  return {
    providerId: 'cli-local' as ProviderHealthDto['providerId'],
    installed: 'unknown',
    ready: 'unknown',
    version: 'unknown',
    detail: '',
    running: 0,
    capacity: 2,
    ...partial,
  }
}

/** O symlink quebrado que realmente aconteceu: link presente, instalacao ausente. */
const BROKEN = dto({
  installed: false,
  ready: false,
  detail: 'instalacao: symlink quebrado',
  readinessSource: 'prontidao false por ausencia do executavel',
  diagnostic: {
    kind: 'broken-symlink',
    detail:
      '"cli" e um symlink quebrado: /home/u/.local/bin/cli aponta para /snap/versions/2.1.220',
    target: '/snap/versions/2.1.220',
    remediation:
      'recrie o link para uma instalacao existente (`ln -sfn <caminho-real> /home/u/.local/bin/cli`)',
  },
})

describe('os cinco estados de provider', () => {
  it('READY: instalado e sonda de sessao aprovou', () => {
    expect(providerStateOf(dto({ installed: true, ready: true }))).toBe('READY')
  })

  it('NOT_READY: instalado, mas a sonda reprovou', () => {
    expect(providerStateOf(dto({ installed: true, ready: false }))).toBe('NOT_READY')
  })

  it('INSTALLED: instalado com prontidao NAO apurada — nunca confundido com READY', () => {
    expect(providerStateOf(dto({ installed: true, ready: 'unknown' }))).toBe('INSTALLED')
  })

  it('NOT_INSTALLED: sem executavel', () => {
    expect(providerStateOf(dto({ installed: false, ready: false }))).toBe('NOT_INSTALLED')
  })

  it('UNKNOWN: nem a instalacao foi apurada', () => {
    expect(providerStateOf(dto({ installed: 'unknown', ready: 'unknown' }))).toBe('UNKNOWN')
  })

  it('os cinco sao alcancaveis e distintos: nenhuma combinacao cai em dois', () => {
    const combos: ProviderHealthDto[] = [
      dto({ installed: true, ready: true }),
      dto({ installed: true, ready: false }),
      dto({ installed: true, ready: 'unknown' }),
      dto({ installed: false, ready: false }),
      dto({ installed: 'unknown', ready: 'unknown' }),
    ]
    const states = combos.map(providerStateOf)
    expect(new Set(states).size).toBe(PROVIDER_STATES.length)
    for (const state of states) expect(PROVIDER_STATES).toContain(state as ProviderState)
  })

  it('NOT_INSTALLED ganha de tudo: sem binario nao ha prontidao a discutir', () => {
    expect(providerStateOf(dto({ installed: false, ready: true }))).toBe('NOT_INSTALLED')
  })
})

describe('bloco do provider', () => {
  it('mostra os nove fatos: estado, executavel, caminho, versao, pronto, origem, em voo, capacidade', () => {
    const view = providerViewOf({
      health: dto({
        installed: true,
        ready: 'unknown',
        version: '2.1.4',
        capacity: 3,
        resolvedPath: '/usr/local/bin/cli',
        readinessSource: 'a CLI nao expoe verificacao de sessao',
      }),
      executable: 'cli',
      running: 2,
    })
    const text = renderProviderView(view).join('\n')

    expect(text).toContain('INSTALLED')
    expect(text).toContain('cli-local')
    expect(text).toContain('/usr/local/bin/cli')
    expect(text).toContain('2.1.4')
    expect(text).toContain('origem: a CLI nao expoe verificacao de sessao')
    expect(text).toContain('em voo         2 · capacidade 3')
  })

  it('symlink quebrado mostra alvo inexistente E o conserto', () => {
    const view = providerViewOf({ health: BROKEN, executable: 'cli' })
    const text = renderProviderView(view).join('\n')

    expect(text).toContain('NOT_INSTALLED')
    expect(text).toContain('instalado      nao')
    expect(text).toContain('[broken-symlink]')
    expect(text).toContain('/snap/versions/2.1.220 (nao existe)')
    expect(text).toContain('conserto')
    expect(text).toContain('ln -sfn')
  })

  it('sem apuracao de agentes em voo o campo sai `unknown`, nao zero', () => {
    const view = providerViewOf({ health: dto({}) })
    expect(view.running).toBe('unknown')
    expect(renderProviderView(view).join('\n')).toContain('em voo         unknown')
  })

  it('caminho nao resolvido continua `unknown` — nao vira caminho inventado', () => {
    const view = providerViewOf({ health: dto({ installed: 'unknown' }) })
    expect(view.resolvedPath).toBe('unknown')
    expect(view.readinessSource).toBe('unknown')
  })

  it('capacidade nula sai como `sem teto`', () => {
    const view = providerViewOf({ health: dto({ capacity: null }) })
    expect(renderProviderView(view).join('\n')).toContain('capacidade sem teto')
  })

  it('provider in-process sem `command` declara isso em vez de mentir um executavel', () => {
    const view = providerViewOf({ health: dto({}) })
    expect(view.executable).toBe('(in-process)')
  })
})

describe('nada de segredo, e-mail ou organizacao na saida', () => {
  it('e-mail vindo de um adapter descuidado e mascarado', () => {
    expect(sanitize('sessao de pessoa@exemplo.invalid ativa')).toBe(`sessao de ${MASK} ativa`)
  })

  it('token com prefixo reconhecivel e mascarado', () => {
    expect(sanitize('usando sk-abcdefgh12345678')).toContain(MASK)
    expect(sanitize('usando sk-abcdefgh12345678')).not.toContain('abcdefgh12345678')
  })

  it('o bloco impresso passa pelo filtro: detail e diagnostico saneados', () => {
    const view = providerViewOf({
      health: dto({
        installed: true,
        ready: false,
        detail: 'sessao de alguem@empresa.com',
        diagnostic: {
          kind: 'probe-failed',
          detail: 'sonda falhou para alguem@empresa.com',
          remediation: 'refaca o login',
        },
      }),
    })
    const text = renderProviderView(view).join('\n')

    expect(text).not.toContain('alguem@empresa.com')
    expect(text).toContain(MASK)
  })

  it('caminho comum nao e confundido com segredo', () => {
    const clean = '/home/u/.local/bin/cli'
    expect(sanitize(clean)).toBe(clean)
  })
})
