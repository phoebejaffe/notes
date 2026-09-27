import { useRef, useState } from 'react'
import { BoldItalicUnderlineToggles, ListsToggle } from '@mdxeditor/editor'
import { useEditorActions } from './editorActions'

function MuteIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M22 10.5V12C22 16.714 22 19.071 20.536 20.536C19.071 22 16.714 22 12 22C7.286 22 4.929 22 3.464 20.536C2 19.071 2 4.929 3.464 3.464C4.929 3.464 7.286 2 12 2H13.5" /><path d="M22 2L17 7M17 2L22 7" /></svg>
}

function MoveIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3V9M12 3L9 6M12 3L15 6M12 15V21M12 21L15 18M12 21L9 18M3 12H9M3 12L6 15M3 12L6 9M15 12H21M21 12L18 9M21 12L18 15" /></svg>
}

type GestureDirection = 'up' | 'down' | 'indent' | 'outdent'

const GESTURE_LOCK_PX = 16
const GESTURE_REPEAT_PX = 48

// Mobile-only line-manipulation control (shown via @media pointer: coarse).
// A tap does nothing; a drag past the lock threshold fires a gesture event —
// up/down move the selected lines (same as Option-Arrow), left/right outdent
// and indent — then repeats once per additional drag stride.
function GestureMoveButton() {
  const dragRef = useRef<{ x: number; y: number; direction: GestureDirection | null; lastStep: number } | null>(null)

  function fire(target: HTMLElement, direction: GestureDirection) {
    target.dispatchEvent(new CustomEvent('notes-line-gesture', { detail: { direction }, bubbles: true }))
  }

  return <button
    className="notes-editor-toolbar-button notes-editor-gesture-button"
    type="button"
    aria-label="Move or indent lines"
    title="Drag up/down to move lines, left/right to indent"
    onPointerDown={(event) => {
      event.preventDefault()
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Synthetic pointer events have no live pointer to capture.
      }
      dragRef.current = { x: event.clientX, y: event.clientY, direction: null, lastStep: 0 }
    }}
    onPointerMove={(event) => {
      const drag = dragRef.current
      if (!drag) return
      const dx = event.clientX - drag.x
      const dy = event.clientY - drag.y
      const travel = Math.max(Math.abs(dx), Math.abs(dy))
      if (!drag.direction) {
        if (travel < GESTURE_LOCK_PX) return
        drag.direction = Math.abs(dy) >= Math.abs(dx) ? (dy < 0 ? 'up' : 'down') : (dx < 0 ? 'outdent' : 'indent')
      } else if (travel - drag.lastStep < GESTURE_REPEAT_PX) {
        return
      }
      drag.lastStep = travel
      fire(event.currentTarget, drag.direction)
    }}
    onPointerUp={() => { dragRef.current = null }}
    onPointerCancel={() => { dragRef.current = null }}
  ><MoveIcon /></button>
}

function AddTagControl() {
  const [tag, setTag] = useState('')
  const [open, setOpen] = useState(false)
  const actions = useEditorActions()
  const preservedRangeRef = useRef<Range | null>(null)

  function captureEditorSelection() {
    const selection = window.getSelection()
    const anchor = selection?.anchorNode
    const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement
    preservedRangeRef.current = selection && selection.rangeCount > 0 && !selection.isCollapsed && anchorElement?.closest('.mdxeditor-root-contenteditable')
      ? selection.getRangeAt(0).cloneRange()
      : null
  }

  function showPreservedSelection() {
    const range = preservedRangeRef.current
    preservedRangeRef.current = null
    if (range && typeof Highlight !== 'undefined') {
      CSS.highlights.set('notes-preserved-selection', new Highlight(range))
    }
  }

  function clearPreservedSelection() {
    CSS.highlights?.delete('notes-preserved-selection')
  }

  function submit(value = tag) {
    const normalized = value.trim()
    if (!normalized) return
    actions?.addTag(normalized)
    setTag('')
    setOpen(false)
  }

  const recentTags = actions?.recentTags ?? []
  return <span className="notes-editor-tag-control">
    <span className="notes-editor-tag-input-wrap">
      <input value={tag} onChange={(event) => { setTag(event.target.value); setOpen(true) }} onMouseDown={captureEditorSelection} onFocus={() => { setOpen(true); showPreservedSelection() }} onBlur={() => { window.setTimeout(() => setOpen(false), 120); clearPreservedSelection() }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit() } }} aria-label="Tag name" placeholder="Add tag" />
      {open && recentTags.length > 0 && <span className="notes-editor-tag-suggestions" role="listbox">{recentTags.filter((recent) => !tag || recent.toLocaleLowerCase().includes(tag.toLocaleLowerCase())).map((recent) => <button type="button" key={recent} onMouseDown={(event) => event.preventDefault()} onClick={() => submit(recent)}>{recent}</button>)}</span>}
    </span>
    <button className="notes-editor-toolbar-button" type="button" onClick={() => submit()}>+ Tag</button>
  </span>
}

export function MdxEditorToolbar() {
  const actions = useEditorActions()
  const activeTags = actions?.activeTags ?? []
  return <>
    <BoldItalicUnderlineToggles />
    <ListsToggle options={['bullet', 'number', 'check']} />
    <button className="notes-editor-toolbar-button notes-editor-mute-button" type="button" aria-label="Mute selected lines" title="Mute selected lines" onClick={(event) => event.currentTarget.dispatchEvent(new CustomEvent('notes-mute-toggle', { bubbles: true }))}><MuteIcon /></button>
    <GestureMoveButton />
    {activeTags.length > 0 && <span className="notes-editor-active-tags" aria-label="Active tags">{activeTags.map((tag) => <span className="notes-editor-active-tag" key={tag}>{tag}<button type="button" aria-label={`Remove ${tag}`} onClick={() => actions?.removeTag(tag)}>×</button></span>)}</span>}
    <AddTagControl />
  </>
}
