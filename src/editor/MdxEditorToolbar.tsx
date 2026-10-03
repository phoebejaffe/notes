import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BoldItalicUnderlineToggles, ListsToggle } from '@mdxeditor/editor'
import { formatUrl } from '@lexical/link'
import { useEditorActions } from './editorActions'

// The DOM selection inside an editor's contenteditable, cloned for later use —
// focusing a toolbar input moves the live selection out of the editor.
function editorSelectionRange() {
  const selection = window.getSelection()
  const anchor = selection?.anchorNode
  const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement
  return selection && selection.rangeCount > 0 && anchorElement?.closest('.mdxeditor-root-contenteditable')
    ? selection.getRangeAt(0).cloneRange()
    : null
}

function showPreservedSelection(range: Range | null) {
  if (range && typeof Highlight !== 'undefined') {
    CSS.highlights.set('notes-preserved-selection', new Highlight(range))
  }
}

function clearPreservedSelection() {
  CSS.highlights?.delete('notes-preserved-selection')
}

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
    preservedRangeRef.current = selection && selection.rangeCount > 0 && !selection.isCollapsed
      ? editorSelectionRange()
      : null
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
      <input value={tag} onChange={(event) => { setTag(event.target.value); setOpen(true) }} onMouseDown={captureEditorSelection} onFocus={() => { setOpen(true); showPreservedSelection(preservedRangeRef.current) }} onBlur={() => { window.setTimeout(() => setOpen(false), 120); clearPreservedSelection() }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit() } }} aria-label="Tag name" placeholder="Add tag" />
      {open && recentTags.length > 0 && <span className="notes-editor-tag-suggestions" role="listbox">{recentTags.filter((recent) => !tag || recent.toLocaleLowerCase().includes(tag.toLocaleLowerCase())).map((recent) => <button type="button" key={recent} onMouseDown={(event) => event.preventDefault()} onClick={() => submit(recent)}>{recent}</button>)}</span>}
    </span>
    <button className="notes-editor-toolbar-button" type="button" onClick={() => submit()}>+ Tag</button>
  </span>
}

function LinkIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
}

// Link button + popover: applies a URL to the preserved editor selection, or
// edits/removes the link under the caret. The popover portals to the editor
// host — inside the toolbar it would be clipped by overflow-x and trapped in
// the bar's stacking context below the lane UI, while the host keeps
// :focus-within (and theme inheritance) for the input.
function LinkControl() {
  const actions = useEditorActions()
  const wrapRef = useRef<HTMLSpanElement>(null)
  const preservedRangeRef = useRef<Range | null>(null)
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [popoverHost, setPopoverHost] = useState<HTMLElement | null>(null)
  const [anchor, setAnchor] = useState<{ left: number; top?: number; bottom?: number } | null>(null)

  function openPopover() {
    preservedRangeRef.current = editorSelectionRange()
    setUrl(actions?.activeLink ?? '')
    const wrap = wrapRef.current
    const rect = wrap?.getBoundingClientRect()
    if (rect) {
      const style = window.innerHeight - rect.bottom >= 60
        ? { left: rect.left, top: rect.bottom + 6 }
        : { left: rect.left, bottom: window.innerHeight - rect.top + 6 }
      setAnchor(style)
      setPopoverHost(wrap?.closest<HTMLElement>('.notes-mdx-editor') ?? document.body)
    }
    setOpen(true)
  }

  function close() {
    setOpen(false)
    clearPreservedSelection()
  }

  function save() {
    const normalized = url.trim()
    if (!normalized) return
    actions?.applyLink(formatUrl(normalized), preservedRangeRef.current)
    close()
  }

  function remove() {
    actions?.applyLink(null, preservedRangeRef.current)
    close()
  }

  return <span className="notes-editor-link-control" ref={wrapRef}>
    <button
      className="notes-editor-toolbar-button"
      type="button"
      aria-label="Edit link"
      aria-expanded={open}
      title="Add or edit link"
      data-state={actions?.activeLink ? 'on' : undefined}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => (open ? close() : openPopover())}
    ><LinkIcon /></button>
    {open && popoverHost && createPortal(<span className="notes-editor-link-popover" style={anchor ?? undefined}>
      <input
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        onFocus={() => showPreservedSelection(preservedRangeRef.current)}
        onBlur={() => window.setTimeout(close, 120)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); save() }
          else if (event.key === 'Escape') { event.preventDefault(); close() }
        }}
        aria-label="Link URL"
        placeholder="https://example.com"
        autoFocus
      />
      <button className="notes-editor-toolbar-button" type="button" disabled={!url.trim()} onMouseDown={(event) => event.preventDefault()} onClick={save}>Save</button>
      <button className="notes-editor-toolbar-button" type="button" onMouseDown={(event) => event.preventDefault()} onClick={remove}>Remove</button>
    </span>, popoverHost)}
  </span>
}

export function MdxEditorToolbar() {
  const actions = useEditorActions()
  const activeTags = actions?.activeTags ?? []
  return <>
    <BoldItalicUnderlineToggles />
    <ListsToggle options={['bullet', 'number', 'check']} />
    <LinkControl />
    <button className="notes-editor-toolbar-button notes-editor-mute-button" type="button" aria-label="Mute selected lines" title="Mute selected lines" onClick={(event) => event.currentTarget.dispatchEvent(new CustomEvent('notes-mute-toggle', { bubbles: true }))}><MuteIcon /></button>
    <GestureMoveButton />
    {activeTags.length > 0 && <span className="notes-editor-active-tags" aria-label="Active tags">{activeTags.map((tag) => <span className="notes-editor-active-tag" key={tag}>{tag}<button type="button" aria-label={`Remove ${tag}`} onClick={() => actions?.removeTag(tag)}>×</button></span>)}</span>}
    <AddTagControl />
  </>
}
