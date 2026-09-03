/**
 * Teto de espera de uma leitura. `fetch` nao tem prazo proprio: uma conexao aceita e nunca
 * respondida deixa a promessa pendente para sempre, e a tela ficaria carregando sem que nada
 * de errado tenha acontecido. Estourado o prazo, quem chamou decide o que dizer.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
