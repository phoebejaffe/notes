import { createContext, useContext } from 'react'
import type { Provider } from 'react'

export interface EditorActions {
  activeTags: string[]
  recentTags: string[]
  addTag: (tag: string) => void
  removeTag: (tag: string) => void
  // href of the link enclosing the current editor selection, if any.
  activeLink: string | null
  // Applies/removes a link over the given DOM range (the preserved editor
  // selection — the live DOM selection lives in the popover input).
  applyLink: (url: string | null, range?: Range | null) => void
}

export const editorActionsContext = createContext<EditorActions | null>(null)
export const EditorActionsProvider = editorActionsContext.Provider as Provider<EditorActions | null>

export function useEditorActions() {
  return useContext(editorActionsContext)
}
