import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { MdxNotesEditor } from './editor/MdxNotesEditor'
import { parseMarkdown } from './markerEngine'
import { loadPreferences, savePreferences, type Preferences } from './preferences'
import { matchesShortcut } from './shortcuts'
import { listNamedDocuments, saveNamedDocument, type NamedDocument } from './storage'
import { compareTodoNotes, isTodoNote, NAMED_DOCS_CHANNEL } from './todoNotes'

const isTauri = '__TAURI_INTERNALS__' in window

function loadTagColors() {
  try {
    return JSON.parse(localStorage.getItem('notes-tag-colors') ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

// A slim NoteCard without lane chrome (no drag handle, no ⋯ menu): title
// toggles collapse, body is the shared Markdown editor.
function TodoNoteCard({ note, tagColors, onChange, onToggleCollapsed }: {
  note: NamedDocument
  tagColors: Record<string, string>
  onChange: (id: string, markdown: string) => void
  onToggleCollapsed: (id: string) => void
}) {
  const parsed = parseMarkdown(note.markdown)
  return <article className={`note-card${note.collapsed ? ' note-card-collapsed' : ''}`} data-note-id={note.id}>
    <div className="editor-card">
      <div className="note-heading">
        <button className="note-title" type="button" onClick={() => onToggleCollapsed(note.id)} aria-expanded={!note.collapsed}>
          <span className="note-chevron" aria-hidden="true">{note.collapsed ? '▸' : '▾'}</span>{note.title || <em>Untitled note</em>}
        </button>
      </div>
      {!note.collapsed && <MdxNotesEditor value={note.markdown} onChange={(markdown) => onChange(note.id, markdown)} tagColors={tagColors} />}
      {!note.collapsed && parsed.diagnostics.length > 0 && <div className="diagnostics">{parsed.diagnostics.map((diagnostic) => <div key={`${diagnostic.line}-${diagnostic.message}`}>Line {diagnostic.line + 1}: {diagnostic.message}</div>)}</div>}
    </div>
  </article>
}

// The floating todo window (?mode=todo): every non-deleted named note whose
// title starts with "todo", stacked alphabetically. Writes go straight to the
// shared IndexedDB store and a BroadcastChannel ping keeps the main window's
// copies fresh; the main window stays the single cloud-sync writer.
export function TodoWindow() {
  const [preferences, setPreferences] = useState<Preferences>(loadPreferences)
  const [tagColors, setTagColors] = useState<Record<string, string>>(loadTagColors)
  const [namedDocs, setNamedDocs] = useState<Record<string, NamedDocument>>({})
  const namedDocsRef = useRef<Record<string, NamedDocument>>({})
  // Pending writes are the fields this window owns — the save merges them onto
  // whatever is stored, so newer title/lane/order from the main window is
  // never clobbered.
  const pendingWritesRef = useRef(new Map<string, Partial<NamedDocument>>())
  const channelRef = useRef<BroadcastChannel | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus())

  const todos = useMemo(() => Object.values(namedDocs).filter(isTodoNote).sort(compareTodoNotes), [namedDocs])

  function writeNamedDoc(note: NamedDocument) {
    namedDocsRef.current = { ...namedDocsRef.current, [note.id]: note }
    setNamedDocs(namedDocsRef.current)
  }

  function queueWrite(id: string, fields: Partial<NamedDocument>) {
    pendingWritesRef.current.set(id, { ...pendingWritesRef.current.get(id), ...fields })
  }

  // Adopt records another window wrote after our local copy — by updatedAt —
  // and mirror removals. Records with unsaved local edits are skipped so a
  // refresh can't swallow in-flight keystrokes.
  const refreshNamedDocuments = useCallback(() => {
    void listNamedDocuments().then((stored) => {
      const current = namedDocsRef.current
      const next = { ...current }
      const storedIds = new Set(stored.map((note) => note.id))
      let changed = false
      for (const note of stored) {
        const local = current[note.id]
        if (pendingWritesRef.current.has(note.id)) continue
        if (!local || note.updatedAt > local.updatedAt) {
          next[note.id] = note
          changed = true
        }
      }
      for (const id of Object.keys(next)) {
        if (!storedIds.has(id) && !pendingWritesRef.current.has(id)) {
          delete next[id]
          changed = true
        }
      }
      if (changed) {
        namedDocsRef.current = next
        setNamedDocs(next)
      }
    }).catch(() => undefined)
  }, [])

  useEffect(() => {
    void listNamedDocuments().then((stored) => {
      const records = Object.fromEntries(stored.map((note) => [note.id, note]))
      namedDocsRef.current = records
      setNamedDocs(records)
      setLoaded(true)
    }).catch(() => setLoaded(true))
  }, [])

  // Persist local writes debounced, then ping the other window(s).
  useEffect(() => {
    if (!loaded) return
    const timer = window.setTimeout(() => {
      const pending = [...pendingWritesRef.current.entries()]
      if (!pending.length) return
      pendingWritesRef.current.clear()
      Promise.all(pending.map(([id, fields]) => saveNamedDocument({ id, ...fields }))).then(() => channelRef.current?.postMessage('changed')).catch(() => undefined)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [namedDocs, loaded])

  useEffect(() => {
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(NAMED_DOCS_CHANNEL)
    channelRef.current = channel
    if (channel) channel.onmessage = () => refreshNamedDocuments()
    window.addEventListener('focus', refreshNamedDocuments)
    return () => {
      channel?.close()
      channelRef.current = null
      window.removeEventListener('focus', refreshNamedDocuments)
    }
  }, [refreshNamedDocuments])

  useEffect(() => {
    const onFocus = () => setWindowFocused(true)
    const onBlur = () => setWindowFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // Preferences live in the shared localStorage blob — the storage event fires
  // in the *other* window, so theme/font/zoom edits propagate live. Tag colors
  // ride along on their own key.
  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key === 'notes-preferences') setPreferences(loadPreferences())
      if (event.key === 'notes-tag-colors') setTagColors(loadTagColors())
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  // Zoom in this window adjusts todoZoomLevel only. Patch just that field into
  // the shared blob — this window's other preference values may be stale.
  const setTodoZoom = useCallback((level: number) => {
    const todoZoomLevel = Math.min(150, Math.max(60, Math.round(level / 10) * 10))
    setPreferences((current) => ({ ...current, todoZoomLevel }))
    savePreferences({ ...loadPreferences(), todoZoomLevel })
  }, [])

  useEffect(() => {
    function handleZoomShortcuts(event: KeyboardEvent) {
      if (matchesShortcut(event, preferences.shortcuts.zoomIn)) {
        event.preventDefault()
        setTodoZoom(preferences.todoZoomLevel + 10)
      } else if (matchesShortcut(event, preferences.shortcuts.zoomOut)) {
        event.preventDefault()
        setTodoZoom(preferences.todoZoomLevel - 10)
      }
    }
    window.addEventListener('keydown', handleZoomShortcuts, true)
    return () => window.removeEventListener('keydown', handleZoomShortcuts, true)
  }, [preferences.shortcuts.zoomIn, preferences.shortcuts.zoomOut, preferences.todoZoomLevel, setTodoZoom])

  // The native side emits this when the global shortcut focuses the window —
  // land the caret at the top of the first todo editor.
  useEffect(() => {
    if (!isTauri) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void listen('todo-window-focus', () => {
      window.setTimeout(() => {
        const host = document.querySelector<HTMLElement>('.todo-stream .notes-mdx-editor')
        host?.dispatchEvent(new CustomEvent('notes-focus-edge', { detail: { edge: 'start' }, bubbles: false }))
      }, 0)
    }).then((cleanup) => {
      if (disposed) cleanup()
      else unlisten = cleanup
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  function updateNoteMarkdown(id: string, markdown: string) {
    const note = namedDocsRef.current[id]
    if (!note) return
    const updatedAt = Date.now()
    writeNamedDoc({ ...note, markdown, updatedAt })
    queueWrite(id, { markdown, updatedAt })
  }

  function toggleNoteCollapsed(id: string) {
    const note = namedDocsRef.current[id]
    if (!note) return
    const updatedAt = Date.now()
    writeNamedDoc({ ...note, collapsed: !note.collapsed, updatedAt })
    queueWrite(id, { collapsed: !note.collapsed, updatedAt })
  }

  function createTodoNote() {
    const notes = Object.values(namedDocsRef.current)
    const order = notes.filter((note) => note.lane === 1 && !note.deleted).length
    const note: NamedDocument = { id: crypto.randomUUID(), title: 'todo', markdown: '', lane: 1, order, collapsed: false, updatedAt: Date.now() }
    writeNamedDoc(note)
    queueWrite(note.id, note)
  }

  if (!loaded) return <main className="loading-screen">Opening your notes…</main>

  return (
    <main className={`todo-shell theme-${preferences.theme}${preferences.compactSpacing ? ' compact-spacing' : ''} font-${preferences.fontChoice}${!windowFocused ? ' capture-unfocused' : ''}`} style={{ '--editor-zoom': preferences.todoZoomLevel / 100, opacity: isTauri && preferences.windowOpacityEnabled ? preferences.windowOpacity / 100 : 1 } as CSSProperties}>
      <div className="todo-menu">
        <span className="todo-menu-title">Todo</span>
        {isTauri && <button className="icon-button" type="button" aria-label="Hide todo window" onClick={() => void invoke('toggle_todo_window_command')} title="Hide (⌃⌥⌘T)">×</button>}
      </div>
      <div className="note-stream todo-stream">
        {todos.map((note) => (
          <TodoNoteCard key={note.id} note={note} tagColors={tagColors} onChange={updateNoteMarkdown} onToggleCollapsed={toggleNoteCollapsed} />
        ))}
        {!todos.length && <div className="todo-empty">
          <p className="todo-empty-title">No todo notes yet</p>
          <p>Name a note “todo” and it appears here.</p>
          <button className="lane-add todo-add" type="button" onClick={createTodoNote}>+ New todo note</button>
        </div>}
      </div>
    </main>
  )
}
