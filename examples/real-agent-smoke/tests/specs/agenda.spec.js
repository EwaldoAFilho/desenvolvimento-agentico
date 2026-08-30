import assert from 'node:assert/strict'

/**
 * Contrato de `src/agenda.js` — entregue pela task T03, que integra T01 e T02.
 * Enquanto o arquivo nao existir, a suite marca este spec como PENDENTE.
 */
export const alvo = 'agenda.js'

export function casos(modulo) {
  const { montarAgenda } = modulo
  return [
    {
      nome: 'exporta montarAgenda',
      executar: () => {
        assert.equal(typeof montarAgenda, 'function')
      },
    },
    {
      nome: 'divide o intervalo em blocos consecutivos',
      executar: () => {
        assert.deepEqual(montarAgenda('08:00-09:00', '30m'), {
          ok: true,
          valor: [
            { inicio: '08:00', fim: '08:30' },
            { inicio: '08:30', fim: '09:00' },
          ],
        })
        assert.deepEqual(montarAgenda('08:00-09:00', '1h'), {
          ok: true,
          valor: [{ inicio: '08:00', fim: '09:00' }],
        })
      },
    },
    {
      nome: 'sobra do fim e descartada',
      executar: () => {
        assert.deepEqual(montarAgenda('08:00-09:00', '45m'), {
          ok: true,
          valor: [{ inicio: '08:00', fim: '08:45' }],
        })
        assert.deepEqual(montarAgenda(' 09:00 - 10:20 ', '25m'), {
          ok: true,
          valor: [
            { inicio: '09:00', fim: '09:25' },
            { inicio: '09:25', fim: '09:50' },
            { inicio: '09:50', fim: '10:15' },
          ],
        })
      },
    },
    {
      nome: 'duracao maior que o intervalo devolve lista vazia',
      executar: () => {
        assert.deepEqual(montarAgenda('08:00-09:00', '2h'), { ok: true, valor: [] })
      },
    },
    {
      nome: 'ultimo bloco do dia cabe',
      executar: () => {
        assert.deepEqual(montarAgenda('23:00-23:59', '30m'), {
          ok: true,
          valor: [{ inicio: '23:00', fim: '23:30' }],
        })
      },
    },
    {
      nome: 'falha do intervalo e propagada com o codigo da causa',
      executar: () => {
        assert.equal(montarAgenda('', '30m').codigo, 'VAZIO')
        assert.equal(montarAgenda('8:00-12:30', '30m').codigo, 'FORMATO')
        assert.equal(montarAgenda('25:00-26:00', '30m').codigo, 'FAIXA')
        assert.equal(montarAgenda('12:30-08:00', '30m').codigo, 'ORDEM')
      },
    },
    {
      nome: 'falha da duracao e propagada com o codigo da causa',
      executar: () => {
        assert.equal(montarAgenda('08:00-09:00', '').codigo, 'VAZIO')
        assert.equal(montarAgenda('08:00-09:00', 'xyz').codigo, 'FORMATO')
        assert.equal(montarAgenda('08:00-09:00', '0m').codigo, 'FAIXA')
      },
    },
    {
      nome: 'o intervalo e analisado primeiro',
      executar: () => {
        assert.equal(montarAgenda('12:30-08:00', 'xyz').codigo, 'ORDEM')
      },
    },
  ]
}
