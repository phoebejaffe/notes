function isMarkerLine(line: string) {
  return /^\s*(?:%%\s+)?<!--[\s\S]*-->\s*$/u.test(line)
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
    const insertionIndex = afterIndex >= 0 ? afterIndex : beforeIndex >= 0 ? beforeIndex + 1 : Math.min(index, nextLines.length)
    nextLines.splice(insertionIndex, 0, line)
    searchStart = insertionIndex + 1
  })

  return nextLines.join('\n')
}
