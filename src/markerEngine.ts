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

export function lineRangeForSelection(source: string, from: number, to: number) {
  const before = source.slice(0, from)
  const selected = source.slice(from, to)
  const startLine = before.split('\n').length - 1
  const endLine = startLine + selected.split('\n').length - 1
  return { startLine, endLine }
}
