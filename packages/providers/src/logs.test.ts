import type { AgentLogEvent } from '@agentic/domain'
import { describe, expect, it } from 'vitest'
import { AgentLogRecorder, pumpInto } from './logs.js'

async function collect(source: AsyncIterable<AgentLogEvent>): Promise<AgentLogEvent[]> {
  const out: AgentLogEvent[] = []
  for await (const event of source) out.push(event)
  return out
}

async function* lines(...values: string[]): AsyncGenerator<string> {
  for (const value of values) yield value
}

describe('AgentLogRecorder', () => {
  it('replica tudo para quem chega depois do fim', async () => {
    const recorder = new AgentLogRecorder(() => 0)
    recorder.push('stdout', 'um')
    recorder.push('stderr', 'dois')
    recorder.close()
    const eventos = await collect(recorder.stream())
    expect(eventos.map((e) => e.chunk)).toEqual(['um', 'dois'])
    expect(eventos.map((e) => e.stream)).toEqual(['stdout', 'stderr'])
  })

  it('dois consumidores veem a mesma sequencia', async () => {
    const recorder = new AgentLogRecorder(() => 0)
    recorder.pushAll('stdout', ['a', 'b', 'c'])
    recorder.close()
    const primeiro = await collect(recorder.stream())
    const segundo = await collect(recorder.stream())
    expect(segundo).toEqual(primeiro)
  })

  it('acorda o consumidor que ja estava iterando', async () => {
    const recorder = new AgentLogRecorder(() => 0)
    const pendente = collect(recorder.stream())
    recorder.push('stdout', 'chegou depois')
    recorder.close()
    expect((await pendente).map((e) => e.chunk)).toEqual(['chegou depois'])
  })

  it('ignora escrita depois de fechado', async () => {
    const recorder = new AgentLogRecorder(() => 0)
    recorder.close()
    recorder.push('stdout', 'tarde demais')
    expect(await collect(recorder.stream())).toEqual([])
    expect(recorder.closed).toBe(true)
  })

  it('separa o texto por stream, na ordem de chegada', () => {
    const recorder = new AgentLogRecorder(() => 0)
    recorder.push('stdout', 'a')
    recorder.push('stderr', 'x')
    recorder.push('stdout', 'b')
    expect(recorder.text('stdout')).toEqual(['a', 'b'])
    expect(recorder.text('stderr')).toEqual(['x'])
  })

  it('carimba cada evento com o relogio injetado', async () => {
    let tick = 0
    const recorder = new AgentLogRecorder(() => {
      tick += 1000
      return tick
    })
    recorder.push('stdout', 'a')
    recorder.close()
    const [evento] = await collect(recorder.stream())
    expect(evento?.ts).toEqual(new Date(1000))
  })
})

describe('pumpInto', () => {
  it('bombeia um stream inteiro para o log', async () => {
    const recorder = new AgentLogRecorder(() => 0)
    await pumpInto(recorder, 'stdout', lines('um', 'dois'))
    recorder.close()
    expect(recorder.text('stdout')).toEqual(['um', 'dois'])
  })

  it('stream que explode nao invalida o que ja foi observado', async () => {
    const recorder = new AgentLogRecorder(() => 0)
    const quebrado = {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        yield 'antes da falha'
        throw new Error('pipe morreu')
      },
    }
    await pumpInto(recorder, 'stderr', quebrado)
    recorder.close()
    expect(recorder.text('stderr')).toEqual(['antes da falha'])
  })
})
