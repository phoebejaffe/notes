import { isMutedLine, stripMutedMarkers } from '../markerEngine'

// The editor gets a slightly expanded version of the canonical source: a list
// item immediately followed by a non-list line (how the transcription writer
// emits plain paragraphs after tasks, or plain text after a bullet) would
// otherwise be parsed as a lazy continuation inside the list item. The
// injected blank line is stripped back out on export so the canonical source
// is never changed by rendering alone.
//
// Muted-line `%%` markers are likewise hidden from the editor: the caret can
// never sit inside them and export re-appends ` %%` to muted lines via
// preserveMutedLines.
const LIST_ITEM_LINE_PATTERN = /^\s*(?:[-*+]|\d+[.)])\s+\S/u
const BLOCKQUOTE_LINE_PATTERN = /^\s*>/u

// A container line (list item or blockquote) directly followed by a plain
// line is a lazy continuation — the next line merges into the container.
// Rendering needs an injected blank line between them; export strips it back.
function needsEditorBreak(line: string, next: string | undefined) {
  if (next === undefined || !next.trim() || /^\s/u.test(next)) return false
  if (BLOCKQUOTE_LINE_PATTERN.test(line)) return !BLOCKQUOTE_LINE_PATTERN.test(next)
  return LIST_ITEM_LINE_PATTERN.test(line) && !LIST_ITEM_LINE_PATTERN.test(next)
}

export function markdownForEditor(source: string): { markdown: string; editorLineToCanonical: number[] } {
  const lines = source.split('\n')
  const rendered: string[] = []
  const editorLineToCanonical: number[] = []
  lines.forEach((line, index) => {
    rendered.push(isMutedLine(line) ? stripMutedMarkers(line) : line)
    editorLineToCanonical.push(index)
    const next = lines[index + 1]
    if (needsEditorBreak(line, next)) {
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
    if (!needsEditorBreak(line, following)) return
    // `%%` markers never reach the editor, so compare the display form.
    const display = isMutedLine(line) ? stripMutedMarkers(line) : line
    const followingDisplay = isMutedLine(following!) ? stripMutedMarkers(following!) : following
    const lineIndex = nextLines.indexOf(display, searchStart)
    if (lineIndex < 0 || nextLines[lineIndex + 1] !== '' || nextLines[lineIndex + 2] !== followingDisplay) return
    nextLines.splice(lineIndex + 1, 1)
    searchStart = lineIndex + 1
  })
  return nextLines.join('\n')
}
