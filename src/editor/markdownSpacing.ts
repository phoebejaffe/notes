import { isMutedLine, stripMutedMarkers } from '../markerEngine'

// The editor gets a slightly expanded version of the canonical source: a list
// item immediately followed by a non-list line (how the transcription writer
// emits `💡` paragraphs after tasks, or plain text after a bullet) would
// otherwise be parsed as a lazy continuation inside the list item. The
// injected blank line is stripped back out on export so the canonical source
// is never changed by rendering alone.
//
// Muted-line `%%` markers are likewise hidden from the editor: the caret can
// never sit inside them and export re-appends ` %%` to muted lines via
// preserveMutedLines.
const LIST_ITEM_LINE_PATTERN = /^\s*(?:[-*+]|\d+[.)])\s+\S/u

export function markdownForEditor(source: string): { markdown: string; editorLineToCanonical: number[] } {
  const lines = source.split('\n')
  const rendered: string[] = []
  const editorLineToCanonical: number[] = []
  lines.forEach((line, index) => {
    rendered.push(isMutedLine(line) ? stripMutedMarkers(line) : line)
    editorLineToCanonical.push(index)
    const next = lines[index + 1]
    if (LIST_ITEM_LINE_PATTERN.test(line) && next !== undefined && next.trim() && !LIST_ITEM_LINE_PATTERN.test(next) && !/^\s/.test(next)) {
      rendered.push('')
      editorLineToCanonical.push(index)
    }
  })
  return { markdown: rendered.join('\n'), editorLineToCanonical }
}

export function restoreMarkdownSpacing(previous: string, next: string) {
  const previousLines = previous.split('\n')
  const nextLines = next.split('\n')
  let searchStart = 0
  previousLines.forEach((line, index) => {
    const following = previousLines[index + 1]
    if (!LIST_ITEM_LINE_PATTERN.test(line) || following === undefined || !following.trim() || LIST_ITEM_LINE_PATTERN.test(following) || /^\s/.test(following)) return
    // `%%` markers never reach the editor, so compare the display form.
    const display = isMutedLine(line) ? stripMutedMarkers(line) : line
    const followingDisplay = isMutedLine(following) ? stripMutedMarkers(following) : following
    const lineIndex = nextLines.indexOf(display, searchStart)
    if (lineIndex < 0 || nextLines[lineIndex + 1] !== '' || nextLines[lineIndex + 2] !== followingDisplay) return
    nextLines.splice(lineIndex + 1, 1)
    searchStart = lineIndex + 1
  })
  return nextLines.join('\n')
}
