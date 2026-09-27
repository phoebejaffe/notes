import { fromMarkdown } from 'mdast-util-from-markdown'
import { directive } from 'micromark-extension-directive'
import { directiveFromMarkdown } from 'mdast-util-directive'
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item'
import { gfmTaskListItemFromMarkdown } from 'mdast-util-gfm-task-list-item'
import { markdownForEditor } from './markdownSpacing'

// Maps DOM selections to canonical Markdown source lines. mdast gives every
// rendered block an exact source position, and rendered top-level blocks align
// with the mdast root's children, so a caret resolves to a line without any
// rendered-text guessing.

export interface MdastNode {
  type: string
  position?: { start: { line: number; column: number }; end: { line: number; column: number } }
  children?: MdastNode[]
}

export interface DocumentMap {
  blocks: MdastNode[]
  editorLineToCanonical: number[]
}

export function buildDocumentMap(canonical: string): DocumentMap {
  const { markdown, editorLineToCanonical } = markdownForEditor(canonical)
  let blocks: MdastNode[] = []
  try {
    blocks = fromMarkdown(markdown, {
      extensions: [directive(), gfmTaskListItem()],
      mdastExtensions: [directiveFromMarkdown(), gfmTaskListItemFromMarkdown()],
    }).children as unknown as MdastNode[]
  } catch {
    blocks = []
  }
  return { blocks, editorLineToCanonical }
}

export function editorLineForCanonical(map: DocumentMap, canonicalLine: number) {
  const index = map.editorLineToCanonical.indexOf(canonicalLine)
  return index < 0 ? Math.min(Math.max(canonicalLine, 0), map.editorLineToCanonical.length - 1) : index
}

// Lexical injects chrome such as <div contenteditable="false"
// data-lexical-cursor> into block containers — only real block elements align
// with mdast child indices, so chrome must be filtered out of child indexing.
export function blockChildren(container: HTMLElement): HTMLElement[] {
  return [...container.children].filter((el): el is HTMLElement => el instanceof HTMLElement && !el.hasAttribute('data-lexical-cursor'))
}

export function contentEditable(host: HTMLElement | null): HTMLElement | null {
  return host?.querySelector<HTMLElement>('.mdxeditor-root-contenteditable [contenteditable="true"], .mdxeditor-root-contenteditable[contenteditable="true"]') ?? null
}

function normalizeAnchor(node: Node, offset: number): { node: Node; offset: number } {
  while (node instanceof Element) {
    const children = node.childNodes
    if (!children.length) return { node, offset: 0 }
    if (offset < children.length) {
      node = children[offset]
      offset = 0
      continue
    }
    node = children[children.length - 1]
    offset = node.nodeType === Node.TEXT_NODE ? (node.textContent?.length ?? 0) : node.childNodes.length
  }
  return { node, offset }
}

function closestElement(node: Node, selector: string): HTMLElement | null {
  const el = node instanceof Element ? node : node.parentElement
  return el?.closest(selector) ?? null
}

function directChildOf(container: HTMLElement, node: Node): HTMLElement | null {
  let el: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement
  if (el === container) return null
  while (el && el.parentElement !== container) el = el.parentElement
  return el
}

function countNewlines(text: string) {
  let count = 0
  for (const ch of text) if (ch === '\n') count += 1
  return count
}

// Rendered line boundaries (text '\n' characters and <br> elements) before the
// given DOM point within `container`.
function lineBreaksBefore(container: HTMLElement, node: Node, offset: number): number {
  let count = 0
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (current === node) {
      if (current.nodeType === Node.TEXT_NODE) count += countNewlines((current.textContent ?? '').slice(0, offset))
      return count
    }
    if (current.nodeName === 'BR') count += 1
    else if (current.nodeType === Node.TEXT_NODE) count += countNewlines(current.textContent ?? '')
  }
  return count
}

// Characters between the start of the rendered line containing the point and
// the point itself.
function renderedOffsetBefore(container: HTMLElement, node: Node, offset: number): number {
  let acc = 0
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (current.nodeName === 'BR') {
      acc = 0
      continue
    }
    if (current.nodeType !== Node.TEXT_NODE) continue
    const text = current.textContent ?? ''
    const limit = current === node ? Math.min(offset, text.length) : text.length
    const upto = text.slice(0, limit)
    const lastBreak = upto.lastIndexOf('\n')
    acc = lastBreak < 0 ? acc + upto.length : upto.length - lastBreak - 1
    if (current === node) return acc
  }
  return acc
}

function flattenListItems(list: MdastNode): MdastNode[] {
  const items: MdastNode[] = []
  for (const item of list.children ?? []) {
    items.push(item)
    for (const child of item.children ?? []) if (child.type === 'list') items.push(...flattenListItems(child))
  }
  return items
}

// Lexical renders each nested list inside a dedicated wrapper <li> that carries
// no content of its own; mdast listItems only correspond to content-bearing
// <li>s, so alignment must skip the wrappers.
function contentLis(blockEl: HTMLElement): HTMLLIElement[] {
  return [...blockEl.querySelectorAll('li')].filter((li) =>
    [...li.childNodes].some(
      (child) =>
        (child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').length > 0) ||
        (child.nodeType === Node.ELEMENT_NODE && child.nodeName !== 'UL' && child.nodeName !== 'OL'),
    ),
  ) as HTMLLIElement[]
}

function lineWithinBlock(blockEl: HTMLElement, mdastNode: MdastNode, node: Node, offset: number): number | null {
  const startLine = (mdastNode.position?.start.line ?? 1) - 1

  if (mdastNode.type === 'list') {
    const li = closestElement(node, 'li')
    if (li && blockEl.contains(li)) {
      const items = flattenListItems(mdastNode)
      const liIndex = contentLis(blockEl).indexOf(li as HTMLLIElement)
      const item = items[Math.min(Math.max(liIndex, 0), items.length - 1)]
      const itemStart = (item?.position?.start.line ?? mdastNode.position?.start.line ?? 1) - 1
      return itemStart + lineBreaksBefore(li, node, offset)
    }
    return startLine
  }

  if (mdastNode.type === 'blockquote' && mdastNode.children?.length) {
    const childEl = directChildOf(blockEl, node)
    if (childEl) {
      const index = blockChildren(blockEl).indexOf(childEl)
      const child = mdastNode.children[Math.min(index, mdastNode.children.length - 1)]
      if (child) return lineWithinBlock(childEl, child, node, offset)
    }
    return startLine
  }

  if (mdastNode.type === 'containerDirective' || mdastNode.type === 'leafDirective') {
    // Tag directives render as a .notes-tag-directive element whose children are
    // ordinary blocks in this same editable; other directive kinds mount a
    // nested editor inside a decorator.
    const tagDiv = blockEl.matches('.notes-tag-directive') ? blockEl : blockEl.querySelector<HTMLElement>(':scope > .notes-tag-directive')
    if (tagDiv) {
      const childEl = directChildOf(tagDiv, node)
      if (!childEl || !mdastNode.children?.length) return startLine
      const index = blockChildren(tagDiv).indexOf(childEl)
      const child = mdastNode.children[Math.min(Math.max(index, 0), mdastNode.children.length - 1)]
      return lineWithinBlock(childEl, child, node, offset)
    }
    const nested = blockEl.querySelector<HTMLElement>('[contenteditable="true"]')
    if (nested && nested.contains(node) && mdastNode.children?.length) {
      return editorLineInChildren(nested, mdastNode.children, node, offset) ?? startLine
    }
    return startLine
  }

  return startLine + lineBreaksBefore(blockEl, node, offset)
}

function editorLineInChildren(container: HTMLElement, nodes: MdastNode[], node: Node, offset: number): number | null {
  const blockEl = directChildOf(container, node)
  if (!blockEl) return null
  const index = blockChildren(container).indexOf(blockEl)
  if (index < 0) return null
  if (index >= nodes.length) {
    // Rendered block with no mdast counterpart (e.g. Lexical's trailing empty paragraph).
    const last = nodes[nodes.length - 1]
    return last?.position ? last.position.end.line - 1 : null
  }
  return lineWithinBlock(blockEl, nodes[index], node, offset)
}

// --- Reading the DOM selection ---

export function canonicalLineAtPoint(host: HTMLElement, map: DocumentMap, node: Node, offset: number): number | null {
  const editable = contentEditable(host)
  if (!editable?.contains(node)) return null
  const point = normalizeAnchor(node, offset)
  const editorLine = editorLineInChildren(editable, map.blocks, point.node, point.offset)
  if (editorLine === null) return null
  return map.editorLineToCanonical[Math.min(editorLine, map.editorLineToCanonical.length - 1)] ?? null
}

export function renderedOffsetAtPoint(host: HTMLElement, node: Node, offset: number): number {
  const editable = contentEditable(host)
  if (!editable?.contains(node)) return 0
  const point = normalizeAnchor(node, offset)
  const blockEl = directChildOf(editable, point.node)
  if (!blockEl) return 0
  const tagDiv = closestElement(point.node, '.notes-tag-directive')
  const container = closestElement(point.node, 'li') ?? (tagDiv ? directChildOf(tagDiv, point.node) : null) ?? blockEl
  return renderedOffsetBefore(container, point.node, point.offset)
}

export interface SelectionLineRange {
  startLine: number
  endLine: number
  collapsed: boolean
  caretOffset: number
}

// Maps the current DOM selection to canonical source line indices.
export function selectionLineRange(host: HTMLElement, map: DocumentMap): SelectionLineRange | null {
  const selection = window.getSelection()
  if (!selection?.anchorNode || !selection.focusNode) return null
  const anchorLine = canonicalLineAtPoint(host, map, selection.anchorNode, selection.anchorOffset)
  const focusLine = canonicalLineAtPoint(host, map, selection.focusNode, selection.focusOffset)
  if (anchorLine === null || focusLine === null) return null
  if (selection.isCollapsed) {
    return { startLine: anchorLine, endLine: focusLine, collapsed: true, caretOffset: renderedOffsetAtPoint(host, selection.anchorNode, selection.anchorOffset) }
  }
  return { startLine: Math.min(anchorLine, focusLine), endLine: Math.max(anchorLine, focusLine), collapsed: false, caretOffset: 0 }
}

// --- Restoring the DOM selection after a commit ---

interface DomPoint { node: Node; offset: number }

function textLeaves(container: HTMLElement): Node[] {
  const leaves: Node[] = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(current) {
      if (current.nodeName === 'UL' || current.nodeName === 'OL') return NodeFilter.FILTER_REJECT
      if (current.nodeName === 'BR' || current.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT
      return NodeFilter.FILTER_SKIP
    },
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) leaves.push(node)
  return leaves
}

// The DOM point `offset` rendered characters into line segment `segment` of
// `container`. Overshooting offsets clamp to the segment end, so
// Number.POSITIVE_INFINITY means end-of-line.
function domInlinePoint(container: HTMLElement, segment: number, offset: number): DomPoint | null {
  let seg = 0
  let remaining = offset
  let lastPoint: DomPoint | null = null
  for (const leaf of textLeaves(container)) {
    if (leaf.nodeName === 'BR') {
      if (seg === segment) {
        if (lastPoint) return lastPoint
        const parent = leaf.parentNode ?? container
        return { node: parent, offset: [...parent.childNodes].indexOf(leaf as ChildNode) }
      }
      seg += 1
      continue
    }
    const text = leaf.textContent ?? ''
    for (let i = 0; i < text.length; i += 1) {
      if (seg < segment) {
        if (text[i] === '\n') seg += 1
        continue
      }
      if (seg > segment) return { node: leaf, offset: i }
      if (remaining <= 0 || text[i] === '\n') return { node: leaf, offset: i }
      remaining -= 1
    }
    if (seg === segment && remaining <= 0) return { node: leaf, offset: text.length }
    lastPoint = { node: leaf, offset: text.length }
  }
  return lastPoint ?? { node: container, offset: 0 }
}

function domPointInBlock(blockEl: HTMLElement, mdastNode: MdastNode, editorLine: number, offset: number): DomPoint | null {
  const startLine = (mdastNode.position?.start.line ?? 1) - 1

  if (mdastNode.type === 'list') {
    const items = flattenListItems(mdastNode)
    const lis = contentLis(blockEl)
    let index = items.findIndex((item) => (item.position?.start.line ?? 0) - 1 === editorLine)
    if (index < 0) index = items.findLastIndex((item) => (item.position?.start.line ?? 0) - 1 <= editorLine)
    if (index < 0) index = 0
    const item = items[Math.min(index, items.length - 1)]
    const li = lis[Math.min(index, lis.length - 1)] as HTMLElement | undefined
    if (!li) return null
    const itemStart = (item?.position?.start.line ?? 1) - 1
    return domInlinePoint(li, editorLine - itemStart, offset)
  }

  if (mdastNode.type === 'containerDirective' && mdastNode.children?.length) {
    const tagDiv = blockEl.matches('.notes-tag-directive') ? blockEl : blockEl.querySelector<HTMLElement>(':scope > .notes-tag-directive')
    if (tagDiv) return domPointInChildren(tagDiv, mdastNode.children, editorLine, offset)
    const nested = blockEl.querySelector<HTMLElement>('[contenteditable="true"]')
    if (nested) return domPointInChildren(nested, mdastNode.children, editorLine, offset)
    return null
  }

  if (mdastNode.type === 'blockquote' && mdastNode.children?.length) {
    let index = mdastNode.children.findIndex((child) => {
      const position = child.position
      return !!position && editorLine >= position.start.line - 1 && editorLine <= position.end.line - 1
    })
    if (index < 0) index = mdastNode.children.findLastIndex((child) => (child.position?.start.line ?? 0) - 1 <= editorLine)
    if (index < 0) index = 0
    const childEl = blockChildren(blockEl)[Math.min(index, blockEl.children.length - 1)] as HTMLElement | undefined
    if (!childEl) return null
    return domPointInBlock(childEl, mdastNode.children[Math.min(index, mdastNode.children.length - 1)], editorLine, offset)
  }

  return domInlinePoint(blockEl, editorLine - startLine, offset)
}

function domPointInChildren(container: HTMLElement, nodes: MdastNode[], editorLine: number, offset: number): DomPoint | null {
  let index = nodes.findIndex((node) => {
    const position = node.position
    return !!position && editorLine >= position.start.line - 1 && editorLine <= position.end.line - 1
  })
  if (index < 0) index = nodes.findLastIndex((node) => (node.position?.start.line ?? 0) - 1 <= editorLine)
  if (index < 0) index = 0
  const node = nodes[Math.min(index, nodes.length - 1)]
  const children = blockChildren(container)
  const blockEl = children[Math.min(index, children.length - 1)]
  if (!node || !blockEl) return null
  return domPointInBlock(blockEl, node, editorLine, offset)
}

function domPointForEditorLine(host: HTMLElement, map: DocumentMap, editorLine: number, offset: number): DomPoint | null {
  const editable = contentEditable(host)
  if (!editable) return null
  return domPointInChildren(editable, map.blocks, editorLine, offset)
}

// The rendered DOM extent of a canonical source line — a whole block, one list
// item, or one soft-break segment inside a paragraph. Used to style muted
// lines through CSS highlights without touching editor DOM.
export function canonicalLineRange(host: HTMLElement, map: DocumentMap, canonicalLine: number): Range | null {
  const editorLine = editorLineForCanonical(map, canonicalLine)
  const start = domPointForEditorLine(host, map, editorLine, 0)
  const end = domPointForEditorLine(host, map, editorLine, Number.POSITIVE_INFINITY)
  if (!start || !end) return null
  const range = document.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  return range
}

export function placeCaretAtCanonicalLine(host: HTMLElement, map: DocumentMap, canonicalLine: number, offset: number): Node | null {
  const point = domPointForEditorLine(host, map, editorLineForCanonical(map, canonicalLine), offset)
  if (!point) return null
  const selection = window.getSelection()
  selection?.setBaseAndExtent(point.node, point.offset, point.node, point.offset)
  return point.node
}

export function selectCanonicalLines(host: HTMLElement, map: DocumentMap, startLine: number, endLine: number): Node | null {
  const anchor = domPointForEditorLine(host, map, editorLineForCanonical(map, startLine), 0)
  const focus = domPointForEditorLine(host, map, editorLineForCanonical(map, endLine), Number.POSITIVE_INFINITY)
  if (!anchor || !focus) return null
  const selection = window.getSelection()
  selection?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
  return anchor.node
}

// Re-applies a DOM selection across frames until it sticks. Directive
// decorators and their nested editors mount through React after a commit and
// can reset the DOM selection — but a remount also detaches the node we
// placed, so retrying only while the placed node is disconnected covers the
// remount without overriding the user's next click or keypress.
export function reapplyUntilSettled(place: () => Node | null) {
  let placed: Node | null = null
  const deadline = performance.now() + 800
  const apply = () => {
    if (placed?.isConnected) return
    const node = place()
    if (node) placed = node
    if (performance.now() < deadline) requestAnimationFrame(apply)
  }
  apply()
}
