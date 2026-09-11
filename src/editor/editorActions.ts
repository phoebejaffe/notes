import { createContext, useContext } from 'react'
import type { Provider } from 'react'

export interface EditorActions {
  addTag: (tag: string) => void
  toggleMute: () => void
  showUndoRedo: boolean
}

export const editorActionsContext = createContext<EditorActions | null>(null)
export const EditorActionsProvider = editorActionsContext.Provider as Provider<EditorActions | null>

export function useEditorActions() {
  const actions = useContext(editorActionsContext)
  if (!actions) throw new Error('Editor actions must be used inside an MDXEditor')
  return actions
}
