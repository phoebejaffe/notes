import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { MDXEditor, type MDXEditorMethods } from '@mdxeditor/editor'
import { $createParagraphNode, $createRangeSelection, $getNearestNodeFromDOMNode, $getNodeByKey, $getRoot, $isTextNode, $setSelection, stopLexicalPropagation, type LexicalEditor } from 'lexical'
import { $getNearestNodeOfType } from '@lexical/utils'
import { TOGGLE_LINK_COMMAND } from '@lexical/link'
import { $createListNode, $isListItemNode, $isListNode, INSERT_CHECK_LIST_COMMAND, ListItemNode } from '@lexical/list'
import { mdxEditorPlugins } from './mdxEditorPlugins'
import { markdownForEditor, restoreMarkdownSpacing } from './markdownSpacing'
import { buildDocumentMap, canonicalLineAtPoint, contentEditable, placeCaretAtCanonicalLine, reapplyUntilSettled, restoreCanonicalSelection, selectCanonicalLines, selectionLineRange, type SelectionLineRange } from './sourceMapping'
import { clearMutedDecorations, nearestVisibleLine, refreshMutedDecorations } from './mutedDecorations'
import { ensureCaretVisible, scrollableAncestors } from './caretVisibility'
import { addTagDirectiveToRange, checklistToPlainText, indentLines, moveLinesDetailed, parseMarkdown, preserveMutedLines, removeChecklist, removeTagAtPosition, toggleMutedLines, toggleTagCollapsed } from '../markerEngine'

import { $isTagBlockNode } from './TagBlockNode'
import { AudioPlayerPopover } from './AudioPlayerPopover'
import { preloadRecordingAudio } from './recordingAudio'
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

// A linked `__` marks a line written by the ring transcription workflow;
// clicking one opens the recording popover rather than navigating.
function isAudioLink(anchor: HTMLAnchorElement) {
  return /^_+$/u.test(anchor.textContent ?? '')
}

// A pasted bare http(s) URL — the explicit scheme requirement keeps ordinary
// words from triggering the selection-to-link conversion on paste.
function pastedLinkUrl(text: string) {
  const trimmed = text.trim()
  return /^https?:\/\/\S+$/iu.test(trimmed) ? trimmed : null
}

function lexicalPointFor(node: Node, offset: number): [string, number, 'text' | 'element'] | null {
  const lexicalNode = $getNearestNodeFromDOMNode(node)
  if (!lexicalNode) return null
  return [lexicalNode.getKey(), offset, node.nodeType === Node.TEXT_NODE ? 'text' : 'element']
}

// The Lexical selection can lag the DOM selection after a commit — rebuild it
// from DOM points before running node commands like TOGGLE_LINK_COMMAND.
function selectDomPoints(editor: LexicalEditor, anchorNode: Node, anchorOffset: number, focusNode: Node, focusOffset: number) {
  editor.update(() => {
    const anchor = lexicalPointFor(anchorNode, anchorOffset)
    const focus = lexicalPointFor(focusNode, focusOffset)
    if (anchor && focus) {
      const selection = $createRangeSelection()
      selection.anchor.set(...anchor)
      selection.focus.set(...focus)
      $setSelection(selection)
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

// The first rendered line box in the editable. A leading empty block or hard
// break renders a line with no text — its <br> is the leaf — so a text-only
// search misses it and ArrowUp into that line gets swallowed.
function firstRenderedLineRect(container: HTMLElement): DOMRect | undefined {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node instanceof Element ? node : node.parentElement
    if (element?.closest('[data-lexical-cursor]')) continue
    if (node.nodeName !== 'BR' && (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim())) continue
    const range = document.createRange()
    if (node.nodeType === Node.TEXT_NODE) range.selectNodeContents(node)
    else range.selectNode(node)
    const rect = range.getClientRects()[0]
    if (rect) return rect
  }
  return undefined
}

// The caret is at the editor's visual top/bottom edge when its rect sits on
// the same rendered line as the first/last rendered line in the whole editor —
// including lines inside nested directive editors. The top edge counts empty
// lines (a leading <p><br></p> has a line box but no text); the bottom edge
// stays text-only so all-empty trailing blocks — like the <p> Lexical appends
// after a trailing tag — still count as the edge.
function caretAtEditorEdge(host: HTMLElement, direction: 'up' | 'down'): boolean {
  const selection = window.getSelection()
  if (!selection?.isCollapsed || !selection.anchorNode || !selection.rangeCount) return false
  const outer = contentEditable(host)
  if (!outer?.contains(selection.anchorNode)) return false
  let edgeRect: DOMRect | undefined
  if (direction === 'up') {
    edgeRect = firstRenderedLineRect(outer)
  } else {
    const leaves = renderedTextLeaves(outer)
    const leaf = leaves[leaves.length - 1]
    if (leaf) {
      const range = document.createRange()
      range.selectNodeContents(leaf)
      const rects = range.getClientRects()
      edgeRect = rects[rects.length - 1]
    }
  }
  // No rendered text (empty editor or every line muted-and-hidden): the caret
  // counts as sitting at both edges, so either arrow crosses out.
  if (!edgeRect) return true
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

function focusAdjacentEditor(host: HTMLElement, direction: 'up' | 'down', landing: 'edge' | 'start' = 'edge') {
  const card = host.closest<HTMLElement>('.day-card, .note-card')
  const cards = [...(card?.parentElement?.querySelectorAll<HTMLElement>('.day-card, .note-card') ?? [])]
  const index = card ? cards.indexOf(card) : -1
  const targetEditor = (direction === 'up' ? cards[index - 1] : cards[index + 1])?.querySelector<HTMLElement>('.notes-mdx-editor')
  // Carry the caret's x across so the destination can land on the same
  // horizontal position, like vertical movement within a paragraph. A caret
  // in an empty block reports a zero rect — use the anchor element's box.
  const selection = window.getSelection()
  let x: number | undefined
  if (landing === 'edge' && selection?.rangeCount) {
    const rect = selection.getRangeAt(0).getBoundingClientRect()
    const anchorElement = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement
    x = rect.width || rect.height ? rect.left : anchorElement?.getBoundingClientRect().left
  }
  const detail = landing === 'start' ? { edge: 'start' } : { direction, x }
  targetEditor?.dispatchEvent(new CustomEvent('notes-focus-edge', { detail, bubbles: false }))
}

// Moves a bullet/number list item into its own single-item check list. Lexical
// clears `checked` on items whose parent list isn't 'check', so turning a plain
// list item into a task means splitting it out — converting the whole list
// would checkbox every sibling. An item's nested list lives in a dedicated
// sibling ListItemNode directly after it (first child is a ListNode) — it
// belongs to the item, so it moves into the check list too.
function moveItemToOwnCheckList(item: ListItemNode) {
  const list = item.getParent()
  if (!$isListNode(list) || list.getListType() === 'check') return
  const checkList = $createListNode('check')
  list.insertAfter(checkList)
  const nested: ListItemNode[] = []
  let next = item.getNextSibling()
  while ($isListItemNode(next) && $isListNode(next.getFirstChild())) {
    nested.push(next)
    next = next.getNextSibling()
  }
  if (next) {
    const rest = $createListNode(list.getListType() as 'bullet' | 'number')
    checkList.insertAfter(rest)
    if (list.getListType() === 'number') rest.setStart(item.getValue() + 1)
    while (next) {
      const sibling = next
      next = next.getNextSibling()
      rest.append(sibling)
    }
  }
  checkList.append(item, ...nested)
  if (list.getChildrenSize() === 0) list.remove()
}

export function MdxNotesEditor({ value, onChange, autoFocus = false, hideMutedLines = false, tagColors = {}, findActive = false }: MdxNotesEditorProps) {
  const editorRef = useRef<MDXEditorMethods>(null)
  const lexicalEditorRef = useMemo(() => ({ current: null as LexicalEditor | null }), [])
  const activeEditorRef = useMemo(() => ({ current: null as LexicalEditor | null }), [])
  const hostRef = useRef<HTMLDivElement>(null)
  const valueRef = useRef(value)
  const onChangeRef = useRef(onChange)
  const hideMutedLinesRef = useRef(hideMutedLines)
  const tagColorsRef = useRef(tagColors)
  const userInteractedRef = useRef(false)
  const lastRangeRef = useRef<SelectionLineRange | null>(null)
  const pendingMoveCaretLineRef = useRef<number | null>(null)
  const boundaryParagraphRef = useRef<{ key: string; armed: boolean } | null>(null)
  const commitRef = useRef<((markdown: string, restore?: Restore) => void) | null>(null)
  // Lexical's history can't see source-space commits (e.g. muting strips `%%`
  // before the editor sees it, leaving an identical Lexical state), so commits
  // keep their own undo stack. Meta/Ctrl+Z pops it only when the most recent
  // change was a commit; typing undos stay with Lexical.
  const undoStackRef = useRef<Array<{ source: string; range: SelectionLineRange | null; prevOp: string }>>([])
  const lastOpRef = useRef<'commit' | 'lexical' | 'external'>('lexical')
  const visibilityRafRef = useRef(0)
  const [activeTags, setActiveTags] = useState<string[]>([])
  const [activeLink, setActiveLink] = useState<string | null>(null)
  const [recentTags, setRecentTags] = useState<string[]>(loadRecentTags)
  const [audioPopover, setAudioPopover] = useState<{ url: string; rect: DOMRect } | null>(null)

  // A programmatic setMarkdown re-import makes Lexical reconcile the stale
  // selection and scroll it into view — jumpy, since the real caret lands a
  // frame later. Blur first so its scroll guard (rootElement ===
  // document.activeElement) fails, restore scroll positions as extra cover,
  // and refocus without scrolling so the caret restore owns the outcome.
  const setEditorMarkdown = (markdown: string) => {
    const host = hostRef.current
    const editable = host ? contentEditable(host) : null
    const wasActive = !!editable && document.activeElement === editable
    if (wasActive) editable.blur()
    const scrollers = host ? scrollableAncestors(host) : []
    const positions = scrollers.map((scroller) => scroller.scrollTop)
    editorRef.current?.setMarkdown(markdownForEditor(markdown).markdown)
    scrollers.forEach((scroller, index) => { scroller.scrollTop = positions[index] })
    if (wasActive) editable.focus({ preventScroll: true })
  }

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
    // Warm the audio element on hover/press so the popover plays instantly.
    const preloadAudioLink = (event: Event) => {
      const link = (event.target as HTMLElement | null)?.closest?.('a[href]')
      if (link instanceof HTMLAnchorElement && isAudioLink(link) && host.contains(link)) {
        preloadRecordingAudio(link.href)
      }
    }
    host.addEventListener('beforeinput', markInteraction)
    host.addEventListener('keydown', markInteraction)
    host.addEventListener('paste', markInteraction)
    host.addEventListener('pointerdown', markInteraction, true)
    host.addEventListener('pointerdown', preloadAudioLink, true)
    host.addEventListener('pointerover', preloadAudioLink)
    host.addEventListener('click', markInteraction)
    return () => {
      host.removeEventListener('beforeinput', markInteraction)
      host.removeEventListener('keydown', markInteraction)
      host.removeEventListener('paste', markInteraction)
      host.removeEventListener('pointerdown', markInteraction, true)
      host.removeEventListener('pointerdown', preloadAudioLink, true)
      host.removeEventListener('pointerover', preloadAudioLink)
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

  // Find keeps collapsed tags expanded via CSS only ([data-find-active]); when
  // it closes they fold again, so a caret that ended inside one is re-placed
  // on the nearest visible line (placeCaretAtCanonicalLine redirects).
  useEffect(() => {
    if (findActive) return
    const host = hostRef.current
    const selection = window.getSelection()
    const anchor = selection?.anchorNode
    const element = anchor instanceof Element ? anchor : anchor?.parentElement
    const collapsedTag = element?.closest('[data-tag-collapsed]')
    if (!host || !selection || !collapsedTag || !host.contains(collapsedTag)) return
    const map = buildDocumentMap(valueRef.current)
    const line = canonicalLineAtPoint(host, map, anchor!, selection.anchorOffset)
    if (line === null) return
    reapplyUntilSettled(() => placeCaretAtCanonicalLine(host, map, line, 0))
  }, [findActive])

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
    const moveCaretLine = pendingMoveCaretLineRef.current
    pendingMoveCaretLineRef.current = null
    // External update (sync/merge): capture the caret's canonical line in the
    // outgoing source so the re-import doesn't yank it mid-typing.
    const range = host && contentEditable(host)?.contains(window.getSelection()?.anchorNode ?? null)
      ? selectionLineRange(host, buildDocumentMap(valueRef.current))
      : null
    valueRef.current = value
    setEditorMarkdown(value)
    lastOpRef.current = 'external'
    refreshDecorationsRef.current()
    if (moveCaretLine !== null && host) {
      const map = buildDocumentMap(value)
      reapplyUntilSettled(() => {
        const editable = contentEditable(host)
        editable?.focus({ preventScroll: true })
        return placeCaretAtCanonicalLine(host, map, moveCaretLine, 0)
      })
      return
    }
    if (range && host) {
      const map = buildDocumentMap(value)
      reapplyUntilSettled(() => placeCaretAtCanonicalLine(host, map, range.startLine, range.caretOffset))
    }
  }, [value])

  // Whichever of this host's editors owns both DOM points — the outer editor,
  // or a nested directive editor when the caret is inside one.
  const editorContaining = useCallback((first: Node | null, second: Node | null) =>
    [activeEditorRef.current, lexicalEditorRef.current].find((candidate) => {
      const root = candidate?.getRootElement()
      return !!root && root.contains(first) && root.contains(second)
    }) ?? null, [activeEditorRef, lexicalEditorRef])

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
      setEditorMarkdown(markdown)
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
      // The href of the first link the selection touches — covers selections
      // anchored on a boundary outside the link and ranges spanning one.
      let linkHref: string | null = null
      const selection = window.getSelection()
      if (selection?.rangeCount) {
        const domRange = selection.getRangeAt(0)
        for (const link of content.querySelectorAll<HTMLAnchorElement>('a[href]')) {
          if (domRange.intersectsNode(link)) {
            linkHref = link.getAttribute('href')
            break
          }
        }
      }
      setActiveLink((current) => (current === linkHref ? current : linkHref))
      const map = buildDocumentMap(valueRef.current)
      const range = selectionLineRange(host, map)
      // Keep the last *mappable* range — an anchor inside the editor can still
      // map to null (e.g. directive chrome), and the tag input relies on this
      // snapshot after focus leaves the editable.
      if (range) {
        lastRangeRef.current = range
        host.dispatchEvent(new CustomEvent('notes-editor-selection', { detail: range, bubbles: true }))
      }
      const tags = range
        ? [...new Set(parseMarkdown(valueRef.current).ranges
            .filter((tagRange) => tagRange.startLine <= range.endLine && tagRange.endLine >= range.startLine)
            .map((tagRange) => tagRange.tag))]
        : []
      setActiveTags((current) => current.length === tags.length && current.every((tag, index) => tag === tags[index]) ? current : tags)
      // Keep the caret inside the visible band — typing and native navigation
      // already scroll to the nearest edge, but fixed overlay bars (and any
      // programmatic caret move, which browsers never scroll for) can leave
      // the caret hidden. Deferred a frame so we measure post-browser-scroll.
      cancelAnimationFrame(visibilityRafRef.current)
      visibilityRafRef.current = requestAnimationFrame(() => {
        const active = document.activeElement
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return
        ensureCaretVisible()
      })
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

    // Alt/Option+Arrow and the mobile gesture button share this path.
    const moveSelectedLines = (direction: 'up' | 'down') => {
      const map = buildDocumentMap(valueRef.current)
      const range = selectionLineRange(host, map)
      if (!range) return false
      const moved = moveLinesDetailed(valueRef.current, range.startLine, range.endLine, direction)
      if (!moved) return true
      commit(moved.source, range.collapsed
        ? { type: 'caret', line: moved.startLine, offset: range.caretOffset }
        : { type: 'range', startLine: moved.startLine, endLine: moved.endLine })
      return true
    }

    // Gesture-button indent/outdent — source-space whitespace on list items.
    const indentSelection = (direction: 'indent' | 'outdent') => {
      const map = buildDocumentMap(valueRef.current)
      const range = selectionLineRange(host, map)
      if (!range) return
      const next = indentLines(valueRef.current, range.startLine, range.endLine, direction)
      if (!next) return
      commit(next.source, range.collapsed
        ? { type: 'caret', line: range.startLine, offset: Math.max(0, range.caretOffset + next.caretDelta) }
        : { type: 'range', startLine: range.startLine, endLine: range.endLine })
    }

    // Drag gestures on the mobile toolbar button: up/down move lines,
    // left/right indent and outdent.
    const handleLineGesture = (event: Event) => {
      const direction = ((event as CustomEvent).detail as { direction?: string } | undefined)?.direction
      if (direction === 'up' || direction === 'down') moveSelectedLines(direction)
      else if (direction === 'indent' || direction === 'outdent') indentSelection(direction)
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
          // Read `checked` before the move: once the item sits in a check list
          // getChecked() returns a boolean even when it was never a task, which
          // would flip a fresh bullet straight to checked.
          const checked = item.getChecked()
          moveItemToOwnCheckList(item)
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

    // "- [ ] " typed in a bullet: Lexical's element transformers only run on
    // root-level blocks, so the `[ ] ` typed inside a list item would land as
    // literal text. When space is pressed right after a leading `[ ]`/`[x]`,
    // strip the marker and make the item a task — splitting it into its own
    // check list, since Lexical clears `checked` on non-check lists and a
    // whole-list conversion would check the neighbors too.
    const convertTypedCheckMarker = () => {
      const selection = window.getSelection()
      const anchor = selection?.anchorNode
      if (!(anchor instanceof Text)) return false
      // The caret may sit in a nested directive editor, which is a separate
      // LexicalEditor — pick whichever editor actually owns the anchor.
      const editor = [activeEditorRef.current, lexicalEditorRef.current]
        .find((candidate) => candidate?.getRootElement()?.contains(anchor))
      if (!editor) return false
      const match = anchor.textContent?.match(/^\[([ xX])\]/u)
      if (!match || selection?.anchorOffset !== match[0].length) return false
      let converted = false
      editor.update(() => {
        const node = $getNearestNodeFromDOMNode(anchor)
        const item = node ? $getNearestNodeOfType(node, ListItemNode) : null
        if (!item || !$isTextNode(node) || item.getFirstChild() !== node) return
        if (!$isListNode(item.getParent())) return
        node.spliceText(0, match[0].length, '')
        moveItemToOwnCheckList(item)
        item.setChecked(match[1].toLowerCase() === 'x')
        item.selectStart()
        converted = true
      })
      return converted
    }

    const caretInNestedEditor = () => {
      const editable = contentEditable(host)
      const anchor = window.getSelection()?.anchorNode
      const editableAtCaret = anchor ? (anchor instanceof Element ? anchor : anchor.parentElement)?.closest('[contenteditable="true"]') : null
      return !!editable && !!editableAtCaret && editableAtCaret !== editable
    }

    // Place the caret on the editor's first ('start') or last ('end') rendered
    // line — at the given x position when provided, otherwise at the line's
    // start or end — even when that line lives inside a nested directive
    // editor. Used both for sibling-editor focus requests and Cmd-Up/Down.
    const focusEdge = (edge: 'start' | 'end', x?: number) => {
      const outer = contentEditable(host)
      if (!outer) return
      const leaves = renderedTextLeaves(outer)
      const leaf = edge === 'end' ? leaves[leaves.length - 1] : leaves[0]
      if (!leaf) {
        // Empty editor — no text leaf to land on, so place the caret directly
        // at the start (or end) of the editable.
        outer.focus()
        const position = edge === 'end' ? outer.childNodes.length : 0
        window.getSelection()?.setBaseAndExtent(outer, position, outer, position)
        return
      }
      const editable = leaf.parentElement?.closest<HTMLElement>('[contenteditable="true"]') ?? outer
      editable.focus()
      if (typeof x === 'number') {
        // Hit-test the edge line's first/last visual row at the carried x;
        // caretRangeFromPoint clamps horizontally, so an x beyond the line's
        // end lands at its end. Fall back to the line edge if the hit lands
        // outside the editable (e.g. on a gutter overlay).
        const range = document.createRange()
        range.selectNodeContents(leaf)
        const rects = range.getClientRects()
        const row = edge === 'end' ? rects[rects.length - 1] : rects[0]
        const hit = row ? document.caretRangeFromPoint(x, row.top + row.height / 2) : null
        if (hit && editable.contains(hit.startContainer)) {
          let node: Node = hit.startContainer
          let offset = hit.startOffset
          if (!(node instanceof Text)) {
            // The point missed the text itself (e.g. a tag directive's border
            // or padding) — an element offset can sit *after* the block, so
            // clamp to the leaf's start or end by which edge is closer.
            node = leaf
            offset = x - row.left < row.right - x ? 0 : (leaf.textContent?.length ?? 0)
          }
          window.getSelection()?.setBaseAndExtent(node, offset, node, offset)
          return
        }
      }
      const offset = edge === 'end' ? (leaf.textContent?.length ?? 0) : 0
      window.getSelection()?.setBaseAndExtent(leaf, offset, leaf, offset)
    }

    // A sibling editor asks us to take focus at an edge.
    const handleFocusEdge = (event: Event) => {
      const detail = (event as CustomEvent).detail as { direction?: 'up' | 'down'; edge?: 'start' | 'end'; x?: number } | undefined
      userInteractedRef.current = true
      // direction is travel direction: 'up' arrives from below → last line.
      const edge = detail?.edge ?? (detail?.direction === 'up' ? 'end' : 'start')
      focusEdge(edge, detail?.x)
    }

    // Hiding/showing the capture window can drop the DOM selection, so the
    // app asks whichever editor last held the caret to re-place it at its
    // remembered canonical line and bring it back into view.
    const handleRestoreCaret = () => {
      userInteractedRef.current = true
      const content = contentEditable(host)
      const range = lastRangeRef.current
      const map = buildDocumentMap(valueRef.current)
      const placed = range ? restoreCanonicalSelection(host, map, range) : null
      if (!placed) {
        focusEdge('start')
        return
      }
      const anchorElement = placed instanceof Element ? placed : placed.parentElement
      const editable = anchorElement?.closest<HTMLElement>('[contenteditable="true"]') ?? content
      editable?.focus()
      // Deferred a frame so WKWebView finishes any focus-driven scroll first.
      window.requestAnimationFrame(() => ensureCaretVisible({ preferTop: true }))
    }

    const handleRestoreSelection = (event: Event) => {
      const saved = (event as CustomEvent<SelectionLineRange>).detail
      if (!saved) return
      userInteractedRef.current = true
      const map = buildDocumentMap(valueRef.current)
      reapplyUntilSettled(() => {
        contentEditable(host)?.focus({ preventScroll: true })
        return restoreCanonicalSelection(host, map, saved)
      })
    }

    const handleMoveCaretRestore = (event: Event) => {
      const line = (event as CustomEvent<{ line?: number }>).detail?.line
      if (typeof line === 'number' && Number.isInteger(line) && line >= 0) pendingMoveCaretLineRef.current = line
    }

    // Clicking a tag chip folds the section. The chip is a CSS ::before, so
    // the event target is the directive div itself whenever the click lands on
    // the chip or its padding band; clicks on children target the children.
    // Toggling rewrites the fence's `collapsed` attribute as a source commit,
    // so it persists, syncs, and joins the commit undo stack.
    const toggleTagChip = (event: globalThis.MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      const tagDiv = event.target as HTMLElement | null
      if (!tagDiv?.classList?.contains('notes-tag-directive')) return
      // Hit-test against the chip's painted bounds: ::before starts at
      // left:-3px/top:12px, and its computed size is content-box, so padding
      // (8px×2 + 2px×2) and border (1px) widen it. Clicks further right or
      // lower are ordinary caret placement, not chip clicks.
      const chip = getComputedStyle(tagDiv, '::before')
      const chipWidth = parseFloat(chip.width)
      const chipHeight = parseFloat(chip.height)
      const chipRight = -3 + (Number.isFinite(chipWidth) ? chipWidth : 40) + 17
      const chipBottom = 12 + (Number.isFinite(chipHeight) ? chipHeight : 15) + 6
      if (event.offsetY > chipBottom || event.offsetX > chipRight) return
      const editable = contentEditable(host)
      if (!editable?.contains(tagDiv)) return
      // DOM preorder order == source open-fence order, including tags nested
      // in directives or rendered by nested directive editors.
      const ordinal = [...editable.querySelectorAll('.notes-tag-directive')].indexOf(tagDiv)
      const parsed = parseMarkdown(valueRef.current)
      const range = [...parsed.ranges].sort((a, b) => a.startLine - b.startLine)[ordinal]
      if (!range) return
      const result = toggleTagCollapsed(valueRef.current, range.startLine)
      if (result.error || result.source === valueRef.current) return
      event.preventDefault()
      userInteractedRef.current = true
      // Preserve the caret where it was — a caret inside the now-collapsed
      // section is redirected to the nearest visible line by the restore path.
      const map = buildDocumentMap(valueRef.current)
      const selection = selectionLineRange(host, map)
      commit(result.source, !selection
        ? undefined
        : selection.collapsed
          ? { type: 'caret', line: selection.startLine, offset: selection.caretOffset }
          : { type: 'range', startLine: selection.startLine, endLine: selection.endLine })
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
        setEditorMarkdown(entry.source)
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
        moveSelectedLines(event.key === 'ArrowUp' ? 'up' : 'down')
        return true
      }

      // Cmd-Opt-Arrow jumps straight to the adjacent editor's top; Cmd-Arrow
      // goes to this editor's top or bottom edge. Cmd-Shift+Arrow stays
      // native (it extends the selection).
      if (mod && !event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        const direction = event.key === 'ArrowUp' ? 'up' : 'down'
        if (event.altKey) focusAdjacentEditor(host, direction, 'start')
        else focusEdge(direction === 'up' ? 'start' : 'end')
        return true
      }

      if (!mod) return false

      // Cmd/Ctrl-M asks the app to move the selected canonical lines into a
      // different editor. The host bubbles the request up; whichever surface
      // owns the document collection resolves the source card and moves them.
      if (!event.shiftKey && !event.altKey && event.key.toLowerCase() === 'm') {
        const map = buildDocumentMap(valueRef.current)
        const range = selectionLineRange(host, map) ?? lastRangeRef.current
        if (!range) return false
        host.dispatchEvent(new CustomEvent('notes-move-lines', { detail: { startLine: range.startLine, endLine: range.endLine }, bubbles: true }))
        return true
      }

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
      if (event.key === ' ' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && convertTypedCheckMarker()) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (runCommand(event)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    // Plain-text paste is canonical markdown — parse it through the editor's
    // own import pipeline instead of inserting it as literal text. Rich HTML
    // paste stays with Lexical.
    const handlePaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select')) return
      const text = event.clipboardData?.getData('text/plain')
      const domSelection = window.getSelection()
      // A bare URL pasted over a non-collapsed selection wraps the selected
      // text in a link rather than replacing it.
      const url = text ? pastedLinkUrl(text) : null
      if (url && domSelection && !domSelection.isCollapsed) {
        const editor = editorContaining(domSelection.anchorNode, domSelection.focusNode)
        if (editor) {
          event.preventDefault()
          // Handled in Lexical space — mark the event so Lexical's own paste
          // listener doesn't also insert the raw URL text.
          stopLexicalPropagation(event)
          selectDomPoints(editor, domSelection.anchorNode!, domSelection.anchorOffset, domSelection.focusNode!, domSelection.focusOffset)
          editor.dispatchCommand(TOGGLE_LINK_COMMAND, url)
          return
        }
      }
      if (event.clipboardData?.getData('text/html')) return
      if (!text) return
      event.preventDefault()
      // Same interception as above — without it Lexical's rich-text paste
      // inserts the raw text a second time alongside the markdown import.
      stopLexicalPropagation(event)
      editorRef.current?.insertMarkdown(text)
    }
    host.addEventListener('keydown', handler, true)
    host.addEventListener('paste', handlePaste, true)
    host.addEventListener('mousedown', toggleTagChip, true)
    host.addEventListener('notes-mute-toggle', muteSelection)
    host.addEventListener('notes-line-gesture', handleLineGesture)
    host.addEventListener('notes-focus-edge', handleFocusEdge)
    host.addEventListener('notes-restore-caret', handleRestoreCaret)
    host.addEventListener('notes-restore-selection', handleRestoreSelection)
    host.addEventListener('notes-move-caret-restore', handleMoveCaretRestore)
    document.addEventListener('selectionchange', updateSelection)
    return () => {
      host.removeEventListener('keydown', handler, true)
      host.removeEventListener('paste', handlePaste, true)
      host.removeEventListener('mousedown', toggleTagChip, true)
      host.removeEventListener('notes-mute-toggle', muteSelection)
      host.removeEventListener('notes-line-gesture', handleLineGesture)
      host.removeEventListener('notes-focus-edge', handleFocusEdge)
      host.removeEventListener('notes-restore-caret', handleRestoreCaret)
      host.removeEventListener('notes-restore-selection', handleRestoreSelection)
      host.removeEventListener('notes-move-caret-restore', handleMoveCaretRestore)
      document.removeEventListener('selectionchange', updateSelection)
      cancelAnimationFrame(visibilityRafRef.current)
    }
  }, [lexicalEditorRef, activeEditorRef, editorContaining])

  function openExternalLink(href: string) {
    if ('__TAURI_INTERNALS__' in window) {
      void import('@tauri-apps/plugin-shell').then(({ open }) => open(href))
    } else {
      window.open(href, '_blank', 'noopener,noreferrer')
    }
  }

  function focusEditor(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement
    const link = target.closest<HTMLAnchorElement>('a[href]')
    if (link && hostRef.current?.querySelector('.mdxeditor-root-contenteditable')?.contains(link)) {
      event.preventDefault()
      if (isAudioLink(link)) setAudioPopover({ url: link.href, rect: link.getBoundingClientRect() })
      else openExternalLink(link.href)
      return
    }
    if (target.closest('.mdxeditor-toolbar, .notes-editor-link-popover, [contenteditable]:not([contenteditable="false"])')) return
    editorRef.current?.focus()
  }

  const plugins = useMemo(() => mdxEditorPlugins(lexicalEditorRef, activeEditorRef), [lexicalEditorRef, activeEditorRef])

  const actions = useMemo<EditorActions>(() => ({
    activeTags,
    activeLink,
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
      const mappedStart = result.startLine ?? range.startLine + 1
      const mappedEnd = result.endLine ?? range.endLine + 1
      commitRef.current?.(result.source, range.collapsed
        ? { type: 'caret', line: mappedStart, offset: range.caretOffset }
        : { type: 'range', startLine: mappedStart, endLine: mappedEnd })
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
    applyLink: (url, range) => {
      const live = window.getSelection()
      const domRange = range ?? (live?.rangeCount ? live.getRangeAt(0) : null)
      const editor = domRange && editorContaining(domRange.startContainer, domRange.endContainer)
      if (!domRange || !editor) return
      userInteractedRef.current = true
      selectDomPoints(editor, domRange.startContainer, domRange.startOffset, domRange.endContainer, domRange.endOffset)
      editor.dispatchCommand(TOGGLE_LINK_COMMAND, url)
      editor.getRootElement()?.focus({ preventScroll: true })
    },
  }), [activeTags, activeLink, recentTags, editorContaining])

  return <div className="notes-mdx-editor" ref={hostRef} onClick={focusEditor} data-find-active={findActive || undefined}>
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
    {audioPopover && <AudioPlayerPopover url={audioPopover.url} anchorRect={audioPopover.rect} onClose={() => setAudioPopover(null)} />}
  </div>
}
