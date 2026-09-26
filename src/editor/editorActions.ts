import { createContext, useContext } from 'react'
import type { Provider } from 'react'

export interface EditorActions {
  activeTags: string[]
  recentTags: string[]
  addTag: (tag: string) => void
  removeTag: (tag: string) => void
}

export const editorActionsContext = createContext<EditorActions | null>(null)
export const EditorActionsProvider = editorActionsContext.Provider as Provider<EditorActions | null>

export function useEditorActions() {
  return useContext(editorActionsContext)
}
