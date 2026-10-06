import type { NamedDocument } from './storage'

// BroadcastChannel both app windows use to announce named-document writes so
// the other window refreshes its in-memory copies from IndexedDB.
export const NAMED_DOCS_CHANNEL = 'notes-named-docs'

// A note belongs in the floating todo window when its title starts with
// "todo" — trimmed, case-insensitive — so "todo", "Todo", "todos", and
// "todo-work" all count.
export function isTodoNote(note: Pick<NamedDocument, 'title' | 'deleted'>) {
  return !note.deleted && note.title.trim().toLocaleLowerCase().startsWith('todo')
}

export function compareTodoNotes(a: NamedDocument, b: NamedDocument) {
  return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id)
}
