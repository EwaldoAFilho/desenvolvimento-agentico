import assert from 'node:assert/strict'

export const alvo = 'horario.js'

/** Modulo base: existe antes da missao. Sumir daqui e falha, nunca pendencia. */
export const base = true

export function casos(modulo) {
  const { MINUTOS_POR_DIA, analisarHorario, formatarHorario } = modulo
  return [
    {
      nome: 'analisa HH:MM',
      executar: () => {
        assert.deepEqual(analisarHorario('08:30'), { ok: true, valor: 510 })
        assert.deepEqual(analisarHorario(' 00:00 '), { ok: true, valor: 0 })
        assert.deepEqual(analisarHorario('23:59'), { ok: true, valor: 1439 })
      },
    },
    {
      nome: 'entrada vazia e VAZIO',
      executar: () => {
        assert.equal(analisarHorario('').codigo, 'VAZIO')
        assert.equal(analisarHorario('   ').codigo, 'VAZIO')
        assert.equal(analisarHorario(undefined).codigo, 'VAZIO')
      },
    },
    {
      nome: 'um digito na hora e FORMATO',
      executar: () => {
        assert.equal(analisarHorario('8:30').codigo, 'FORMATO')
        assert.equal(analisarHorario('0830').codigo, 'FORMATO')
      },
    },
    {
      nome: 'hora e minuto tem faixa',
      executar: () => {
        assert.equal(analisarHorario('24:00').codigo, 'FAIXA')
        assert.equal(analisarHorario('10:60').codigo, 'FAIXA')
      },
    },
    {
      nome: 'formata de volta',
      executar: () => {
        assert.deepEqual(formatarHorario(510), { ok: true, valor: '08:30' })
        assert.deepEqual(formatarHorario(0), { ok: true, valor: '00:00' })
        assert.equal(formatarHorario(-1).codigo, 'FAIXA')
        assert.equal(formatarHorario(MINUTOS_POR_DIA).codigo, 'FAIXA')
        assert.equal(formatarHorario(1.5).codigo, 'FORMATO')
      },
    },
  ]
}
