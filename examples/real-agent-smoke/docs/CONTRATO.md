# Contrato dos módulos entregues pela missão

Especificação normativa dos três módulos que `SMOKE-REAL-001` entrega. Existe para que a
avaliação **não dependa de gosto**: cada regra abaixo tem um caso correspondente em
`tests/specs/`, e a suíte é quem decide.

Onde este documento e um spec de `tests/specs/` divergirem, **o spec vence** — ele é o que
roda.

---

## Convenção do projeto (leia antes de escrever qualquer linha)

Está em [`src/resultado.js`](../src/resultado.js) e vale para tudo:

- nenhuma função pública lança por causa da **entrada**;
- o que pode falhar devolve `{ ok: true, valor }` ou `{ ok: false, codigo, mensagem }`;
- `codigo` é um de `VAZIO`, `FORMATO`, `FAIXA`, `ORDEM` — a suíte compara **código**, nunca
  mensagem;
- `falha` com código fora da lista **lança**: isso é erro de programação, não de entrada;
- `propagar(resultado, contexto)` repassa uma falha **preservando o código** da causa.

A ordem de verificação é sempre a mesma — vazio, forma, faixa, ordem — e é ela que decide
qual código sai. [`src/horario.js`](../src/horario.js) é o modelo executável dessa ordem.

Entrada textual passa por [`src/texto.js`](../src/texto.js) antes de qualquer análise:
`normalizar` apara, baixa a caixa e colapsa espaço; `semEspacos` remove todo espaço interno.
É por isso que `  2H 15M ` e `2h15m` são a mesma duração.

---

## T01 — `src/duracao.js`

```js
analisarDuracao(texto) -> Resultado<number>   // total em minutos
```

| Entrada | Saída |
| --- | --- |
| `'1h30m'` | `ok(90)` |
| `'2h'` | `ok(120)` |
| `'45m'` | `ok(45)` |
| `'  2H 15M '` | `ok(135)` |
| `'01h05m'` | `ok(65)` |
| `''`, `'   '`, `undefined`, `90` | `VAZIO` |
| `'30'`, `'1h30'` | `FORMATO` — número sem unidade |
| `'h'`, `'m'`, `'abc'` | `FORMATO` — unidade sem número |
| `'30m1h'` | `FORMATO` — hora vem antes de minuto |
| `'1h60m'` | `FAIXA` — minuto vale 0..59 |
| `'24h'` | `FAIXA` — hora vale 0..23 |
| `'0m'`, `'0h0m'` | `FAIXA` — duração precisa ser maior que zero |

Pelo menos um dos dois componentes precisa estar presente.

---

## T02 — `src/intervalo.js`

```js
analisarIntervalo(texto) -> Resultado<{ inicio: number, fim: number }>   // minutos do dia
```

Reusa `analisarHorario` de `src/horario.js` em cada lado e **repassa a falha do lado
preservando o código**.

| Entrada | Saída |
| --- | --- |
| `'08:00-12:30'` | `ok({ inicio: 480, fim: 750 })` |
| `' 08:00 - 12:30 '` | igual à anterior |
| `'00:00-23:59'` | `ok({ inicio: 0, fim: 1439 })` |
| `''`, `'   '`, `undefined` | `VAZIO` |
| `'08:00'` | `FORMATO` — sem separador |
| `'08:00-12:30-14:00'` | `FORMATO` — separador repetido |
| `'-12:30'`, `'08:00-'` | `VAZIO` — lado ausente, código vindo do lado |
| `'8:00-12:30'`, `'08:00-12h30'` | `FORMATO` — vindo do lado |
| `'25:00-26:00'`, `'08:00-12:75'` | `FAIXA` — vindo do lado |
| `'12:30-08:00'`, `'08:00-08:00'` | `ORDEM` — o fim precisa passar do início |

---

## T03 — `src/agenda.js`

```js
montarAgenda(textoIntervalo, textoDuracao)
  -> Resultado<{ inicio: string, fim: string }[]>   // 'HH:MM', via formatarHorario
```

Integra T01 e T02:

1. analisa **o intervalo primeiro**, depois a duração;
2. a primeira falha é repassada com o **código da causa**;
3. blocos são consecutivos e completos, começando no início do intervalo;
4. a sobra do fim é descartada — nunca existe bloco parcial;
5. intervalo menor que a duração devolve `ok([])`, não falha.

| Entrada | Saída |
| --- | --- |
| `('08:00-09:00', '30m')` | `ok([08:00–08:30, 08:30–09:00])` |
| `('08:00-09:00', '1h')` | `ok([08:00–09:00])` |
| `('08:00-09:00', '45m')` | `ok([08:00–08:45])` — sobra de 15 min descartada |
| `(' 09:00 - 10:20 ', '25m')` | `ok([09:00–09:25, 09:25–09:50, 09:50–10:15])` |
| `('08:00-09:00', '2h')` | `ok([])` |
| `('23:00-23:59', '30m')` | `ok([23:00–23:30])` |
| `('8:00-12:30', '30m')` | `FORMATO` (do intervalo) |
| `('12:30-08:00', '30m')` | `ORDEM` (do intervalo) |
| `('08:00-09:00', '0m')` | `FAIXA` (da duração) |
| `('12:30-08:00', 'xyz')` | `ORDEM` — o intervalo é analisado primeiro |
