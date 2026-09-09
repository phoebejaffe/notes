export type ListKind = 'bullet' | 'number' | 'task'

function linePrefix(line: string) {
  return line.match(/^\s*/u)?.[0] ?? ''
}

export function toggleList(source: string, startLine: number, endLine: number, kind: ListKind) {
  const lines = source.split('\n')
  const selected = lines.slice(startLine, endLine + 1)
  const patterns = {
    bullet: /^\s*[-*+]\s+/u,
    number: /^\s*\d+[.)]\s+/u,
    task: /^\s*[-*+]\s+\[[ xX]\]\s+/u,
  }
  const pattern = patterns[kind]
  const allActive = selected.length > 0 && selected.every((line) => pattern.test(line))
  lines.slice(startLine, endLine + 1).forEach((line, offset) => {
    const index = startLine + offset
    const prefix = linePrefix(line)
    if (allActive) {
      if (kind === 'task') lines[index] = line.replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+/u, '$1')
      else lines[index] = line.replace(kind === 'bullet' ? /^(\s*)[-*+]\s+/u : /^(\s*)\d+[.)]\s+/u, '$1')
      return
    }
    const content = line.slice(prefix.length).replace(/^(?:[-*+]\s+|\d+[.)]\s+|[-*+]\s+\[[ xX]\]\s+)/u, '')
    const marker = kind === 'bullet' ? '- ' : kind === 'number' ? `${offset + 1}. ` : '- [ ] '
    lines[index] = `${prefix}${marker}${content}`
  })
  return lines.join('\n')
}

export function toggleIndent(source: string, startLine: number, endLine: number, amount = 2) {
  const lines = source.split('\n')
  for (let index = startLine; index <= endLine; index += 1) lines[index] = `${' '.repeat(amount)}${lines[index] ?? ''}`
  return lines.join('\n')
}

export function toggleUnindent(source: string, startLine: number, endLine: number, amount = 2) {
  const lines = source.split('\n')
  for (let index = startLine; index <= endLine; index += 1) lines[index] = (lines[index] ?? '').replace(new RegExp(`^ {1,${amount}}`), '')
  return lines.join('\n')
}

export interface DiffRow { kind: 'same' | 'added' | 'removed'; text: string; index: number }

export function diffLines(left: string, right: string): DiffRow[] {
  const a = left.split('\n')
  const b = right.split('\n')
  const rows: DiffRow[] = []
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < a.length || rightIndex < b.length) {
    if (a[leftIndex] === b[rightIndex]) {
      rows.push({ kind: 'same', text: a[leftIndex] ?? '', index: rows.length })
      leftIndex += 1
      rightIndex += 1
    } else if (rightIndex >= b.length || (leftIndex + 1 < a.length && a[leftIndex + 1] === b[rightIndex])) {
      rows.push({ kind: 'removed', text: a[leftIndex] ?? '', index: rows.length })
      leftIndex += 1
    } else if (leftIndex >= a.length) {
      rows.push({ kind: 'added', text: b[rightIndex] ?? '', index: rows.length })
      rightIndex += 1
    } else {
      rows.push({ kind: 'removed', text: a[leftIndex] ?? '', index: rows.length })
      rows.push({ kind: 'added', text: b[rightIndex] ?? '', index: rows.length })
      leftIndex += 1
      rightIndex += 1
    }
  }
  return rows
}
