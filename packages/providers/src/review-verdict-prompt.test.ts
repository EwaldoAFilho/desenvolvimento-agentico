import { describe, expect, it } from 'vitest'
import { reviewAssignment } from './__fixtures__/assignments.js'
import { buildAssignmentPrompt } from './assignment-prompt.js'

/**
 * Regressao de um defeito encontrado com AGENTE REAL, nao por teste.
 *
 * Num run de verdade (DA-REAL-002, run 01M1C22MX19XTX50HMEA102BKY) o revisor produziu uma
 * analise detalhada, com achados por linha e marcacoes de conferencia — e a tentativa foi
 * perdida com `AGENT_ERROR: revisor nao emitiu veredito`. O parser recusou corretamente
 * (ele existe para que a palavra PASS no meio de uma frase nao vire aprovacao); quem falhou
 * foi o PROMPT, que pedia "veredito em uma linha" sem deixar o formato inequivoco.
 *
 * Afrouxar o parser seria a correcao errada: aceitaria elogio em prosa como aprovacao.
 */
describe('prompt de revisao: o veredito precisa ser inequivoco', () => {
  const prompt = (): string => buildAssignmentPrompt(reviewAssignment('/tmp/worktree-exemplo')).text

  it('manda comecar pela linha exata que o parser reconhece', () => {
    const texto = prompt()
    expect(texto).toContain('VEREDITO: PASS')
    expect(texto.toLowerCase()).toContain('obrigatoria')
  })

  it('diz o que acontece se o veredito faltar, em vez de so pedir', () => {
    expect(prompt().toLowerCase()).toContain('sem ela o control plane nao consegue')
  })

  it('oferece as tres opcoes de veredito', () => {
    const texto = prompt()
    for (const opcao of ['PASS', 'FAIL', 'ESCALATE']) {
      expect(texto).toContain(`VEREDITO: ${opcao}`)
    }
  })

  it('continua sem entregar a narrativa do executor ao revisor (P07)', () => {
    expect(prompt().toLowerCase()).toContain('nao ha relato do executor')
  })
})
