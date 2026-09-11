import { createContext, useContext } from 'react'
import type { Provider } from 'react'

export interface EditorActions {
  activeTags: string[]
  addTag: (tag: string) => void
  removeTag: (tag: string) => void
  recentTags: string[]
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
