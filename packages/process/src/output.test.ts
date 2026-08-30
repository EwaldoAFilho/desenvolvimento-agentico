import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { StreamSink } from './output.js'

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

const collect = async (source: AsyncIterable<string>): Promise<string[]> => {
  const out: string[] = []
  for await (const line of source) out.push(line)
  return out
}

describe('StreamSink', () => {
  it('acumula abaixo do limite sem marcar truncamento', () => {
    const sink = new StreamSink(1024)
    sink.push(Buffer.from('alpha'))
    sink.end()
    expect(sink.text()).toBe('alpha')
    expect(sink.truncated).toBe(false)
    expect(sink.digest()).toBe(sha256('alpha'))
  })

  it('para de acumular no limite mas segue alimentando o digest', () => {
    const sink = new StreamSink(4)
    sink.push(Buffer.from('abcdef'))
    sink.push(Buffer.from('ghij'))
    sink.end()
    expect(sink.text()).toBe('abcd')
    expect(sink.truncated).toBe(true)
    expect(sink.digest()).toBe(sha256('abcdefghij'))
  })

  it('remonta caractere multibyte partido entre chunks', async () => {
    const sink = new StreamSink(1024)
    const bytes = Buffer.from('acaoção\n', 'utf8')
    sink.push(bytes.subarray(0, 5))
    sink.push(bytes.subarray(5))
    sink.end()
    expect(await collect(sink.lines())).toEqual(['acaoção'])
  })

  it('normaliza fim de linha do Windows', async () => {
    const sink = new StreamSink(1024)
    sink.push(Buffer.from('um\r\ndois\r\n'))
    sink.end()
    expect(await collect(sink.lines())).toEqual(['um', 'dois'])
  })

  it('entrega a linha final sem quebra', async () => {
    const sink = new StreamSink(1024)
    sink.push(Buffer.from('um\nparcial'))
    sink.end()
    expect(await collect(sink.lines())).toEqual(['um', 'parcial'])
  })

  it('ignora escrita depois do fim', () => {
    const sink = new StreamSink(1024)
    sink.push(Buffer.from('a'))
    sink.end()
    sink.push(Buffer.from('b'))
    expect(sink.text()).toBe('a')
    expect(sink.digest()).toBe(sha256('a'))
  })

  it('digest de stream vazio e o do conteudo vazio', () => {
    const sink = new StreamSink(1024)
    sink.end()
    expect(sink.text()).toBe('')
    expect(sink.digest()).toBe(sha256(''))
  })

  it('entrega linhas a um assinante vivo', async () => {
    const sink = new StreamSink(1024)
    const pending = collect(sink.lines())
    sink.push(Buffer.from('primeira\n'))
    await new Promise((resolve) => setTimeout(resolve, 5))
    sink.push(Buffer.from('segunda\n'))
    sink.end()
    expect(await pending).toEqual(['primeira', 'segunda'])
  })
})
