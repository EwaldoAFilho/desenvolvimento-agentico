import { createContext, useContext } from 'react'

/**
 * Acoes que so um EDITOR sabe fazer: abrir um caminho, mostrar um diff, abrir um log. O
 * dashboard no navegador nao as tem (e mostra "copiar caminho"); a webview do VS Code as
 * fornece e os mesmos componentes ganham botoes nativos. Ausente = comportamento de sempre.
 */
export interface EditorActions {
  /** Abre um arquivo (ou revela uma pasta). Caminho relativo ao repositorio ou absoluto. */
  openPath?(path: string): void
  /** Diff nativo entre dois refs do git para um caminho. */
  openDiff?(input: { readonly path: string; readonly base: string; readonly head: string }): void
}

export const EditorActionsContext = createContext<EditorActions | undefined>(undefined)

export function useEditorActions(): EditorActions | undefined {
  return useContext(EditorActionsContext)
}
