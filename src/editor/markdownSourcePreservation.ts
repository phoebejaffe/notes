// Reduces a Markdown source line to roughly what it renders as in the editor,
// so rendered DOM text can be matched back to its source line. Links and
// images resolve to their label text; emphasis markers and HTML are stripped.
export function comparableLineText(line: string) {
  return line
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)/u, '')
    .replace(/^\[[ xX]\]\s+/u, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/<[^>]+>/gu, '')
    .replace(/[\\*_`]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

const LIST_ITEM_LINE_PATTERN = /^\s*(?:[-*+]|\d+[.)])\s+\S/u
const CHECKLIST_ITEM_LINE_PATTERN = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+\S/u

export function markdownForEditor(source: string) {
  const lines = source.split('\n')
  const rendered: string[] = []
  lines.forEach((line, index) => {
    rendered.push(line)
    const next = lines[index + 1]
    if (CHECKLIST_ITEM_LINE_PATTERN.test(line) && next !== undefined && next.trim() && !LIST_ITEM_LINE_PATTERN.test(next) && !/^\s/.test(next)) rendered.push('')
  })
  return rendered.join('\n')
}

export function restoreMarkdownSpacing(previous: string, next: string) {
  const previousLines = previous.split('\n')
  const nextLines = next.split('\n')
  let searchStart = 0
  previousLines.forEach((line, index) => {
    const following = previousLines[index + 1]
    if (!CHECKLIST_ITEM_LINE_PATTERN.test(line) || following === undefined || !following.trim() || LIST_ITEM_LINE_PATTERN.test(following) || /^\s/.test(following)) return
    const lineIndex = nextLines.indexOf(line, searchStart)
    if (lineIndex < 0 || nextLines[lineIndex + 1] !== '') return
    nextLines.splice(lineIndex + 1, 1)
    searchStart = lineIndex + 1
  })
  return nextLines.join('\n')
}

export function sourceLineForRenderedText(source: string, renderedText: string) {
  const normalized = renderedText.replace(/\s+/gu, ' ').trim()
  if (!normalized) return -1
  return source.split('\n').findIndex((line) => {
    const sourceText = comparableLineText(line)
    return sourceText && (sourceText.includes(normalized) || normalized.includes(sourceText))
  })
}

export function sourceLineRangeForRenderedSelection(source: string, renderedText: string) {
  const normalized = renderedText.replace(/%%\s*/gu, '').replace(/\s+/gu, ' ').trim()
  if (!normalized) return undefined
  const lines = source.split('\n')
  const comparableLines = lines.map((line) => comparableLineText(line).replace(/^%%\s+/u, ''))
  const compactSelection = normalized.replace(/\s+/gu, '')
  for (let startLine = 0; startLine < comparableLines.length; startLine += 1) {
    if (!comparableLines[startLine]) continue
    let combined = ''
    let compactCombined = ''
    for (let endLine = startLine; endLine < comparableLines.length; endLine += 1) {
      if (comparableLines[endLine]) {
        combined = combined ? `${combined} ${comparableLines[endLine]}` : comparableLines[endLine]
        compactCombined += comparableLines[endLine].replace(/\s+/gu, '')
      }
      if (combined.length < normalized.length && compactCombined.length < compactSelection.length) continue
      const matchStart = combined.indexOf(normalized)
      const compactMatchStart = compactCombined.indexOf(compactSelection)
      const matchedStart = matchStart >= 0 ? matchStart : compactMatchStart
      if (matchedStart >= 0) {
        const matchedLength = matchStart >= 0 ? normalized.length : compactSelection.length
        const parts: Array<{ lineIndex: number; start: number; end: number }> = []
        let cursor = 0
        for (let lineIndex = startLine; lineIndex <= endLine; lineIndex += 1) {
          const lineLength = comparableLines[lineIndex].length
          if (!lineLength) continue
          parts.push({ lineIndex, start: cursor, end: cursor + lineLength })
          cursor += lineLength + 1
        }
        const matchEnd = matchedStart + matchedLength
        const start = parts.find((part) => matchedStart < part.end)?.lineIndex ?? parts.at(-1)?.lineIndex ?? startLine
        const end = [...parts].reverse().find((part) => matchEnd > part.start)?.lineIndex ?? start
        return { startLine: start, endLine: Math.max(start, end) }
      }
      break
    }
  }
  return undefined
}
function isMarkerLine(line: string) {
  return /^\s*(?:%%\s+)?<!--[\s\S]*-->\s*$/u.test(line)
}

function isClosingMarker(line: string) {
  return /^\s*(?:%%\s+)?<!--\s*\//u.test(line)
}

function findAnchor(lines: string[], value: string, start: number) {
  for (let index = Math.max(0, start); index < lines.length; index += 1) {
    if (lines[index] === value) return index
  }
  return -1
}

export function preserveMarkerLines(previous: string, next: string) {
  const previousLines = previous.split('\n')
  const nextLines = next.split('\n')
  let searchStart = 0

  previousLines.forEach((line, index) => {
    if (!isMarkerLine(line) || nextLines.includes(line)) return
    const before = previousLines.slice(0, index).reverse().find((candidate) => !isMarkerLine(candidate))
    const after = previousLines.slice(index + 1).find((candidate) => !isMarkerLine(candidate))
    const afterIndex = after ? findAnchor(nextLines, after, searchStart) : -1
    const beforeIndex = before ? findAnchor(nextLines, before, searchStart) : -1
    const insertionIndex = afterIndex >= 0
      ? afterIndex
      : isClosingMarker(line) && !after
        ? nextLines.length
        : beforeIndex >= 0
          ? beforeIndex + 1
          : Math.min(index, nextLines.length)
    nextLines.splice(insertionIndex, 0, line)
    searchStart = insertionIndex + 1
  })

  return nextLines.join('\n')
}
