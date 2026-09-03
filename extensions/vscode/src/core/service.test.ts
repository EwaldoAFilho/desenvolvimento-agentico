import { describe, expect, it } from 'vitest'
import type { LiveControlPlane } from './discovery.js'
import type { ProcessExit, SpawnedProcess } from './launcher.js'
import { AgenticService, type ServiceDeps, ServiceStateError } from './service.js'

/**
 * Dublê de processo: o teste decide quando ele "publica" e quando ele sai. `kill` grava o
 * sinal e, por padrao, faz o processo sair no proximo tick — como o `serve` real faz com
 * SIGTERM, so que sem SO.
 */
class FakeProcess implements SpawnedProcess {
  readonly pid: number
  readonly signals: string[] = []
  readonly exited: Promise<ProcessExit>
  done = false
  private finish!: (exit: ProcessExit) => void
  onKill: (() => void) | undefined

  constructor(pid: number) {
    this.pid = pid
    this.exited = new Promise<ProcessExit>((resolve) => {
      this.finish = resolve
    })
  }

  exit(code: number): void {
    this.done = true
    this.finish({ code, signal: null })
  }

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal)
    if (this.onKill !== undefined) this.onKill()
    else this.exit(0)
    return true
  }

  output(): string {
    return `saida do pid ${this.pid}`
  }
}

interface World {
  live: LiveControlPlane | undefined
  spawned: FakeProcess[]
  signals: number[]
  log: string[]
  clock: number
}

function world(): World {
  return { live: undefined, spawned: [], signals: [], log: [], clock: 0 }
}

function liveOf(pid: number | undefined, url = 'http://127.0.0.1:4317'): LiveControlPlane {
  return { url, repoRoot: '/repo', source: 'runtime-file', ...(pid === undefined ? {} : { pid }) }
}

function depsOf(w: World, overrides: Partial<ServiceDeps> = {}): ServiceDeps {
  return {
    discover: () => Promise.resolve(w.live),
    spawnServe: () => {
      const proc = new FakeProcess(1000 + w.spawned.length)
      w.spawned.push(proc)
      return Promise.resolve(proc)
    },
    signal: (pid) => {
      w.signals.push(pid)
      return true
    },
    sleep: (ms) => {
      w.clock += ms
      return Promise.resolve()
    },
    now: () => new Date(w.clock),
    log: (line) => {
      w.log.push(line)
    },
    timeouts: { startMs: 2_000, stopMs: 1_000, pollMs: 100 },
    ...overrides,
  }
}

describe('AgenticService.start', () => {
  it('reutiliza o dono que ja existe: nao sobe nada (I14)', async () => {
    const w = world()
    w.live = liveOf(777)
    const service = new AgenticService(depsOf(w))
    const view = await service.ensureRunning()
    expect(view).toMatchObject({ state: 'RUNNING', owned: false })
    expect(view.live?.pid).toBe(777)
    expect(w.spawned).toHaveLength(0)
  })

  it('no silencio sobe agentic serve e so declara RUNNING quando o health responde', async () => {
    const w = world()
    let polls = 0
    const service = new AgenticService(
      depsOf(w, {
        discover: () => {
          polls += 1
          // O processo publica na terceira consulta: antes disso, nao esta no ar.
          if (polls >= 3 && w.spawned[0] !== undefined) w.live = liveOf(w.spawned[0].pid)
          return Promise.resolve(w.live)
        },
      }),
    )
    const states: string[] = []
    service.onDidChange((view) => states.push(view.state))
    const view = await service.start()
    expect(states).toEqual(['STARTING', 'RUNNING'])
    expect(view.owned).toBe(true)
    expect(view.live?.pid).toBe(w.spawned[0]?.pid)
  })

  it('serve que sai com 0 porque outra janela venceu a corrida vira reutilizacao', async () => {
    const w = world()
    const service = new AgenticService(
      depsOf(w, {
        spawnServe: () => {
          const proc = new FakeProcess(2000)
          w.spawned.push(proc)
          // "control plane ja no ar": o serve sai com 0 e o dono e outro pid.
          proc.exit(0)
          w.live = liveOf(999)
          return Promise.resolve(proc)
        },
      }),
    )
    const view = await service.start()
    expect(view).toMatchObject({ state: 'RUNNING', owned: false })
    expect(view.live?.pid).toBe(999)
  })

  it('serve que morre sem publicar deixa STOPPED com a saida no motivo', async () => {
    const w = world()
    const service = new AgenticService(
      depsOf(w, {
        spawnServe: () => {
          const proc = new FakeProcess(2001)
          proc.exit(2)
          return Promise.resolve(proc)
        },
      }),
    )
    const view = await service.start()
    expect(view.state).toBe('STOPPED')
    expect(view.failure?.at).toBe('start')
    expect(view.failure?.message).toContain('codigo 2')
    expect(view.failure?.message).toContain('saida do pid 2001')
  })

  it('toolchain ausente e falha de start, nao excecao solta', async () => {
    const w = world()
    const service = new AgenticService(
      depsOf(w, { spawnServe: () => Promise.reject(new Error('sem node')) }),
    )
    const view = await service.start()
    expect(view.state).toBe('STOPPED')
    expect(view.failure?.message).toBe('sem node')
  })

  it('prazo vencido sem health: sinaliza o filho e so volta a STOPPED com a saida provada', async () => {
    const w = world()
    const service = new AgenticService(depsOf(w))
    const view = await service.start()
    expect(view.state).toBe('STOPPED')
    expect(view.failure?.message).toContain('nao publicou')
    expect(w.spawned[0]?.signals).toEqual(['SIGTERM'])
    expect(w.spawned[0]?.done).toBe(true)
  })

  it('prazo vencido e o filho nao sai apos SIGTERM: FAILED com o handle mantido', async () => {
    const w = world()
    const service = new AgenticService(
      depsOf(w, {
        spawnServe: () => {
          const proc = new FakeProcess(2002)
          proc.onKill = () => undefined
          w.spawned.push(proc)
          return Promise.resolve(proc)
        },
      }),
    )
    const view = await service.start()
    expect(view.state).toBe('FAILED')
    expect(view.failure?.message).toContain('processo mantido')
    await expect(service.start()).rejects.toBeInstanceOf(ServiceStateError)
    const child = w.spawned[0]
    if (child === undefined) throw new Error('sem filho')
    child.onKill = undefined
    expect((await service.stop()).state).toBe('STOPPED')
  })

  it('start em RUNNING e fast-path: nao consulta, nao sobe, nao troca o handle', async () => {
    const w = world()
    let discoveries = 0
    const service = new AgenticService(
      depsOf(w, {
        discover: () => {
          discoveries += 1
          if (w.spawned[0] !== undefined) w.live = liveOf(w.spawned[0].pid)
          return Promise.resolve(w.live)
        },
      }),
    )
    await service.start()
    const before = discoveries
    const again = await service.start()
    expect(again).toMatchObject({ state: 'RUNNING', owned: true })
    expect(discoveries).toBe(before)
    expect(w.spawned).toHaveLength(1)
  })

  it('start concorrente compartilha a fila: um unico processo', async () => {
    const w = world()
    const service = new AgenticService(
      depsOf(w, {
        discover: () => {
          if (w.spawned[0] !== undefined) w.live = liveOf(w.spawned[0].pid)
          return Promise.resolve(w.live)
        },
      }),
    )
    const [a, b] = await Promise.all([service.start(), service.start()])
    expect(a.state).toBe('RUNNING')
    expect(b.state).toBe('RUNNING')
    expect(w.spawned).toHaveLength(1)
  })
})

describe('corrida entre duas janelas', () => {
  /** Dois servicos, um projeto: o mundo decide quem publica; o outro filho sai com 0. */
  function mundoDisputado(): { w: World; a: AgenticService; b: AgenticService } {
    const w = world()
    let winner: FakeProcess | undefined
    const discover = (): Promise<LiveControlPlane | undefined> => {
      if (winner === undefined && w.spawned.length === 2) {
        // O segundo a nascer vence (o cenario adverso: quem chegou depois publica).
        winner = w.spawned[1]
        for (const p of w.spawned) if (p !== winner) p.exit(0)
      }
      w.live = winner === undefined || winner.done ? undefined : liveOf(winner.pid)
      return Promise.resolve(w.live)
    }
    // Um SIGTERM ao vencedor faz ele sair, como o serve real.
    const signal = (pid: number): boolean => {
      w.signals.push(pid)
      w.spawned.find((p) => p.pid === pid)?.exit(0)
      return true
    }
    const a = new AgenticService(depsOf(w, { discover, signal }))
    const b = new AgenticService(depsOf(w, { discover, signal }))
    return { w, a, b }
  }

  it('dois ensureRunning simultaneos: um dono, o perdedor assentado, os dois RUNNING', async () => {
    const { w, a, b } = mundoDisputado()
    const [va, vb] = await Promise.all([a.ensureRunning(), b.ensureRunning()])
    expect(va.state).toBe('RUNNING')
    expect(vb.state).toBe('RUNNING')
    expect(va.live?.pid).toBe(vb.live?.pid)
    expect([va.owned, vb.owned].filter(Boolean)).toHaveLength(1)
    // O perdedor nao deixou handle vivo para tras.
    const loser = va.owned ? vb : va
    expect(loser.childPid).toBeUndefined()
    expect(w.spawned.filter((p) => !p.done)).toHaveLength(1)
  })

  it('stop do lado que adotou o vencedor encerra o vencedor, nao um filho fantasma', async () => {
    const { w, a, b } = mundoDisputado()
    const [va, vb] = await Promise.all([a.ensureRunning(), b.ensureRunning()])
    const loserSide = va.owned ? b : a
    const stopped = await loserSide.stop()
    expect(stopped.state).toBe('STOPPED')
    expect(w.signals).toEqual([w.spawned.find((p) => !p.done)?.pid ?? w.spawned[1]?.pid])
    void vb
  })

  it('filho saiu com 0 antes de o vencedor publicar: espera pelo vencedor, nao vira STOPPED', async () => {
    const w = world()
    let polls = 0
    const service = new AgenticService(
      depsOf(w, {
        spawnServe: () => {
          const proc = new FakeProcess(3000)
          w.spawned.push(proc)
          proc.exit(0)
          return Promise.resolve(proc)
        },
        discover: () => {
          polls += 1
          if (polls >= 4) w.live = liveOf(999)
          return Promise.resolve(w.live)
        },
      }),
    )
    const view = await service.ensureRunning()
    expect(view).toMatchObject({ state: 'RUNNING', owned: false })
    expect(view.live?.pid).toBe(999)
  })

  it('filho desta janela saiu, mas outro dono continua: stop nao declara STOPPED', async () => {
    const w = world()
    let phase: 'own' | 'other' = 'own'
    const service = new AgenticService(
      depsOf(w, {
        discover: () => {
          const child = w.spawned[0]
          if (phase === 'own')
            w.live = child !== undefined && !child.done ? liveOf(child.pid) : undefined
          else w.live = liveOf(4242)
          return Promise.resolve(w.live)
        },
      }),
    )
    await service.start()
    phase = 'other'
    const view = await service.stop()
    expect(view.state).toBe('RUNNING')
    expect(view.owned).toBe(false)
    expect(view.live?.pid).toBe(4242)
  })
})

describe('AgenticService.stop', () => {
  async function running(w: World, overrides: Partial<ServiceDeps> = {}): Promise<AgenticService> {
    const service = new AgenticService(
      depsOf(w, {
        discover: () => {
          const child = w.spawned[0]
          if (child !== undefined && !child.done) w.live = liveOf(child.pid)
          else if (child?.done) w.live = undefined
          return Promise.resolve(w.live)
        },
        ...overrides,
      }),
    )
    await service.start()
    return service
  }

  it('filho desta janela: SIGTERM e espera a saida real', async () => {
    const w = world()
    const service = await running(w)
    const states: string[] = []
    service.onDidChange((view) => states.push(view.state))
    const view = await service.stop()
    expect(states).toEqual(['STOPPING', 'STOPPED'])
    expect(view.state).toBe('STOPPED')
    expect(w.spawned[0]?.signals).toEqual(['SIGTERM'])
    expect(w.signals).toEqual([])
  })

  it('filho que nao sai no prazo: FAILED, processo mantido, stop de novo tenta outra vez', async () => {
    const w = world()
    const service = await running(w)
    const child = w.spawned[0]
    if (child === undefined) throw new Error('sem filho')
    child.onKill = () => undefined
    const failed = await service.stop()
    expect(failed.state).toBe('FAILED')
    expect(failed.failure?.message).toContain('posse continua')
    await expect(service.start()).rejects.toBeInstanceOf(ServiceStateError)
    child.onKill = undefined
    const stopped = await service.stop()
    expect(stopped.state).toBe('STOPPED')
    expect(child.signals).toEqual(['SIGTERM', 'SIGTERM'])
  })

  it('dono externo: sinal ao pid publicado e prova pelo silencio da descoberta', async () => {
    const w = world()
    w.live = liveOf(555)
    let polls = 0
    const service = new AgenticService(
      depsOf(w, {
        discover: () => {
          if (w.signals.length > 0) {
            polls += 1
            if (polls >= 2) w.live = undefined
          }
          return Promise.resolve(w.live)
        },
      }),
    )
    await service.ensureRunning()
    const view = await service.stop()
    expect(view.state).toBe('STOPPED')
    expect(w.signals).toEqual([555])
  })

  it('dono externo que continua respondendo apos o prazo: FAILED, nunca "STOPPED" por sinal enviado', async () => {
    const w = world()
    w.live = liveOf(556)
    const service = new AgenticService(depsOf(w))
    await service.ensureRunning()
    const view = await service.stop()
    expect(view.state).toBe('FAILED')
    expect(view.failure?.message).toContain('ainda responde')
  })

  it('dono sem pid publicado nao pode ser parado daqui', async () => {
    const w = world()
    w.live = liveOf(undefined)
    const service = new AgenticService(depsOf(w))
    await service.ensureRunning()
    const view = await service.stop()
    expect(view.state).toBe('FAILED')
    expect(view.failure?.message).toContain('terminal')
    expect(w.signals).toEqual([])
  })

  it('stop em STOPPED e idempotente', async () => {
    const w = world()
    const service = new AgenticService(depsOf(w))
    expect((await service.stop()).state).toBe('STOPPED')
  })
})

describe('AgenticService.restart', () => {
  it('para de fato antes de subir de novo: nunca dois processos ao mesmo tempo', async () => {
    const w = world()
    const service = new AgenticService(
      depsOf(w, {
        discover: () => {
          const alive = w.spawned.filter((p) => !p.done)
          expect(alive.length).toBeLessThanOrEqual(1)
          w.live = alive[0] === undefined ? undefined : liveOf(alive[0].pid)
          return Promise.resolve(w.live)
        },
      }),
    )
    await service.start()
    const first = w.spawned[0]
    const view = await service.restart()
    expect(view.state).toBe('RUNNING')
    expect(w.spawned).toHaveLength(2)
    expect(first?.done).toBe(true)
    expect(view.live?.pid).toBe(w.spawned[1]?.pid)
  })
})

describe('AgenticService.refresh', () => {
  it('descobre um dono que subiu por fora e nota quando ele some', async () => {
    const w = world()
    const service = new AgenticService(depsOf(w))
    expect((await service.refresh()).state).toBe('STOPPED')
    w.live = liveOf(31)
    expect(await service.refresh()).toMatchObject({ state: 'RUNNING', owned: false })
    w.live = undefined
    expect((await service.refresh()).state).toBe('STOPPED')
  })

  it('filho que morreu por fora deixa de ser "nosso"', async () => {
    const w = world()
    const service = new AgenticService(
      depsOf(w, {
        discover: () => {
          const child = w.spawned[0]
          w.live = child !== undefined && !child.done ? liveOf(child.pid) : undefined
          return Promise.resolve(w.live)
        },
      }),
    )
    await service.start()
    w.spawned[0]?.exit(1)
    const view = await service.refresh()
    expect(view.state).toBe('STOPPED')
    expect(view.owned).toBe(false)
  })
})
