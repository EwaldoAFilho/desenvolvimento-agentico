import type { JSX } from 'react'

export interface ErrorScreenProps {
  /** Rotulo acessivel da tela e titulo visivel: os dois dizem a mesma coisa. */
  readonly title: string
  readonly message: string
  /** O que o usuario pode fazer alem de tentar de novo. Opcional. */
  readonly hint?: string
  readonly retrying?: boolean
  readonly onRetry: () => void
  /** Saida lateral — normalmente voltar para a Home do projeto. */
  readonly onHome?: () => void
}

/**
 * Falha de backend com SAIDA. Uma tela que so informa o erro deixa o usuario com o F5 como
 * unica opcao — e some com o que ele estava fazendo. Aqui o erro tem codigo, a acao tem
 * rotulo, e nenhum estado fica indefinido: ou volta dado, ou volta esta tela.
 */
export function ErrorScreen({
  title,
  message,
  hint,
  retrying = false,
  onRetry,
  onHome,
}: ErrorScreenProps): JSX.Element {
  return (
    <main className="failure" aria-label={title}>
      <h1 className="failure__title">{title}</h1>
      <p className="failure__message" role="alert" data-testid="error-message">
        {message}
      </p>
      {hint === undefined ? null : <p className="failure__hint">{hint}</p>}
      <div className="failure__actions">
        <button
          type="button"
          className="btn btn--primary"
          data-testid="retry"
          aria-busy={retrying}
          disabled={retrying}
          onClick={onRetry}
        >
          {retrying ? 'tentando de novo…' : 'tentar novamente'}
        </button>
        {onHome === undefined ? null : (
          <button type="button" className="btn btn--ghost" data-testid="go-home" onClick={onHome}>
            ir para a Home do projeto
          </button>
        )}
      </div>
    </main>
  )
}
