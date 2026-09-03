export type MarkerKind = 'open' | 'close'

export interface MarkerToken {
  kind: MarkerKind
  tags: string[]
  line: number
  start: number
  end: number
  raw: string
}

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
  markers: MarkerToken[]
  ranges: TaggedRange[]
  diagnostics: MarkerDiagnostic[]
}

const MARKER_PATTERN = /^\s*<!--([\s\S]*?)-->\s*$/

function normalizeTag(tag: string) {
  return tag.normalize('NFC')
}

function tokenizeTags(input: string): { tags: string[]; malformed: boolean } {
  const tags: string[] = []
  let index = 0
  let malformed = false

  while (index < input.length) {
    while (/\s/u.test(input[index] ?? '')) index += 1
    if (index >= input.length) break

    let closing = false
    if (input[index] === '/') {
      closing = true
      index += 1
      while (/\s/u.test(input[index] ?? '')) index += 1
    }

    let value = ''
    if (input[index] === '"') {
      index += 1
      while (index < input.length && input[index] !== '"') {
        if (input[index] === '\\' && index + 1 < input.length) {
          index += 1
          value += input[index]
        } else {
          value += input[index]
        }
        index += 1
      }
      if (input[index] !== '"') malformed = true
      else index += 1
    } else {
      while (index < input.length && !/\s/u.test(input[index])) {
        value += input[index]
        index += 1
      }
    }

    if (!value) {
      malformed = true
      continue
    }
    tags.push(`${closing ? '/' : ''}${normalizeTag(value)}`)
  }

  return { tags, malformed }
}

export function parseMarkdown(source: string): ParsedMarkdown {
  const lines = source.split('\n')
  const markers: MarkerToken[] = []
  const diagnostics: MarkerDiagnostic[] = []
  const active = new Map<string, { line: number; start: number }>()
  const ranges: TaggedRange[] = []
  let offset = 0

  lines.forEach((line, lineIndex) => {
    const match = line.match(MARKER_PATTERN)
    if (match) {
      const tokenized = tokenizeTags(match[1].trim())
      const tags = tokenized.tags
      const hasOpen = tags.some((tag) => !tag.startsWith('/'))
      const hasClose = tags.some((tag) => tag.startsWith('/'))
      if (tokenized.malformed || !tags.length || (hasOpen && hasClose)) {
        diagnostics.push({
          line: lineIndex,
          message: hasOpen && hasClose ? 'Opening and closing tags must use separate lines.' : 'Could not parse this marker line.',
          severity: 'error',
        })
      } else {
        const kind: MarkerKind = hasClose ? 'close' : 'open'
        const cleanTags = tags.map((tag) => tag.replace(/^\//u, ''))
        markers.push({ kind, tags: cleanTags, line: lineIndex, start: offset, end: offset + line.length, raw: line })
        cleanTags.forEach((tag) => {
          if (kind === 'open') {
            const existing = active.get(tag)
            if (existing) {
              diagnostics.push({ line: lineIndex, message: `“${tag}” is already active; the previous span was closed here.`, severity: 'warning' })
              ranges.push({ tag, startLine: existing.line, endLine: lineIndex, start: existing.start, end: offset })
            }
            active.set(tag, { line: lineIndex, start: offset })
          } else {
            const existing = active.get(tag)
            if (!existing) {
              diagnostics.push({ line: lineIndex, message: `No open span found for “${tag}”.`, severity: 'error' })
            } else {
              ranges.push({ tag, startLine: existing.line, endLine: lineIndex, start: existing.start, end: offset })
              active.delete(tag)
            }
          }
        })
      }
    }
    offset += line.length + 1
  })

  active.forEach((value, tag) => {
    diagnostics.push({ line: value.line, message: `“${tag}” is still open at the end of the document.`, severity: 'warning' })
  })

  return { lines, markers, ranges, diagnostics }
}

export function formatMarker(kind: MarkerKind, tags: string[]) {
  const formatted = tags.map((tag) => {
    const escaped = tag.includes(' ') ? `"${tag.replaceAll('"', '\\"')}"` : tag
    return kind === 'close' ? `/${escaped}` : escaped
  })
  return `<!-- ${formatted.join(' ')} -->`
}

export function addTagToRange(source: string, startLine: number, endLine: number, tag: string) {
  const parsed = parseMarkdown(source)
  const normalized = normalizeTag(tag.trim())
  const alreadyActive = parsed.ranges.some((range) => range.tag === normalized && range.startLine <= startLine && range.endLine >= endLine)
  if (alreadyActive) return { source, error: `“${normalized}” is already active in this selection.` }

  const lines = [...parsed.lines]
  const openLine = formatMarker('open', [normalized])
  const closeLine = formatMarker('close', [normalized])
  lines.splice(endLine + 1, 0, closeLine)
  lines.splice(startLine, 0, openLine)
  return { source: lines.join('\n') }
}

const MUTED_PREFIX_PATTERN = /^(\s*(?:(?:[-*+]|\d+[.)])\s+|#{1,6}\s+)?)(%%)(?:\s|$)/u

export function mutedMarkerPosition(line: string) {
  const match = line.match(MUTED_PREFIX_PATTERN)
  if (!match) return undefined
  return { start: match[1].length, end: match[0].length }
}

export function isMutedLine(line: string) {
  return mutedMarkerPosition(line) !== undefined
}

export function toggleMutedLines(source: string, startLine: number, endLine: number) {
  const originalLines = source.split('\n')
  const lines = [...originalLines]
  const selected = lines.slice(startLine, endLine + 1)
  const unmute = selected.length > 0 && selected.every(isMutedLine)
  lines.slice(startLine, endLine + 1).forEach((line, offset) => {
    const index = startLine + offset
    const marker = mutedMarkerPosition(line)
    if (unmute && marker) {
      lines[index] = `${line.slice(0, marker.start)}${line.slice(marker.end)}`
    } else if (!unmute && !marker) {
      const prefix = line.match(/^(\s*(?:(?:[-*+]|\d+[.)])\s+|#{1,6}\s+)?)/u)?.[1] ?? ''
      lines[index] = `${prefix}%% ${line.slice(prefix.length)}`
    }
  })
  const changes: Array<{ from: number; to: number; insert: string }> = []
  let offset = 0
  originalLines.forEach((line, index) => {
    if (line !== lines[index] && index >= startLine && index <= endLine) changes.push({ from: offset, to: offset + line.length, insert: lines[index] })
    offset += line.length + 1
  })
  return { source: lines.join('\n'), muted: !unmute, changes }
}

function removeTagFromMarkerLine(line: string, kind: MarkerKind, tag: string) {
  const target = markerTagSpans(line).find((span) => span.kind === kind && span.tag === normalizeTag(tag))
  if (!target) return line
  const remaining = `${line.slice(0, target.start)}${line.slice(target.end)}`
  if (/^\s*<!--\s*-->\s*$/u.test(remaining)) return ''
  return remaining.replace(/<!--\s+/u, '<!-- ').replace(/\s+-->\s*$/u, ' -->')
}

export function removeTagAtPosition(source: string, lineIndex: number, tag: string) {
  const parsed = parseMarkdown(source)
  const range = parsed.ranges.filter((item) => item.tag === normalizeTag(tag) && item.startLine < lineIndex && lineIndex < item.endLine).sort((left, right) => right.startLine - left.startLine)[0]
  if (!range) return { source, error: `No active “${tag}” tag at this position.` }
  const lines = [...parsed.lines]
  lines[range.endLine] = removeTagFromMarkerLine(lines[range.endLine], 'close', tag)
  lines[range.startLine] = removeTagFromMarkerLine(lines[range.startLine], 'open', tag)
  if (!lines[range.endLine]) lines.splice(range.endLine, 1)
  if (!lines[range.startLine]) lines.splice(range.startLine, 1)
  return { source: lines.join('\n') }
}

export function normalizeRepeatedOpens(source: string) {
  const lines = source.split('\n')
  const active = new Set<string>()
  const output: string[] = []
  let changed = false

  for (const line of lines) {
    const match = line.match(MARKER_PATTERN)
    if (!match) {
      output.push(line)
      continue
    }
    const parsed = tokenizeTags(match[1].trim())
    if (parsed.malformed || !parsed.tags.length) {
      output.push(line)
      continue
    }
    const isClose = parsed.tags.every((tag) => tag.startsWith('/'))
    const tags = parsed.tags.map((tag) => tag.replace(/^\//u, ''))
    if (!isClose) {
      const repeated = tags.filter((tag) => active.has(tag))
      if (repeated.length) {
        output.push(formatMarker('close', repeated))
        repeated.forEach((tag) => active.delete(tag))
        changed = true
      }
      tags.forEach((tag) => active.add(tag))
    } else {
      tags.forEach((tag) => active.delete(tag))
    }
    output.push(line)
  }
  return { source: output.join('\n'), changed }
}

interface MarkerTagSpan {
  tag: string
  kind: MarkerKind
  start: number
  end: number
}

function markerTagSpans(line: string): MarkerTagSpan[] {
  const match = line.match(MARKER_PATTERN)
  if (!match) return []
  const markerStart = line.indexOf('<!--')
  const body = match[1]
  const tokens = /\/?(?:"(?:\\.|[^"])*"|\S+)/gu
  const spans: MarkerTagSpan[] = []
  let token: RegExpExecArray | null
  while ((token = tokens.exec(body))) {
    const raw = token[0]
    const kind: MarkerKind = raw.startsWith('/') ? 'close' : 'open'
    const value = raw.replace(/^\//u, '')
    const tag = value.startsWith('"') ? value.slice(1, -1).replaceAll('\\"', '"') : value
    spans.push({ tag: normalizeTag(tag), kind, start: markerStart + 4 + token.index, end: markerStart + 4 + token.index + raw.length })
  }
  return spans
}

function formatTagName(tag: string) {
  return tag.includes(' ') ? `"${tag.replaceAll('"', '\\"')}"` : tag
}

function replaceMarkerTag(line: string, span: MarkerTagSpan, newTag: string) {
  const replacement = `${span.kind === 'close' ? '/' : ''}${formatTagName(normalizeTag(newTag))}`
  return `${line.slice(0, span.start)}${replacement}${line.slice(span.end)}`
}

export function findMarkerTagRename(before: string, after: string) {
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  if (beforeLines.length !== afterLines.length) return undefined
  let candidate: { line: number; oldTag: string; newTag: string } | undefined

  for (let line = 0; line < beforeLines.length; line += 1) {
    if (beforeLines[line] === afterLines[line]) continue
    const previous = markerTagSpans(beforeLines[line])
    const current = markerTagSpans(afterLines[line])
    if (!previous.length || previous.length !== current.length) return undefined
    const changed = current.map((span, index) => span.kind === previous[index].kind && span.tag !== previous[index].tag ? index : -1).filter((index) => index >= 0)
    if (changed.length !== 1 || !current.every((span, index) => index === changed[0] || span.tag === previous[index].tag)) return undefined
    candidate = { line, oldTag: previous[changed[0]].tag, newTag: current[changed[0]].tag }
  }

  return candidate
}

export function renameMatchingTag(source: string, markerLine: number, oldTag: string, newTag: string) {
  const lines = source.split('\n')
  const marker = lines[markerLine]
  const changedSpan = markerTagSpans(marker).find((span) => span.tag === normalizeTag(newTag))
  if (!changedSpan) return source
  const targetKind: MarkerKind = changedSpan.kind === 'open' ? 'close' : 'open'
  let targetLine = -1

  if (changedSpan.kind === 'open') {
    for (let index = markerLine + 1; index < lines.length; index += 1) {
      if (markerTagSpans(lines[index]).some((span) => span.kind === 'close' && span.tag === normalizeTag(oldTag))) {
        targetLine = index
        break
      }
    }
  } else {
    for (let index = markerLine - 1; index >= 0; index -= 1) {
      if (markerTagSpans(lines[index]).some((span) => span.kind === 'open' && span.tag === normalizeTag(oldTag))) {
        targetLine = index
        break
      }
    }
  }

  if (targetLine < 0) return source
  const target = markerTagSpans(lines[targetLine]).find((span) => span.kind === targetKind && span.tag === normalizeTag(oldTag))
  if (!target) return source
  lines[targetLine] = replaceMarkerTag(lines[targetLine], target, newTag)
  return lines.join('\n')
}

export function renameTagEverywhere(source: string, oldTag: string, newTag: string) {
  const normalizedOldTag = normalizeTag(oldTag)
  const lines = source.split('\n')
  lines.forEach((line, lineIndex) => {
    const matches = markerTagSpans(line).filter((span) => span.tag === normalizedOldTag).sort((left, right) => right.start - left.start)
    matches.forEach((span) => { lines[lineIndex] = replaceMarkerTag(lines[lineIndex], span, newTag) })
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
