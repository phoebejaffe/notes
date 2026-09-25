export interface EditorSelection {
  from: number
  to: number
}

export interface MdxNotesEditorProps {
  value: string
  onChange: (markdown: string) => void
  onSelection?: (selection: EditorSelection) => void
  autoFocus?: boolean
}
