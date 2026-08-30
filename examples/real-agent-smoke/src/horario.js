/**
 * Horario do dia em minutos desde a meia-noite. Modulo base: existe antes da missao.
 *
 * Serve de MODELO para os modulos que a missao entrega: normaliza a entrada, testa a
 * forma, testa a faixa, devolve `Resultado`. Nesta ordem, sempre — o codigo da falha
 * conta ao chamador em que etapa a entrada morreu.
 */
import { CODIGOS, falha, ok } from './resultado.js'
import { semEspacos } from './texto.js'

export const MINUTOS_POR_HORA = 60
export const MINUTOS_POR_DIA = 24 * MINUTOS_POR_HORA

const FORMA = /^(\d{2}):(\d{2})$/

/** `'08:30'` -> `ok(510)`. Exige dois digitos de cada lado: `'8:30'` e FORMATO. */
export function analisarHorario(texto) {
  const limpo = semEspacos(texto)
  if (limpo === '') return falha(CODIGOS.VAZIO, 'horario ausente')

  const casado = FORMA.exec(limpo)
  if (casado === null) return falha(CODIGOS.FORMATO, `horario fora da forma HH:MM: "${limpo}"`)

  const horas = Number(casado[1])
  const minutos = Number(casado[2])
  if (horas > 23) return falha(CODIGOS.FAIXA, `hora fora de 00..23: "${casado[1]}"`)
  if (minutos > 59) return falha(CODIGOS.FAIXA, `minuto fora de 00..59: "${casado[2]}"`)

  return ok(horas * MINUTOS_POR_HORA + minutos)
}

/** `510` -> `ok('08:30')`. Aceita 0..1439; 1440 ja e outro dia e e FAIXA. */
export function formatarHorario(minutos) {
  if (!Number.isInteger(minutos)) {
    return falha(CODIGOS.FORMATO, `minutos precisa ser inteiro: ${String(minutos)}`)
  }
  if (minutos < 0 || minutos >= MINUTOS_POR_DIA) {
    return falha(CODIGOS.FAIXA, `minutos fora de 0..${MINUTOS_POR_DIA - 1}: ${minutos}`)
  }
  const horas = Math.floor(minutos / MINUTOS_POR_HORA)
  const resto = minutos % MINUTOS_POR_HORA
  return ok(`${String(horas).padStart(2, '0')}:${String(resto).padStart(2, '0')}`)
}
