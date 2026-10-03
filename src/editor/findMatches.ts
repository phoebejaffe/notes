import { contentEditable } from './sourceMapping'

// Find-in-page matches over *rendered* editor text. Matches are DOM ranges,
// so they feed CSS highlights directly and never touch editor content —
// Markdown syntax that isn't rendered (link URLs, `%%`, directive fences)
// simply doesn't match, same as browser find-in-page.
export interface FindMatch {
  kind: 'range' | 'collapsed-note'
  // The card owning the match — scroll and lane-switch target.
  card: HTMLElement
  range?: Range
  noteId?: string
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

// A typed space also matches a non-breaking space — Lexical renders trailing
// whitespace as &nbsp;, which a literal space in the query would miss.
function findRegex(query: string) {
  return new RegExp(escapeRegExp(query).replaceAll(' ', String.raw`[\s\u00A0]`), 'giu')
}

function textMatchRanges(editable: HTMLElement, needle: RegExp): Range[] {
  const ranges: Range[] = []
  const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const element = node instanceof Element ? node : node.parentElement
      return element?.closest('[data-lexical-cursor]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    },
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? ''
    needle.lastIndex = 0
    for (let hit = needle.exec(text); hit; hit = needle.exec(text)) {
      if (!hit[0].length) break
      const range = document.createRange()
      range.setStart(node, hit.index)
      range.setEnd(node, hit.index + hit[0].length)
      ranges.push(range)
    }
  }
  return ranges
}

// All matches in card (visual) order across every lane: day cards and expanded
// note cards contribute one match per rendered occurrence; a collapsed note
// whose source contains the query contributes one placeholder match that
// expands the note when navigation lands on it.
export function collectFindMatches(query: string, viewport: HTMLElement, collapsedNoteIds: Set<string>): FindMatch[] {
  const trimmed = query.trim()
  if (!trimmed) return []
  const needle = findRegex(trimmed)
  const matches: FindMatch[] = []
  viewport.querySelectorAll<HTMLElement>('.day-card, .note-card').forEach((card) => {
    const host = card.querySelector<HTMLElement>('.notes-mdx-editor')
    const editable = contentEditable(host)
    if (editable) {
      for (const range of textMatchRanges(editable, needle)) matches.push({ kind: 'range', card, range })
    } else {
      const noteId = card.dataset.noteId
      if (noteId && collapsedNoteIds.has(noteId)) matches.push({ kind: 'collapsed-note', card, noteId })
    }
  })
  return matches
}

// Two persistent Highlight objects, mutated rather than replaced: swapping the
// registered object via HighlightRegistry.set() can leave the previous
// highlight painted (stale matches linger after the query changes) in engines
// that don't invalidate on replace, while add/clear always fires invalidation.
const baseFindHighlight = typeof Highlight === 'undefined' ? null : new Highlight()
const currentFindHighlight = typeof Highlight === 'undefined' ? null : new Highlight()

export function applyFindHighlights(matches: FindMatch[], currentIndex: number) {
  if (typeof CSS === 'undefined' || !CSS.highlights || !baseFindHighlight || !currentFindHighlight) return
  baseFindHighlight.clear()
  currentFindHighlight.clear()
  matches.forEach((match, index) => {
    if (!match.range) return
    ;(index === currentIndex ? currentFindHighlight : baseFindHighlight).add(match.range)
  })
  CSS.highlights.set('notes-find-match', baseFindHighlight)
  CSS.highlights.set('notes-find-match-current', currentFindHighlight)
}

export function clearFindHighlights() {
  if (typeof CSS === 'undefined' || !CSS.highlights || !baseFindHighlight || !currentFindHighlight) return
  baseFindHighlight.clear()
  currentFindHighlight.clear()
}
