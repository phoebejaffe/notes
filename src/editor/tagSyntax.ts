import { parseMarkdown } from '../markerEngine'

function escapeAttribute(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
}

function isCommentMarker(line: string) {
  return /^\s*(?:%%\s+)?<!--[\s\S]*?-->\s*$/u.test(line)
}

export function commentsToTagDirectives(source: string) {
  const parsed = parseMarkdown(source)
  if (parsed.diagnostics.length || parsed.markers.some((marker) => !isCommentMarker(marker.raw))) return source
  const stack: string[] = []
  for (const marker of parsed.markers) {
    if (marker.kind === 'open') stack.push(...marker.tags)
    else {
      for (const tag of marker.tags) {
        if (stack.pop() !== tag) return source
      }
    }
  }
  if (stack.length) return source
  const markerByLine = new Map(parsed.markers.map((marker) => [marker.line, marker]))
  const lines = source.split('\n')
  const output: string[] = []

  lines.forEach((line, index) => {
    const marker = markerByLine.get(index)
    if (!marker || !isCommentMarker(line)) {
      output.push(line)
      return
    }
    if (marker.kind === 'open') {
      marker.tags.forEach((tag) => output.push(`:::tag{name="${escapeAttribute(tag)}"}`))
    } else {
      marker.tags.slice().reverse().forEach(() => output.push(':::'))
    }
  })

  return output.join('\n')
}
