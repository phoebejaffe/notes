import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { MDXEditor, type MDXEditorMethods } from '@mdxeditor/editor'
import { $createParagraphNode, $createRangeSelection, $getNearestNodeFromDOMNode, $getNodeByKey, $getRoot, $setSelection, type LexicalEditor } from 'lexical'
import { $getNearestNodeOfType } from '@lexical/utils'
import { INSERT_CHECK_LIST_COMMAND, ListItemNode } from '@lexical/list'
import { mdxEditorPlugins } from './mdxEditorPlugins'
import { markdownForEditor, restoreMarkdownSpacing } from './markdownSpacing'
import { buildDocumentMap, contentEditable, placeCaretAtCanonicalLine, reapplyUntilSettled, selectCanonicalLines, selectionLineRange, type SelectionLineRange } from './sourceMapping'
import { clearMutedDecorations, inHiddenMutedRange, nearestVisibleLine, refreshMutedDecorations } from './mutedDecorations'
import { addTagDirectiveToRange, checklistToPlainText, moveLinesDetailed, parseMarkdown, preserveMutedLines, removeChecklist, removeTagAtPosition, toggleMutedLines } from '../markerEngine'

import { $isTagBlockNode } from './TagBlockNode'
import { EditorActionsProvider, type EditorActions } from './editorActions'
import type { MdxNotesEditorProps } from './editorTypes'

type Restore =
  | { type: 'caret'; line: number; offset: number }
  | { type: 'range'; startLine: number; endLine: number }

const RECENT_TAGS_KEY = 'notes-recent-tags'

// Top-level editable blocks. Paragraphs nested in list items, blockquotes, or
// tag directives are part of their container block, so they're excluded.
const TOP_LEVEL_BLOCK_SELECTOR = '.notes-tag-directive, h1,h2,h3,h4,h5,h6,li,blockquote,pre,p:not(li p):not(blockquote p):not(.notes-tag-directive p)'

function topLevelBlocks(content: HTMLElement | null | undefined) {
  return [...content?.querySelectorAll<HTMLElement>(TOP_LEVEL_BLOCK_SELECTOR) ?? []]
}

function loadRecentTags() {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_TAGS_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string') : []
  } catch {
    return []
  }
}

function tagColor(tag: string, colors: Record<string, string>) {
  if (colors[tag]) return colors[tag]
  const palette = ['#6d9b91', '#8975aa', '#c88968', '#7190b0', '#b28a55']
  return palette[[...tag].reduce((sum, character) => sum + character.codePointAt(0)!, 0) % palette.length]
}

// Tag chips and borders are pure CSS on .notes-tag-directive; only the color
// needs JS since it comes from a prop. Writing the custom property only when
// it differs keeps Lexical's mutation observer quiet.
function applyTagColors(host: HTMLElement, colors: Record<string, string>) {
  host.querySelectorAll<HTMLElement>('.notes-tag-directive').forEach((element) => {
    const name = element.getAttribute('data-tag-tag') ?? ''
    const color = tagColor(name, colors)
    if (element.style.getPropertyValue('--notes-tag-color') !== color) {
      element.style.setProperty('--notes-tag-color', color)
    }
  })
}

// A linked `__` marks a line written by the ring transcription workflow. Each
// gets a `≈` overlay centered on the editor's left border at the link's row.
// Markers are appended to the host — outside the contenteditable — so Lexical
// never reconciles them, and are reused per anchor to avoid DOM churn.
const audioMarkersByHost = new WeakMap<HTMLElement, Map<HTMLAnchorElement, HTMLElement>>()

function refreshAudioMarkers(host: HTMLElement) {
  let markers = audioMarkersByHost.get(host)
  if (!markers) {
    markers = new Map()
    audioMarkersByHost.set(host, markers)
  }
  const hostTop = host.getBoundingClientRect().top
  const seen = new Set<HTMLAnchorElement>()
  host.querySelectorAll('a').forEach((anchor) => {
    if (!/^_+$/u.test(anchor.textContent ?? '')) return
    const rect = anchor.getBoundingClientRect()
    // Ghosted muted lines (soft-break lines in partially muted paragraphs)
    // keep layout but shouldn't show a marker while muted content is hidden.
    if (!rect.height || inHiddenMutedRange(host, anchor)) return
    seen.add(anchor)
    let marker = markers.get(anchor)
    if (!marker) {
      marker = document.createElement('span')
      marker.className = 'notes-audio-marker'
      marker.textContent = '≈'
      host.appendChild(marker)
      markers.set(anchor, marker)
    }
    const top = `${(rect.top + rect.height / 2 - hostTop).toFixed(1)}px`
    if (marker.style.top !== top) marker.style.top = top
  })
  markers.forEach((marker, anchor) => {
    if (!seen.has(anchor)) {
      marker.remove()
      markers.delete(anchor)
    }
  })
}

// Rendered text leaves of the editor in document order, skipping empty text
// and nodes with no layout (e.g. hidden muted blocks).
function renderedTextLeaves(container: HTMLElement): Node[] {
  const leaves: Node[] = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const range = document.createRange()
    range.selectNodeContents(node)
    if (range.getClientRects().length) leaves.push(node)
  }
  return leaves
}

// The caret is at the editor's visual top/bottom edge when its rect sits on
// the same rendered line as the first/last text line in the whole editor —
// including lines inside nested directive editors.
function caretAtEditorEdge(host: HTMLElement, direction: 'up' | 'down'): boolean {
  const selection = window.getSelection()
  if (!selection?.isCollapsed || !selection.anchorNode || !selection.rangeCount) return false
  const outer = contentEditable(host)
  if (!outer?.contains(selection.anchorNode)) return false
  const leaves = renderedTextLeaves(outer)
  const leaf = direction === 'up' ? leaves[0] : leaves[leaves.length - 1]
  // No rendered text (empty editor or every line muted-and-hidden): the caret
  // counts as sitting at both edges, so either arrow crosses out.
  if (!leaf) return true
  const range = document.createRange()
  range.selectNodeContents(leaf)
  const rects = range.getClientRects()
  const edgeRect = direction === 'up' ? rects[0] : rects[rects.length - 1]
  // A collapsed caret in an empty block (<p><br></p>) reports a zero rect —
  // fall back to the anchor element's box so edge detection still works there.
  let caretRect = selection.getRangeAt(0).getBoundingClientRect()
  if (!caretRect.top && !caretRect.bottom && !caretRect.height) {
    const anchorElement = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode.parentElement
    const fallback = anchorElement?.getBoundingClientRect()
    if (fallback) caretRect = fallback
  }
  const lineHeight = Math.max(edgeRect.height, caretRect.height, 1)
  return direction === 'up'
    ? caretRect.top <= edgeRect.top + lineHeight * 0.5
    : caretRect.bottom >= edgeRect.bottom - lineHeight * 0.5
}

function focusAdjacentEditor(host: HTMLElement, direction: 'up' | 'down') {
  const card = host.closest<HTMLElement>('.day-card')
  const cards = [...(card?.parentElement?.querySelectorAll<HTMLElement>('.day-card') ?? [])]
  const index = card ? cards.indexOf(card) : -1
  const targetEditor = (direction === 'up' ? cards[index - 1] : cards[index + 1])?.querySelector<HTMLElement>('.notes-mdx-editor')
  // Carry the caret's x across so the destination can land on the same
  // horizontal position, like vertical movement within a paragraph. A caret
  // in an empty block reports a zero rect — use the anchor element's box.
  const selection = window.getSelection()
  let x: number | undefined
  if (selection?.rangeCount) {
    const rect = selection.getRangeAt(0).getBoundingClientRect()
    const anchorElement = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement
    x = rect.width || rect.height ? rect.left : anchorElement?.getBoundingClientRect().left
  }
  targetEditor?.dispatchEvent(new CustomEvent('notes-focus-edge', { detail: { direction, x }, bubbles: false }))
}

export function MdxNotesEditor({ value, onChange, autoFocus = false, hideMutedLines = false, tagColors = {} }: MdxNotesEditorProps) {
  const editorRef = useRef<MDXEditorMethods>(null)
  const lexicalEditorRef = useMemo(() => ({ current: null as LexicalEditor | null }), [])
  const hostRef = useRef<HTMLDivElement>(null)
  const valueRef = useRef(value)
  const onChangeRef = useRef(onChange)
  const hideMutedLinesRef = useRef(hideMutedLines)
  const tagColorsRef = useRef(tagColors)
  const userInteractedRef = useRef(false)
  const lastRangeRef = useRef<SelectionLineRange | null>(null)
  const boundaryParagraphRef = useRef<{ key: string; armed: boolean } | null>(null)
  const commitRef = useRef<((markdown: string, restore?: Restore) => void) | null>(null)
  // Lexical's history can't see source-space commits (e.g. muting strips `%%`
  // before the editor sees it, leaving an identical Lexical state), so commits
  // keep their own undo stack. Meta/Ctrl+Z pops it only when the most recent
  // change was a commit; typing undos stay with Lexical.
  const undoStackRef = useRef<Array<{ source: string; range: SelectionLineRange | null; prevOp: string }>>([])
  const lastOpRef = useRef<'commit' | 'lexical' | 'external'>('lexical')
  const [activeTags, setActiveTags] = useState<string[]>([])
  const [recentTags, setRecentTags] = useState<string[]>(loadRecentTags)

  useEffect(() => {
    tagColorsRef.current = tagColors
  }, [tagColors])

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const markInteraction = (event: Event) => {
      if (host.contains(event.target as Node)) userInteractedRef.current = true
    }
    host.addEventListener('beforeinput', markInteraction)
    host.addEventListener('keydown', markInteraction)
    host.addEventListener('paste', markInteraction)
    host.addEventListener('pointerdown', markInteraction, true)
    host.addEventListener('click', markInteraction)
    return () => {
      host.removeEventListener('beforeinput', markInteraction)
      host.removeEventListener('keydown', markInteraction)
      host.removeEventListener('paste', markInteraction)
      host.removeEventListener('pointerdown', markInteraction, true)
      host.removeEventListener('click', markInteraction)
    }
  }, [])

  // Muted-line decorations are recomputed from the canonical source whenever
  // it changes — CSS highlight ranges track DOM text, so they must be rebuilt
  // after every re-import. Retried over frames for decorator content.
  // Only reads refs, so it is safe to call from any effect or handler.
  const refreshDecorations = () => {
    const host = hostRef.current
    if (!host) return
    const apply = () => {
      refreshMutedDecorations(host, valueRef.current, hideMutedLinesRef.current)
      applyTagColors(host, tagColorsRef.current)
      refreshAudioMarkers(host)
    }
    apply()
    requestAnimationFrame(apply)
    requestAnimationFrame(() => requestAnimationFrame(apply))
  }
  const refreshDecorationsRef = useRef(refreshDecorations)
  useEffect(() => {
    refreshDecorationsRef.current = refreshDecorations
  })

  useEffect(() => {
    hideMutedLinesRef.current = hideMutedLines
    const host = hostRef.current
    if (!host) return
    // Note the caret's canonical line before hiding collapses blocks, then
    // restore it — on the nearest still-visible line if its own disappeared.
    const map = buildDocumentMap(valueRef.current)
    const range = selectionLineRange(host, map)
    refreshDecorationsRef.current()
    if (!range) return
    const line = hideMutedLines ? nearestVisibleLine(valueRef.current, range.startLine) : range.startLine
    const offset = line === range.startLine ? range.caretOffset : 0
    reapplyUntilSettled(() => placeCaretAtCanonicalLine(host, map, line, offset))
  }, [hideMutedLines])

  useEffect(() => {
    refreshDecorationsRef.current()
    const host = hostRef.current
    // Marker positions depend on line wrapping, so refresh on layout changes.
    const observer = new ResizeObserver(() => refreshDecorationsRef.current())
    if (host) observer.observe(host)
    return () => {
      observer.disconnect()
      if (host) clearMutedDecorations(host)
    }
  }, [])

  useEffect(() => {
    if (valueRef.current === value) return
    const host = hostRef.current
    // External update (sync/merge): capture the caret's canonical line in the
    // outgoing source so the re-import doesn't yank it mid-typing.
    const range = host && contentEditable(host)?.contains(window.getSelection()?.anchorNode ?? null)
      ? selectionLineRange(host, buildDocumentMap(valueRef.current))
      : null
    valueRef.current = value
    editorRef.current?.setMarkdown(markdownForEditor(value).markdown)
    lastOpRef.current = 'external'
    refreshDecorationsRef.current()
    if (range && host) {
      const map = buildDocumentMap(value)
      reapplyUntilSettled(() => placeCaretAtCanonicalLine(host, map, range.startLine, range.caretOffset))
    }
  }, [value])

  // Editor commands run on keydown capture so Lexical never sees them. Line
  // edits are applied to the canonical Markdown and re-imported; the caret or
  // selection is then restored by mapping canonical lines back through mdast
  // source positions (see sourceMapping.ts).
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const commit = (markdown: string, restore?: Restore) => {
      const map = buildDocumentMap(valueRef.current)
      undoStackRef.current.push({
        source: valueRef.current,
        range: selectionLineRange(host, map),
        prevOp: lastOpRef.current,
      })
      lastOpRef.current = 'commit'
      valueRef.current = markdown
      editorRef.current?.setMarkdown(markdownForEditor(markdown).markdown)
      onChangeRef.current(markdown)
      if (!restore) return
      const nextMap = buildDocumentMap(markdown)
      reapplyUntilSettled(() => restore.type === 'caret'
        ? placeCaretAtCanonicalLine(host, nextMap, restore.line, restore.offset)
        : selectCanonicalLines(host, nextMap, restore.startLine, restore.endLine))
      refreshDecorationsRef.current()
    }
    commitRef.current = commit

    // ArrowUp at the top of a document whose first block is a tag has nowhere
    // native to go, so insert a throwaway paragraph above the tag and land the
    // caret there. It's removed once the caret leaves it while still empty.
    const firstBlockIsTag = () => {
      const first = topLevelBlocks(contentEditable(host))[0]
      return !!first?.classList.contains('notes-tag-directive')
    }

    const focusBeforeTag = () => {
      lexicalEditorRef.current?.update(() => {
        const firstChild = $getRoot().getFirstChild()
        if (!$isTagBlockNode(firstChild)) return
        const paragraph = $createParagraphNode()
        firstChild.insertBefore(paragraph)
        paragraph.selectStart()
        const key = paragraph.getKey()
        boundaryParagraphRef.current = { key, armed: false }
        // Lexical commits the new selection asynchronously; a selectionchange
        // can fire with the pre-insert anchor first. Arm the cleanup only after
        // the caret has had a frame to settle inside the boundary paragraph.
        window.requestAnimationFrame(() => {
          if (boundaryParagraphRef.current?.key === key) boundaryParagraphRef.current.armed = true
        })
      })
    }

    // Snapshot the canonical line range while the selection lives inside this
    // editor — the tag input in the toolbar keeps acting on it after focus
    // moves there. Also recomputes the active-tag chips and cleans up an empty
    // boundary paragraph once the caret leaves it.
    const updateSelection = () => {
      const content = contentEditable(host)
      const anchor = window.getSelection()?.anchorNode
      const boundary = boundaryParagraphRef.current
      if (boundary?.armed) {
        const first = topLevelBlocks(content)[0]
        if (!first || !anchor || !first.contains(anchor)) {
          boundaryParagraphRef.current = null
          const selectionLeftEditor = !anchor || !content?.contains(anchor)
          lexicalEditorRef.current?.update(() => {
            const node = $getNodeByKey(boundary.key)
            if (!node || node.getTextContent().length !== 0) return
            if (selectionLeftEditor) $setSelection(null)
            node.remove()
          })
        }
      }
      if (!content || !anchor || !content.contains(anchor)) return
      const map = buildDocumentMap(valueRef.current)
      const range = selectionLineRange(host, map)
      lastRangeRef.current = range
      const tags = range
        ? [...new Set(parseMarkdown(valueRef.current).ranges
            .filter((tagRange) => tagRange.startLine <= range.endLine && tagRange.endLine >= range.startLine)
            .map((tagRange) => tagRange.tag))]
        : []
      setActiveTags((current) => current.length === tags.length && current.every((tag, index) => tag === tags[index]) ? current : tags)
    }

    // Cmd+/ and the toolbar mute button both toggle ` %%` on the selected
    // canonical source lines.
    const muteSelection = () => {
      const map = buildDocumentMap(valueRef.current)
      const range = selectionLineRange(host, map)
      if (!range) return false
      const result = toggleMutedLines(valueRef.current, range.startLine, range.endLine)
      if (result.source === valueRef.current) return false
      commit(result.source, range.collapsed
        ? { type: 'caret', line: range.startLine, offset: range.caretOffset }
        : { type: 'range', startLine: range.startLine, endLine: range.endLine })
      return true
    }

    const lexicalPointFor = (node: Node, offset: number): [string, number, 'text' | 'element'] | null => {
      const lexicalNode = $getNearestNodeFromDOMNode(node)
      if (!lexicalNode) return null
      return [lexicalNode.getKey(), offset, node.nodeType === Node.TEXT_NODE ? 'text' : 'element']
    }

    const toggleChecklistItem = () => {
      const editor = lexicalEditorRef.current
      if (!editor) return
      const domSelection = window.getSelection()
      let insert = false
      editor.update(() => {
        const anchorNode = domSelection?.anchorNode ?? null
        const anchorLexical = anchorNode ? $getNearestNodeFromDOMNode(anchorNode) : null
        const item = anchorLexical ? $getNearestNodeOfType(anchorLexical, ListItemNode) : null
        if (item) {
          const checked = item.getChecked()
          item.setChecked(checked === undefined ? false : !checked)
        } else if (domSelection?.anchorNode && domSelection.focusNode) {
          // The Lexical selection can lag the DOM selection after a commit —
          // rebuild it from the DOM before inserting a list at the caret.
          const anchor = lexicalPointFor(domSelection.anchorNode, domSelection.anchorOffset)
          const focus = lexicalPointFor(domSelection.focusNode, domSelection.focusOffset)
          if (anchor && focus) {
            const range = $createRangeSelection()
            range.anchor.set(...anchor)
            range.focus.set(...focus)
            $setSelection(range)
            insert = true
          }
        }
      })
      if (insert) editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined)
    }

    const caretInNestedEditor = () => {
      const editable = contentEditable(host)
      const anchor = window.getSelection()?.anchorNode
      const editableAtCaret = anchor ? (anchor instanceof Element ? anchor : anchor.parentElement)?.closest('[contenteditable="true"]') : null
      return !!editable && !!editableAtCaret && editableAtCaret !== editable
    }

    // A sibling editor asks us to take focus at an edge: land the caret on
    // the first or last rendered line — at the same x position when the
    // source editor passed one, otherwise at the line's start or end — even
    // when that line lives inside a nested directive editor.
    const handleFocusEdge = (event: Event) => {
      const detail = (event as CustomEvent).detail as { direction?: 'up' | 'down'; x?: number } | undefined
      const direction = detail?.direction ?? 'down'
      userInteractedRef.current = true
      const outer = contentEditable(host)
      if (!outer) return
      const leaves = renderedTextLeaves(outer)
      const leaf = direction === 'up' ? leaves[leaves.length - 1] : leaves[0]
      if (!leaf) {
        // Empty editor — no text leaf to land on, so place the caret directly
        // at the start (or end) of the editable.
        outer.focus()
        const position = direction === 'up' ? outer.childNodes.length : 0
        window.getSelection()?.setBaseAndExtent(outer, position, outer, position)
        return
      }
      const editable = leaf.parentElement?.closest<HTMLElement>('[contenteditable="true"]') ?? outer
      editable.focus()
      if (typeof detail?.x === 'number') {
        // Hit-test the edge line's first/last visual row at the carried x;
        // caretRangeFromPoint clamps horizontally, so an x beyond the line's
        // end lands at its end. Fall back to the line edge if the hit lands
        // outside the editable (e.g. on a gutter overlay).
        const range = document.createRange()
        range.selectNodeContents(leaf)
        const rects = range.getClientRects()
        const row = direction === 'up' ? rects[rects.length - 1] : rects[0]
        const hit = row ? document.caretRangeFromPoint(detail.x, row.top + row.height / 2) : null
        if (hit && editable.contains(hit.startContainer)) {
          let node: Node = hit.startContainer
          let offset = hit.startOffset
          if (!(node instanceof Text)) {
            // The point missed the text itself (e.g. a tag directive's border
            // or padding) — an element offset can sit *after* the block, so
            // clamp to the leaf's start or end by which edge is closer.
            node = leaf
            offset = detail.x - row.left < row.right - detail.x ? 0 : (leaf.textContent?.length ?? 0)
          }
          window.getSelection()?.setBaseAndExtent(node, offset, node, offset)
          return
        }
      }
      const offset = direction === 'up' ? (leaf.textContent?.length ?? 0) : 0
      window.getSelection()?.setBaseAndExtent(leaf, offset, leaf, offset)
    }

    const runCommand = (event: KeyboardEvent): boolean => {
      const mod = event.metaKey || event.ctrlKey

      // Undo a source-space commit (mute, tag wrap, line move) when it was the
      // most recent change — Lexical's own history can't see these edits.
      if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z' && lastOpRef.current === 'commit') {
        const entry = undoStackRef.current.pop()
        if (!entry) return false
        const { prevOp, range } = entry
        lastOpRef.current = prevOp as typeof lastOpRef.current
        valueRef.current = entry.source
        editorRef.current?.setMarkdown(markdownForEditor(entry.source).markdown)
        onChangeRef.current(entry.source)
        if (range) {
          const map = buildDocumentMap(entry.source)
          reapplyUntilSettled(() => placeCaretAtCanonicalLine(host, map, range.startLine, range.caretOffset))
        }
        refreshDecorationsRef.current()
        return true
      }

      // Plain arrows only — never Cmd/Alt/Shift-modified arrows.
      if (!mod && !event.altKey && !event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        const direction = event.key === 'ArrowUp' ? 'up' : 'down'
        if (caretAtEditorEdge(host, direction)) {
          if (direction === 'up' && firstBlockIsTag()) focusBeforeTag()
          else focusAdjacentEditor(host, direction)
          return true
        }
        return false
      }

      if (event.altKey && !mod && !event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        const map = buildDocumentMap(valueRef.current)
        const range = selectionLineRange(host, map)
        if (!range) return false
        const moved = moveLinesDetailed(valueRef.current, range.startLine, range.endLine, event.key === 'ArrowUp' ? 'up' : 'down')
        if (!moved) return true
        commit(moved.source, range.collapsed
          ? { type: 'caret', line: moved.startLine, offset: range.caretOffset }
          : { type: 'range', startLine: moved.startLine, endLine: moved.endLine })
        return true
      }

      if (!mod) return false

      if (!event.shiftKey && event.key === '/') return muteSelection()

      // Cmd+Shift+Enter drops the checkbox marker while keeping the list item —
      // inside a 'check' list Lexical normalizes undefined `checked` back to a
      // checkbox, so this has to happen in Markdown space.
      if (event.shiftKey && event.key === 'Enter') {
        const map = buildDocumentMap(valueRef.current)
        const range = selectionLineRange(host, map)
        if (!range) return false
        const next = removeChecklist(valueRef.current, range.startLine)
        if (next === valueRef.current) return false
        commit(next, { type: 'caret', line: range.startLine, offset: range.caretOffset })
        return true
      }

      // Lexical node commands only make sense in the outer editor — selections
      // inside nested directive editors are not visible to it.
      if (caretInNestedEditor()) return false

      if (event.key === 'Enter') {
        toggleChecklistItem()
        return true
      }

      if (event.shiftKey && event.key.toLowerCase() === 'c') {
        const map = buildDocumentMap(valueRef.current)
        const range = selectionLineRange(host, map)
        if (!range) return false
        const next = checklistToPlainText(valueRef.current, range.startLine)
        if (next === valueRef.current) return false
        commit(next, { type: 'caret', line: range.startLine, offset: range.caretOffset })
        return true
      }

      return false
    }

    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (!target || target.closest('input, textarea, select')) return
      if (!target.closest('.mdxeditor-root-contenteditable')) return
      if (runCommand(event)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    // Plain-text paste is canonical markdown — parse it through the editor's
    // own import pipeline instead of inserting it as literal text. Rich HTML
    // paste stays with Lexical.
    const handlePaste = (event: ClipboardEvent) => {
      if (event.clipboardData?.getData('text/html')) return
      const text = event.clipboardData?.getData('text/plain')
      if (!text) return
      event.preventDefault()
      editorRef.current?.insertMarkdown(text)
    }
    host.addEventListener('keydown', handler, true)
    host.addEventListener('paste', handlePaste, true)
    host.addEventListener('notes-mute-toggle', muteSelection)
    host.addEventListener('notes-focus-edge', handleFocusEdge)
    document.addEventListener('selectionchange', updateSelection)
    return () => {
      host.removeEventListener('keydown', handler, true)
      host.removeEventListener('paste', handlePaste, true)
      host.removeEventListener('notes-mute-toggle', muteSelection)
      host.removeEventListener('notes-focus-edge', handleFocusEdge)
      document.removeEventListener('selectionchange', updateSelection)
    }
  }, [lexicalEditorRef])

  function focusEditor(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement
    if (target.closest('.mdxeditor-toolbar, [contenteditable]:not([contenteditable="false"])')) return
    editorRef.current?.focus()
  }

  const plugins = useMemo(() => mdxEditorPlugins(lexicalEditorRef), [lexicalEditorRef])

  const actions = useMemo<EditorActions>(() => ({
    activeTags,
    recentTags,
    addTag: (tagValue) => {
      const host = hostRef.current
      const tag = tagValue.trim()
      if (!host || !tag) return
      const map = buildDocumentMap(valueRef.current)
      const range = selectionLineRange(host, map) ?? lastRangeRef.current
      if (!range) return
      const result = addTagDirectiveToRange(valueRef.current, range.startLine, range.endLine, tag)
      if (result.error || result.source === valueRef.current) return
      commitRef.current?.(result.source, range.collapsed
        ? { type: 'caret', line: range.startLine + 1, offset: range.caretOffset }
        : { type: 'range', startLine: range.startLine + 1, endLine: range.endLine + 1 })
      const nextRecentTags = [tag, ...recentTags.filter((recent) => recent !== tag)].slice(0, 12)
      setRecentTags(nextRecentTags)
      localStorage.setItem(RECENT_TAGS_KEY, JSON.stringify(nextRecentTags))
    },
    removeTag: (tag) => {
      const range = lastRangeRef.current
      if (!range) return
      const result = removeTagAtPosition(valueRef.current, range.startLine, tag)
      if (result.error) return
      commitRef.current?.(result.source, { type: 'caret', line: Math.max(0, range.startLine - 1), offset: range.caretOffset })
    },
  }), [activeTags, recentTags])

  return <div className="notes-mdx-editor" ref={hostRef} onClick={focusEditor}>
    <EditorActionsProvider value={actions}>
    <MDXEditor
      ref={editorRef}
      markdown={markdownForEditor(value).markdown}
      autoFocus={autoFocus}
      toMarkdownOptions={{ bullet: '-' }}
      onChange={(markdown) => {
        if (!userInteractedRef.current) return
        const tight = restoreMarkdownSpacing(valueRef.current, markdown)
        const restored = preserveMutedLines(valueRef.current, tight)
        if (restored === valueRef.current) return
        lastOpRef.current = 'lexical'
        valueRef.current = restored
        onChangeRef.current(restored)
        refreshDecorationsRef.current()
      }}
      plugins={plugins}
    />
    </EditorActionsProvider>
  </div>
}
