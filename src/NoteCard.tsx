import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { MdxNotesEditor } from './editor/MdxNotesEditor'
import { parseMarkdown } from './markerEngine'
import type { NamedDocument } from './storage'

export type NoteMoveTarget = 'up' | 'down' | 'left' | 'right' | 'new-lane'

interface NoteCardProps {
  note: NamedDocument
  laneCount: number
  laneSize: number
  hideMutedLines: boolean
  tagColors: Record<string, string>
  findActive?: boolean
  onChange: (id: string, markdown: string) => void
  onRename: (id: string, title: string) => void
  onToggleCollapsed: (id: string) => void
  onMoveNote: (id: string, target: NoteMoveTarget) => void
  onReorderPreview: (id: string, index: number) => void
  onReorderCommit: () => void
  onDelete: (id: string) => void
}

export function NoteCard({ note, laneCount, laneSize, hideMutedLines, tagColors, findActive = false, onChange, onRename, onToggleCollapsed, onMoveNote, onReorderPreview, onReorderCommit, onDelete }: NoteCardProps) {
  const cardRef = useRef<HTMLElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [dragging, setDragging] = useState(false)
  const parsed = parseMarkdown(note.markdown)

  useEffect(() => {
    if (!menuOpen) return
    function close(event: MouseEvent | KeyboardEvent) {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      const card = cardRef.current
      if (event instanceof MouseEvent && card?.contains(event.target as Node)) return
      setMenuOpen(false)
      setConfirmingDelete(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
    }
  }, [menuOpen])

  // Pointer-based vertical drag reorder: live-preview the insertion index
  // against sibling card midpoints, commit on release. Works for touch and
  // mouse; the ⋯ menu is the accessible fallback.
  function handleDragStart(event: ReactPointerEvent<HTMLButtonElement>) {
    const card = cardRef.current
    const stream = card?.parentElement
    if (!card || !stream) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    setDragging(true)

    const siblings = () => [...stream.querySelectorAll<HTMLElement>('.note-card')].filter((element) => element !== card)
    const preview = (clientY: number) => {
      const index = siblings().filter((element) => clientY > element.getBoundingClientRect().top + element.getBoundingClientRect().height / 2).length
      onReorderPreview(note.id, index)
    }
    const move = (moveEvent: PointerEvent) => preview(moveEvent.clientY)
    const end = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      setDragging(false)
      onReorderCommit()
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  const menuItem = (label: string, action: () => void, disabled = false) => (
    <button type="button" disabled={disabled} onClick={() => { setMenuOpen(false); setConfirmingDelete(false); action() }}>{label}</button>
  )

  return <article className={`note-card${dragging ? ' note-card-dragging' : ''}${note.collapsed ? ' note-card-collapsed' : ''}`} data-note-id={note.id} ref={cardRef}>
    <div className="editor-card">
      <div className="note-heading">
        <button className="note-drag" type="button" aria-label={`Drag ${note.title || 'untitled note'} to reorder`} onPointerDown={handleDragStart} onClick={(event) => event.preventDefault()}>⠿</button>
        {renaming
          ? <input className="note-title-input" autoFocus defaultValue={note.title} placeholder="Note title"
              onBlur={(event) => { setRenaming(false); onRename(note.id, event.target.value) }}
              onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') setRenaming(false) }}
              aria-label="Note title" />
          : <button className="note-title" type="button" onClick={() => onToggleCollapsed(note.id)} aria-expanded={!note.collapsed}>
              <span className="note-chevron" aria-hidden="true">{note.collapsed ? '▸' : '▾'}</span>{note.title || <em>Untitled note</em>}
            </button>}
        <div className="note-menu-wrap">
          <button className="icon-button" type="button" aria-label={`Menu for ${note.title || 'untitled note'}`} aria-expanded={menuOpen} onClick={() => { setMenuOpen((open) => !open); setConfirmingDelete(false) }}>⋯</button>
          {menuOpen && <nav className="menu-panel note-menu" aria-label="Note actions">
            {menuItem('Rename', () => setRenaming(true))}
            {menuItem(note.collapsed ? 'Expand' : 'Collapse', () => onToggleCollapsed(note.id))}
            {menuItem('Move up', () => onMoveNote(note.id, 'up'), note.order === 0)}
            {menuItem('Move down', () => onMoveNote(note.id, 'down'), note.order >= laneSize - 1)}
            {menuItem('Move left', () => onMoveNote(note.id, 'left'), note.lane <= 1)}
            {menuItem('Move right', () => onMoveNote(note.id, 'right'), note.lane >= laneCount)}
            {menuItem('Move to new lane', () => onMoveNote(note.id, 'new-lane'))}
            {confirmingDelete
              ? <button className="note-delete-confirm" type="button" onClick={() => onDelete(note.id)}>Delete permanently?</button>
              : <button type="button" onClick={() => setConfirmingDelete(true)}>Delete note</button>}
          </nav>}
        </div>
      </div>
      {!note.collapsed && <MdxNotesEditor value={note.markdown} onChange={(markdown) => onChange(note.id, markdown)} hideMutedLines={hideMutedLines} tagColors={tagColors} findActive={findActive} />}
      {!note.collapsed && parsed.diagnostics.length > 0 && <div className="diagnostics">{parsed.diagnostics.map((diagnostic) => <div key={`${diagnostic.line}-${diagnostic.message}`}>Line {diagnostic.line + 1}: {diagnostic.message}</div>)}</div>}
    </div>
  </article>
}
