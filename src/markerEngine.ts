export interface TaggedRange {
  tag: string
  startLine: number
  endLine: number
  start: number
  end: number
}

export interface MarkerDiagnostic {
  line: number
  message: string
  severity: 'warning' | 'error'
}

export interface ParsedMarkdown {
  lines: string[]
  ranges: TaggedRange[]
  diagnostics: MarkerDiagnostic[]
}

// Nested tags need strictly longer fences outward (`::::` around `:::`) —
// micromark closes a directive on the first fence of equal length.
const DIRECTIVE_OPEN_PATTERN = /^\s*:{3,}tag\s*\{([^}]*)\}\s*$/u
const DIRECTIVE_CLOSE_PATTERN = /^\s*:{3,}\s*$/u

function normalizeTag(tag: string) {
  return tag.normalize('NFC')
}

function directiveTag(attributes: string) {
  const match = attributes.match(/(?:^|\s)name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s}]+))/u)
  const raw = match?.[1] ?? match?.[2] ?? match?.[3] ?? ''
  return normalizeTag(raw.replace(/&(?:quot|amp|lt|gt|#39);/gu, (entity) => ({ '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#39;': "'" })[entity] ?? entity))
}

export function markdownMarkState(source: string, from: number, to: number) {
  const before = source.slice(Math.max(0, from - 3), from)
  const after = source.slice(to, to + 3)
  const starBefore = before.match(/\*+$/u)?.[0].length ?? 0
  const starAfter = after.match(/^\*+/u)?.[0].length ?? 0
  const stars = starBefore === starAfter && starBefore <= 3 ? starBefore : 0
  return {
    bold: stars === 2 || stars === 3,
    italic: stars === 1 || stars === 3,
    strikethrough: source.slice(Math.max(0, from - 2), from) === '~~' && source.slice(to, to + 2) === '~~',
  }
}

export function sourceMatchesFilter(source: string, filterTags: string[], hideMutedLines: boolean) {
  const parsed = parseMarkdown(source)
  if (filterTags.length) {
    const selected = new Set(filterTags.map(normalizeTag))
    return parsed.lines.some((_line, index) => parsed.ranges.some((range) => selected.has(range.tag) && range.startLine < index && index < range.endLine))
  }
  return parsed.lines.some((line) => line.trim() && (!hideMutedLines || !isMutedLine(line)))
}

export function parseMarkdown(source: string): ParsedMarkdown {
  const lines = source.split('\n')
  const diagnostics: MarkerDiagnostic[] = []
  const stack: Array<{ tag: string; line: number; start: number }> = []
  const ranges: TaggedRange[] = []
  let offset = 0

  lines.forEach((line, lineIndex) => {
    const directiveOpen = line.match(DIRECTIVE_OPEN_PATTERN)
    const directiveClose = DIRECTIVE_CLOSE_PATTERN.test(line)
    if (directiveOpen) {
      const tag = directiveTag(directiveOpen[1])
      if (!tag) {
        diagnostics.push({ line: lineIndex, message: 'Tag directives require a name attribute.', severity: 'error' })
      } else {
        stack.push({ tag, line: lineIndex, start: offset })
      }
    } else if (directiveClose) {
      const open = stack.pop()
      if (!open) {
        diagnostics.push({ line: lineIndex, message: 'Tag close without a matching open.', severity: 'error' })
      } else {
        ranges.push({ tag: open.tag, startLine: open.line, endLine: lineIndex, start: open.start, end: offset })
      }
    }
    offset += line.length + 1
  })

  stack.forEach((value) => {
    diagnostics.push({ line: value.line, message: `“${value.tag}” is still open at the end of the document.`, severity: 'warning' })
  })

  return { lines, ranges, diagnostics }
}

// Keeps directive nesting valid: every directive's fence must be strictly
// longer than any directive fence it encloses, or micromark treats a same-
// length inner fence as the outer close. Repairs in place, innermost first
// so growth cascades outward.
function growDirectiveFences(lines: string[]) {
  const parsed = parseMarkdown(lines.join('\n'))
  const innermostFirst = [...parsed.ranges].sort((a, b) => b.startLine - a.startLine)
  for (const range of innermostFirst) {
    let required = 3
    for (let index = range.startLine + 1; index < range.endLine; index += 1) {
      const fenceLength = lines[index].match(/^\s*(:+)/u)?.[1].length
      if (fenceLength && (DIRECTIVE_OPEN_PATTERN.test(lines[index]) || DIRECTIVE_CLOSE_PATTERN.test(lines[index]))) {
        required = Math.max(required, fenceLength + 1)
      }
    }
    for (const fenceIndex of [range.startLine, range.endLine]) {
      const match = lines[fenceIndex].match(/^\s*(:+)/u)
      if (match && match[1].length < required) {
        lines[fenceIndex] = lines[fenceIndex].replace(/^(\s*):+/u, `$1${':'.repeat(required)}`)
      }
    }
  }
}

export function addTagDirectiveToRange(source: string, startLine: number, endLine: number, tag: string) {
  const normalized = normalizeTag(tag.trim())
  const lines = source.split('\n')
  const isBoundary = (line: string) => DIRECTIVE_OPEN_PATTERN.test(line) || DIRECTIVE_CLOSE_PATTERN.test(line)

  // A selection crossing existing tag boundaries tags each contiguous region
  // separately — inside an existing tag the new tag nests; outside it becomes
  // a sibling. Like HTML, tags nest but never overlap.
  const segments: Array<{ startLine: number; endLine: number }> = []
  let segmentStart = -1
  for (let index = startLine; index <= endLine; index += 1) {
    if (isBoundary(lines[index])) {
      if (segmentStart >= 0) segments.push({ startLine: segmentStart, endLine: index - 1 })
      segmentStart = -1
    } else if (segmentStart < 0) segmentStart = index
  }
  if (segmentStart >= 0) segments.push({ startLine: segmentStart, endLine })
  const targets = segments.filter(({ startLine: start, endLine: end }) =>
    lines.slice(start, end + 1).some((line) => line.trim()))

  let delta = 0
  let mappedStart = -1
  let mappedEnd = -1
  let error: string | undefined
  const escaped = normalized.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  for (const segment of targets) {
    const parsed = parseMarkdown(lines.join('\n'))
    const alreadyActive = parsed.ranges.some((range) => range.tag === normalized && range.startLine <= segment.startLine + delta && range.endLine >= segment.endLine + delta)
    if (alreadyActive) {
      error = `“${normalized}” is already active in this selection.`
      continue
    }
    const insertStart = segment.startLine + delta
    const insertEnd = segment.endLine + delta
    lines.splice(insertEnd + 1, 0, ':::')
    lines.splice(insertStart, 0, `:::tag{name="${escaped}"}`)
    growDirectiveFences(lines)
    if (mappedStart < 0) mappedStart = insertStart + 1
    mappedEnd = insertEnd + 1
    delta += 2
  }
  if (mappedStart < 0) return { source, error: error ?? 'Nothing to tag in this selection.' }
  return { source: lines.join('\n'), startLine: mappedStart, endLine: mappedEnd }
}

// A line is muted when it contains `%%` anywhere; when muting we append ` %%`
// at the end of the line so it stays clear of list/heading prefixes.
export function mutedMarkerPosition(line: string) {
  const match = /%%/u.exec(line)
  if (!match) return undefined
  let start = match.index
  let end = match.index + 2
  if (line[end] === ' ') end += 1
  else if (start > 0 && line[start - 1] === ' ') start -= 1
  return { start, end }
}

export function isMutedLine(line: string) {
  return line.includes('%%')
}

// Removes every `%%` marker, collapsing the space the marker sat in. Trailing
// ` %%` is removed entirely; a mid-line `foo %% bar` becomes `foo bar`.
export function stripMutedMarkers(line: string) {
  return line.replace(/^ ?%% ?/u, '').replace(/ ?%% ?/gu, ' ').replace(/\s+$/u, '')
}

export function preserveMutedLines(previous: string, next: string) {
  const previousLines = previous.split('\n')
  const nextLines = next.split('\n')
  const claimed = new Set<number>()
  let searchStart = 0
  const claim = (index: number) => {
    claimed.add(index)
    searchStart = Math.max(searchStart, index + 1)
    if (!isMutedLine(nextLines[index])) nextLines[index] = `${nextLines[index].trimEnd()} %%`
  }
  previousLines.forEach((previousLine, index) => {
    if (!isMutedLine(previousLine)) return
    const want = comparableWithoutMute(previousLine)
    if (!want) return
    if (index < nextLines.length && !claimed.has(index) && comparableWithoutMute(nextLines[index]) === want) {
      claim(index)
      return
    }
    const matchIndex = nextLines.findIndex((line, nextIndex) => nextIndex >= searchStart && !claimed.has(nextIndex) && comparableWithoutMute(line) === want)
    if (matchIndex >= 0) {
      claim(matchIndex)
      return
    }
    // The line was edited in place (its text no longer matches) — keep it muted.
    if (index < nextLines.length && !claimed.has(index) && nextLines[index].trim()) claim(index)
  })
  return nextLines.join('\n')
}

function comparableWithoutMute(line: string) {
  return stripMutedMarkers(line)
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/u, '')
    .replace(/^\s*#{1,6}\s+/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

export function toggleMutedLines(source: string, startLine: number, endLine: number) {
  const originalLines = source.split('\n')
  const lines = [...originalLines]
  const selected = lines.slice(startLine, endLine + 1)
  const unmute = selected.length > 0 && selected.every((line) => !line.trim() || isMutedLine(line))
  lines.slice(startLine, endLine + 1).forEach((line, offset) => {
    const index = startLine + offset
    if (unmute) lines[index] = stripMutedMarkers(line)
    else if (line.trim() && !isMutedLine(line)) lines[index] = `${line.trimEnd()} %%`
  })
  const changes: Array<{ from: number; to: number; insert: string }> = []
  let offset = 0
  originalLines.forEach((line, index) => {
    if (line !== lines[index] && index >= startLine && index <= endLine) changes.push({ from: offset, to: offset + line.length, insert: lines[index] })
    offset += line.length + 1
  })
  return { source: lines.join('\n'), muted: !unmute, changes }
}

const LIST_ITEM_PATTERN = /^(\s*)([-*+] |\d+[.)] )(.*)$/u
const CHECKLIST_ITEM_PATTERN = /^(\s*(?:[-*+]|\d+[.)]) (?:%% )?)\[([ xX])\](.*)$/u

// Indent/outdent operates in source space on list items only — Markdown has
// no paragraph indentation, so non-list lines are untouched. `indent`
// prepends two spaces; `outdent` removes up to two leading spaces (or one
// tab). Returns the new source plus the caret-column delta on startLine, or
// null when nothing changed.
export function indentLines(source: string, startLine: number, endLine: number, direction: 'indent' | 'outdent') {
  const lines = source.split('\n')
  let changed = false
  let caretDelta = 0
  for (let index = Math.max(0, startLine); index <= Math.min(endLine, lines.length - 1); index += 1) {
    const line = lines[index]
    const item = line.match(/^(\s*)(?:[-*+]|\d+[.)] )/u)
    if (!item) continue
    if (direction === 'indent') {
      lines[index] = `  ${line}`
      if (index === startLine) caretDelta += 2
    } else {
      const removed = line.startsWith('\t') ? 1 : Math.min(2, item[1].length)
      if (!removed) continue
      lines[index] = line.slice(removed)
      if (index === startLine) caretDelta -= removed
    }
    changed = true
  }
  return changed ? { source: lines.join('\n'), caretDelta } : null
}

export function toggleChecklist(source: string, lineIndex: number) {
  const lines = source.split('\n')
  const line = lines[lineIndex]
  if (line === undefined) return source
  const checklist = line.match(CHECKLIST_ITEM_PATTERN)
  if (checklist) {
    lines[lineIndex] = `${checklist[1]}[${checklist[2].toLowerCase() === 'x' ? ' ' : 'x'}]${checklist[3]}`
    return lines.join('\n')
  }
  const listItem = line.match(LIST_ITEM_PATTERN)
  if (listItem) {
    const mutedRest = listItem[3].match(/^%%(?:\s|$)/u)
    lines[lineIndex] = mutedRest
      ? `${listItem[1]}${listItem[2]}%% [ ] ${listItem[3].slice(mutedRest[0].length)}`
      : `${listItem[1]}${listItem[2]}[ ] ${listItem[3]}`
    return lines.join('\n')
  }
  const muted = mutedMarkerPosition(line)
  if (muted && !line.slice(0, muted.start).trim()) {
    lines[lineIndex] = `${line.slice(0, muted.start)}- %% [ ] ${line.slice(muted.end)}`
    return lines.join('\n')
  }
  const indent = line.match(/^\s*/u)![0]
  lines[lineIndex] = `${indent}- [ ] ${line.slice(indent.length)}`
  return lines.join('\n')
}

export function removeChecklist(source: string, lineIndex: number) {
  const lines = source.split('\n')
  const line = lines[lineIndex]
  if (line === undefined) return source
  const checklist = line.match(CHECKLIST_ITEM_PATTERN)
  if (!checklist) return source
  const rest = checklist[3].replace(/^ /u, '')
  lines[lineIndex] = rest ? `${checklist[1]}${rest}` : checklist[1].trimEnd()
  return lines.join('\n')
}

export function checklistToPlainText(source: string, lineIndex: number) {
  const lines = source.split('\n')
  const line = lines[lineIndex]
  if (line === undefined) return source
  const item = line.match(/^(\s*)(?:[-*+]|\d+[.)]) (.*)$/u)
  if (!item) return source
  let rest = item[2]
  const muted = rest.match(/^%% /u)
  if (muted) rest = rest.slice(muted[0].length)
  const task = rest.match(/^\[[ xX]\] ?/u)
  if (task) rest = rest.slice(task[0].length)
  lines[lineIndex] = `${item[1]}${muted ? '%% ' : ''}${rest}`
  return lines.join('\n')
}

// Moves a line range across a `:::tag{…}` directive boundary. A line inside
// a tag at its edge escapes the tag, landing as its own blank-separated
// block; a line outside ENTERS the tag, landing as a blank-separated block
// just inside the delimiter — so lines walk into a tag step by step and keep
// moving through its contents.
function movePastDirectiveBoundary(
  lines: string[],
  startLine: number,
  endLine: number,
  direction: 'up' | 'down',
  segmentStart: number,
  segmentEnd: number,
) {
  const count = endLine - startLine + 1
  const isBoundaryLine = (line: string) => DIRECTIVE_OPEN_PATTERN.test(line) || DIRECTIVE_CLOSE_PATTERN.test(line)
  if (direction === 'up') {
    const boundary = segmentStart > 0 ? lines[segmentStart - 1] : undefined
    if (boundary === undefined) return null
    if (DIRECTIVE_OPEN_PATTERN.test(boundary)) {
      // Inside a tag at its top edge: escape above the opener.
      const insertBefore = segmentStart - 1
      const moved = lines.splice(startLine, count)
      const payload = [...moved, '']
      let lead = 0
      if (insertBefore > 0 && lines[insertBefore - 1].trim()) { payload.unshift(''); lead = 1 }
      lines.splice(insertBefore, 0, ...payload)
      return { source: lines.join('\n'), startLine: insertBefore + lead, endLine: insertBefore + lead + moved.length - 1 }
    }
    if (!DIRECTIVE_CLOSE_PATTERN.test(boundary)) return null
    // Below a tag: enter it, landing blank-separated just above the closer.
    // The separator line that divided the moved block from the tag is
    // redundant once the block is inside.
    const moved = lines.splice(startLine, count)
    const closeIndex = segmentStart - 1
    if (lines[closeIndex + 1] === '') lines.splice(closeIndex + 1, 1)
    const payload = [...moved]
    let lead = 0
    if (closeIndex > 0 && lines[closeIndex - 1].trim() && !isBoundaryLine(lines[closeIndex - 1])) { payload.unshift(''); lead = 1 }
    lines.splice(closeIndex, 0, ...payload)
    return { source: lines.join('\n'), startLine: closeIndex + lead, endLine: closeIndex + lead + moved.length - 1 }
  }
  const boundary = segmentEnd + 1 < lines.length ? lines[segmentEnd + 1] : undefined
  if (boundary === undefined) return null
  if (DIRECTIVE_CLOSE_PATTERN.test(boundary)) {
    // Inside a tag at its bottom edge: escape below the closer.
    let insertAfter = segmentEnd + 1
    const moved = lines.splice(startLine, count)
    insertAfter -= count
    const payload = [...moved]
    let lead = 0
    let insertAt = insertAfter + 1
    if (insertAt < lines.length && !lines[insertAt].trim()) insertAt += 1
    else { payload.unshift(''); lead = 1 }
    if (insertAt < lines.length && lines[insertAt].trim()) payload.push('')
    lines.splice(insertAt, 0, ...payload)
    return { source: lines.join('\n'), startLine: insertAt + lead, endLine: insertAt + lead + moved.length - 1 }
  }
  if (!DIRECTIVE_OPEN_PATTERN.test(boundary)) return null
  // Above a tag: enter it, landing blank-separated just below the opener. The
  // separator line between the moved block and the tag becomes redundant.
  const moved = lines.splice(startLine, count)
  let openIndex = segmentEnd + 1 - count
  if (lines[openIndex - 1] === '') { lines.splice(openIndex - 1, 1); openIndex -= 1 }
  const insertAt = openIndex + 1
  const payload = [...moved]
  if (lines[insertAt] !== undefined && lines[insertAt].trim() && !isBoundaryLine(lines[insertAt])) payload.push('')
  lines.splice(insertAt, 0, ...payload)
  return { source: lines.join('\n'), startLine: insertAt, endLine: insertAt + moved.length - 1 }
}

// A move whose selection straddles exactly one `:::tag` fence shifts the
// fence instead of the text: moving toward the tag's interior extends the
// tag to enclose the whole selection; moving away shrinks the tag to exclude
// it. Selections spanning more than one fence are ambiguous and no-op.
function shiftDirectiveBoundary(
  lines: string[],
  startLine: number,
  endLine: number,
  direction: 'up' | 'down',
) {
  const boundaries: number[] = []
  for (let index = startLine; index <= endLine; index += 1) {
    if (DIRECTIVE_OPEN_PATTERN.test(lines[index]) || DIRECTIVE_CLOSE_PATTERN.test(lines[index])) boundaries.push(index)
  }
  if (boundaries.length !== 1) return null
  const fenceIndex = boundaries[0]
  const isClose = DIRECTIVE_CLOSE_PATTERN.test(lines[fenceIndex])
  // Toward the interior is up across a close or down across an open.
  const enclose = isClose === (direction === 'up')
  const fence = lines.splice(fenceIndex, 1)[0]
  lines.splice(enclose === isClose ? endLine : startLine, 0, fence)
  growDirectiveFences(lines)
  return { source: lines.join('\n'), startLine, endLine }
}

export function moveLines(source: string, startLine: number, endLine: number, direction: 'up' | 'down') {
  return moveLinesDetailed(source, startLine, endLine, direction)?.source ?? source
}

export function moveLinesDetailed(source: string, startLine: number, endLine: number, direction: 'up' | 'down') {
  const lines = source.split('\n')
  if (startLine < 0 || endLine >= lines.length || startLine > endLine) return null
  const isBoundary = (line: string) => DIRECTIVE_OPEN_PATTERN.test(line) || DIRECTIVE_CLOSE_PATTERN.test(line)
  if (lines.slice(startLine, endLine + 1).some(isBoundary)) return shiftDirectiveBoundary(lines, startLine, endLine, direction)
  let segmentStart = startLine
  while (segmentStart > 0 && !isBoundary(lines[segmentStart - 1])) segmentStart -= 1
  let segmentEnd = endLine
  while (segmentEnd + 1 < lines.length && !isBoundary(lines[segmentEnd + 1])) segmentEnd += 1
  const slots = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => index >= segmentStart && index <= segmentEnd && line.trim())
  const selectedSlots = slots.filter(({ index }) => index >= startLine && index <= endLine)
  if (!selectedSlots.length) return null
  const firstSelected = slots.indexOf(selectedSlots[0])
  const lastSelected = slots.indexOf(selectedSlots.at(-1)!)
  const adjacentSlot = direction === 'up' ? firstSelected - 1 : lastSelected + 1
  if (adjacentSlot < 0 || adjacentSlot >= slots.length) {
    return movePastDirectiveBoundary(lines, startLine, endLine, direction, segmentStart, segmentEnd)
  }

  // Content that isn't part of a list moves past a whole contiguous list run
  // as one block, landing as its own blank-separated paragraph instead of
  // merging into a list item or a neighboring paragraph.
  const isListLine = (line: string) => /^\s*(?:[-*+]|\d+[.)])\s/u.test(line)
  const neighborIndex = slots[adjacentSlot].index
  const movedIsList = lines.slice(startLine, endLine + 1).some((line) => isListLine(line))
  if (!movedIsList && isListLine(lines[neighborIndex])) {
    let runStart = neighborIndex
    while (runStart > 0 && isListLine(lines[runStart - 1])) runStart -= 1
    let runEnd = neighborIndex
    while (runEnd + 1 < lines.length && isListLine(lines[runEnd + 1])) runEnd += 1
    const moved = lines.splice(startLine, endLine - startLine + 1)
    const payload = [...moved]
    let insertAt: number
    let lead = 0
    if (direction === 'up') {
      insertAt = runStart
      if (runStart > 0 && lines[runStart - 1].trim()) { payload.unshift(''); lead = 1 }
      payload.push('')
    } else {
      insertAt = runEnd - moved.length + 1
      if (insertAt < lines.length && !lines[insertAt].trim()) insertAt += 1
      else { payload.unshift(''); lead = 1 }
      if (insertAt < lines.length && lines[insertAt].trim()) payload.push('')
    }
    const movedStart = insertAt + lead
    lines.splice(insertAt, 0, ...payload)
    return { source: lines.join('\n'), startLine: movedStart, endLine: movedStart + moved.length - 1 }
  }
  const orderedSlots = direction === 'up'
    ? [slots[adjacentSlot], ...selectedSlots]
    : [...selectedSlots, slots[adjacentSlot]]
  const values = direction === 'up'
    ? [...selectedSlots.map(({ index }) => lines[index]), lines[slots[adjacentSlot].index]]
    : [lines[slots[adjacentSlot].index], ...selectedSlots.map(({ index }) => lines[index])]
  orderedSlots.forEach(({ index }, offset) => { lines[index] = values[offset] })
  const movedStart = direction === 'up' ? slots[firstSelected - 1].index : slots[firstSelected + 1].index
  const movedEnd = direction === 'up' ? slots[lastSelected - 1].index : slots[lastSelected + 1].index
  return { source: lines.join('\n'), startLine: movedStart, endLine: movedEnd }
}

// Removes a canonical line range for the cross-editor move (Cmd/Ctrl-M).
// Selections covering only directive *contents* move raw — the fences stay
// behind — but a selection covering exactly one fence of a `:::tag` pair
// expands to the whole block so neither document is left with an unbalanced
// directive. Returns the remaining source, the moved text, and the final
// (possibly expanded) range, or null when the range is invalid.
export function extractLinesForMove(source: string, startLine: number, endLine: number) {
  const lines = source.split('\n')
  let start = Math.max(0, Math.min(startLine, lines.length - 1))
  let end = Math.max(0, Math.min(endLine, lines.length - 1))
  if (start > end) return null
  const parsed = parseMarkdown(source)
  for (let changed = true; changed;) {
    changed = false
    for (const range of parsed.ranges) {
      const openInside = range.startLine >= start && range.startLine <= end
      const closeInside = range.endLine >= start && range.endLine <= end
      if (openInside === closeInside) continue
      start = Math.min(start, range.startLine)
      end = Math.max(end, range.endLine)
      changed = true
    }
  }
  const moved = lines.slice(start, end + 1)
  return { source: [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n'), moved: moved.join('\n'), startLine: start, endLine: end }
}

export function removeTagAtPosition(source: string, lineIndex: number, tag: string) {
  const parsed = parseMarkdown(source)
  const range = parsed.ranges.filter((item) => item.tag === normalizeTag(tag) && item.startLine < lineIndex && lineIndex < item.endLine).sort((left, right) => right.startLine - left.startLine)[0]
  if (!range) return { source, error: `No active “${tag}” tag at this position.` }
  const lines = [...parsed.lines]
  lines.splice(range.endLine, 1)
  lines.splice(range.startLine, 1)
  return { source: lines.join('\n') }
}

export function renameTagEverywhere(source: string, oldTag: string, newTag: string) {
  const normalizedOldTag = normalizeTag(oldTag)
  const lines = source.split('\n')
  lines.forEach((line, lineIndex) => {
    const directive = line.match(DIRECTIVE_OPEN_PATTERN)
    if (directive && directiveTag(directive[1]) === normalizedOldTag) {
      lines[lineIndex] = line.replace(/(name\s*=\s*)("[^"]*"|'[^']*'|[^\s}]+)/u, `$1"${newTag.replaceAll('"', '&quot;')}"`)
    }
  })
  return lines.join('\n')
}

export function lineRangeForSelection(source: string, from: number, to: number) {
  const before = source.slice(0, from)
  const selected = source.slice(from, to)
  const startLine = before.split('\n').length - 1
  const endLine = startLine + selected.split('\n').length - 1
  return { startLine, endLine }
}
