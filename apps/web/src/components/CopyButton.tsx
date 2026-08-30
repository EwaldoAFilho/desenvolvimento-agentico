import { type JSX, useCallback, useState } from 'react'

export interface CopyButtonProps {
  readonly value: string
  readonly label?: string
}

/**
 * `code <caminho>` resolve hoje o caso "quero abrir essa task no meu editor" — sem integracao
 * nenhuma. O botao existe para isso (DASHBOARD 5).
 */
export function CopyButton({ value, label = 'copiar caminho' }: CopyButtonProps): JSX.Element {
  const [done, setDone] = useState(false)

  const copy = useCallback(() => {
    const clipboard = navigator.clipboard
    const write = clipboard?.writeText?.(value)
    if (write === undefined) {
      setDone(false)
      return
    }
    write.then(
      () => setDone(true),
      () => setDone(false),
    )
  }, [value])

  return (
    <button
      type="button"
      className="btn btn--ghost"
      onClick={copy}
      aria-label={`${label}: ${value}`}
    >
      {done ? 'copiado' : label}
    </button>
  )
}
