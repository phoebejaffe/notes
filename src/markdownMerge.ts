import { diff3Merge, diffIndices, type IDiffIndicesResult, type MergeRegion } from 'node-diff3'

export type MarkdownMergeResult =
  | { status: 'clean'; markdown: string }
  | { status: 'conflict' }

function combineAdditionsAndDeletions(
  base: string[],
  additionDiffs: IDiffIndicesResult<string>[],
  deletionDiffs: IDiffIndicesResult<string>[],
) {
  const deleted = new Set<number>()
  deletionDiffs.forEach((diff) => {
    for (let index = diff.buffer1[0]; index < diff.buffer1[1]; index += 1) deleted.add(index)
  })
  const insertions = new Map<number, string[]>()
  additionDiffs.forEach((diff) => {
    const index = diff.buffer1[0]
    insertions.set(index, [...(insertions.get(index) ?? []), ...diff.buffer2Content])
  })

  const result: string[] = []
  for (let index = 0; index <= base.length; index += 1) {
    result.push(...(insertions.get(index) ?? []))
    if (index < base.length && !deleted.has(index)) result.push(base[index])
  }
  return result
}

function resolveConflictRegion(conflict: NonNullable<MergeRegion<string>['conflict']>) {
  const localDiffs = diffIndices(conflict.o, conflict.a)
  const remoteDiffs = diffIndices(conflict.o, conflict.b)
  const localDeletionsOnly = localDiffs.every((diff) => diff.buffer2Content.length === 0)
  const remoteAdditionsOnly = remoteDiffs.every((diff) => diff.buffer1Content.length === 0)
  if (localDeletionsOnly && remoteAdditionsOnly) return combineAdditionsAndDeletions(conflict.o, remoteDiffs, localDiffs)

  const localAdditionsOnly = localDiffs.every((diff) => diff.buffer1Content.length === 0)
  const remoteDeletionsOnly = remoteDiffs.every((diff) => diff.buffer2Content.length === 0)
  if (localAdditionsOnly && remoteDeletionsOnly) return combineAdditionsAndDeletions(conflict.o, localDiffs, remoteDiffs)
  return undefined
}

export function mergeMarkdown(baseMarkdown: string, localMarkdown: string, remoteMarkdown: string): MarkdownMergeResult {
  if (localMarkdown === remoteMarkdown) return { status: 'clean', markdown: localMarkdown }
  if (localMarkdown === baseMarkdown) return { status: 'clean', markdown: remoteMarkdown }
  if (remoteMarkdown === baseMarkdown) return { status: 'clean', markdown: localMarkdown }

  const regions = diff3Merge(
    localMarkdown.split(/\r?\n/),
    baseMarkdown.split(/\r?\n/),
    remoteMarkdown.split(/\r?\n/),
    { excludeFalseConflicts: true },
  )
  const merged: string[] = []
  for (const region of regions) {
    if (region.ok) {
      merged.push(...region.ok)
      continue
    }
    if (!region.conflict) return { status: 'conflict' }
    const resolved = resolveConflictRegion(region.conflict)
    if (!resolved) return { status: 'conflict' }
    merged.push(...resolved)
  }
  return { status: 'clean', markdown: merged.join('\n') }
}
