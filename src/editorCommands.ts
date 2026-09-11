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
