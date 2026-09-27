import { isMutedLine } from '../markerEngine'
import { blockChildren, buildDocumentMap, canonicalLineRange, contentEditable, type DocumentMap } from './sourceMapping'

// Muted lines are styled with CSS highlights, not DOM mutation: `%%` markers
// never reach the editor's text, so the muted decoration maps canonical source
// lines to rendered DOM ranges. Highlights are document-global, so each host
// contributes its ranges to a shared registry.
const hosts = new Map<HTMLElement, { ranges: Range[]; hidden: boolean }>()

function applyHighlights() {
  if (typeof CSS === 'undefined' || !CSS.highlights) return
  const visible: Range[] = []
  const hiddenRanges: Range[] = []
  hosts.forEach((entry) => (entry.hidden ? hiddenRanges : visible).push(...entry.ranges))
  CSS.highlights.set('notes-muted-line', new Highlight(...visible))
  CSS.highlights.set('notes-muted-line-hidden', new Highlight(...hiddenRanges))
}

export function refreshMutedDecorations(host: HTMLElement, canonical: string, hidden: boolean) {
  const map = buildDocumentMap(canonical)
  const lines = canonical.split('\n')
  const ranges: Range[] = []
  lines.forEach((line, index) => {
    if (!isMutedLine(line)) return
    const range = canonicalLineRange(host, map, index)
    if (range) ranges.push(range)
  })

  // Blocks whose non-empty lines are all muted collapse entirely when hidden;
  // partially muted blocks keep the line visible (transparent text).
  const editable = contentEditable(host)
  if (editable) {
    const children = blockChildren(editable)
    map.blocks.forEach((block, index) => {
      const element = children[index]
      const start = block.position?.start.line
      const end = block.position?.end.line
      if (!element || !start || !end) return
      const first = map.editorLineToCanonical[start - 1] ?? 0
      const last = map.editorLineToCanonical[end - 1] ?? first
      const allMuted = lines.slice(first, last + 1).every((line) => !line.trim() || isMutedLine(line))
      if (element.hidden !== (allMuted && hidden)) element.hidden = allMuted && hidden
    })
  }

  hosts.set(host, { ranges, hidden })
  applyHighlights()
}

export function clearMutedDecorations(host: HTMLElement) {
  if (hosts.delete(host)) applyHighlights()
}

// Whether a node sits on a muted line that is currently hidden — covers the
// soft-break case where the line ghosts (transparent) instead of collapsing.
export function inHiddenMutedRange(host: HTMLElement, node: Node) {
  const entry = hosts.get(host)
  return !!entry?.hidden && entry.ranges.some((range) => range.intersectsNode(node))
}

// Whether a canonical line sits inside a block that collapses when muted
// lines are hidden — every non-empty line of the block is muted.
function lineInCollapsibleBlock(map: DocumentMap, lines: string[], canonicalLine: number) {
  const editorLine = map.editorLineToCanonical.indexOf(canonicalLine)
  const block = map.blocks.find(
    (node) => node.position && editorLine >= node.position.start.line - 1 && editorLine <= node.position.end.line - 1,
  )
  if (editorLine < 0 || !block?.position) return false
  const first = map.editorLineToCanonical[block.position.start.line - 1] ?? 0
  const last = map.editorLineToCanonical[block.position.end.line - 1] ?? first
  return lines.slice(first, last + 1).every((line) => !line.trim() || isMutedLine(line))
}

// The nearest canonical line that stays rendered when muted lines are hidden —
// the caret's target when its own line collapses.
export function nearestVisibleLine(canonical: string, line: number): number {
  const lines = canonical.split('\n')
  const map = buildDocumentMap(canonical)
  // Blank lines are skipped too — they have no own DOM block, so a caret
  // there would land inside the neighboring (possibly hidden) block.
  const visible = (index: number) =>
    index >= 0 && index < lines.length && !!lines[index].trim() && !lineInCollapsibleBlock(map, lines, index)
  if (visible(line)) return line
  for (let distance = 1; distance < lines.length; distance += 1) {
    if (visible(line + distance)) return line + distance
    if (visible(line - distance)) return line - distance
  }
  return line
}
