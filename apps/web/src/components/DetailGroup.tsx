import { type JSX, type ReactNode, useId, useState } from 'react'

export type GroupTone = 'wait' | 'fail' | 'block' | 'reading'

export interface DetailGroupProps {
  readonly title: string
  /** Resumo do grupo fechado: o titular fica a vista, o detalhe fica atras do clique. */
  readonly hint?: string
  readonly tone?: GroupTone
  readonly defaultOpen?: boolean
  readonly children: ReactNode
}

export function groupSlug(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

/**
 * Revelacao progressiva do painel (DASHBOARD 5): tudo esta acessivel, nada aparece tudo ao
 * mesmo tempo. O que exige acao agora — espera, falha, bloqueio — nasce aberto; o material
 * de referencia nasce fechado.
 *
 * O corpo continua no DOM quando fechado e some por CSS (`.group[data-open='false']`), o que
 * mantem a regiao anunciada com `aria-label` e o botao com `aria-expanded`/`aria-controls` —
 * padrao de disclosure, sem widget proprio.
 */
export function DetailGroup({
  title,
  hint,
  tone,
  defaultOpen = false,
  children,
}: DetailGroupProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const bodyId = useId()
  const slug = groupSlug(title)

  return (
    <div
      className={`group${tone === undefined ? '' : ` group--${tone}`}`}
      data-open={open}
      data-testid={`group-${slug}`}
    >
      <button
        type="button"
        className="group__toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="group__chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="group__title">{title}</span>
        {hint === undefined ? null : (
          <span className="group__hint" data-testid={`hint-${slug}`}>
            {hint}
          </span>
        )}
      </button>
      <section id={bodyId} className="group__body" aria-label={title}>
        <dl className="group__fields">{children}</dl>
      </section>
    </div>
  )
}
