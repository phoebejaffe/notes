import { diff3Merge, diffIndices, type IDiffIndicesResult, type MergeRegion } from 'node-diff3'

export type MarkdownMergeResult =
  | { status: 'clean'; markdown: string }
  | { status: 'conflict' }

// Splices pure insertions into `target` at positions mapped from base
// coordinates through targetDiffs, so an insertion anchored before a base
// line still lands before that line's replacement when target edited it.
function applyInsertions(
  target: string[],
  insertionDiffs: IDiffIndicesResult<string>[],
  targetDiffs: IDiffIndicesResult<string>[],
) {
  const result = [...target]
  let shift = 0
  insertionDiffs.forEach((insertion) => {
    const baseIndex = insertion.buffer1[0]
    let targetIndex = 0
    let cursor = 0
    let inside = false
    for (const diff of targetDiffs) {
      if (diff.buffer1[0] >= baseIndex) break
      targetIndex += diff.buffer1[0] - cursor
      if (diff.buffer1[1] > baseIndex) {
        inside = true
        break
      }
      targetIndex += diff.buffer2Content.length
      cursor = diff.buffer1[1]
    }
    if (!inside) targetIndex += Math.max(0, baseIndex - cursor)
    result.splice(Math.min(targetIndex + shift, result.length), 0, ...insertion.buffer2Content)
    shift += insertion.buffer2Content.length
  })
  return result
}

function resolveConflictRegion(conflict: NonNullable<MergeRegion<string>['conflict']>) {
  const localDiffs = diffIndices(conflict.o, conflict.a)
  const remoteDiffs = diffIndices(conflict.o, conflict.b)
  const remoteAdditionsOnly = remoteDiffs.every((diff) => diff.buffer1Content.length === 0)
  if (remoteAdditionsOnly) return applyInsertions(conflict.a, remoteDiffs, localDiffs)

  const localAdditionsOnly = localDiffs.every((diff) => diff.buffer1Content.length === 0)
  if (localAdditionsOnly) return applyInsertions(conflict.b, localDiffs, remoteDiffs)
  return undefined
}

export function mergeMarkdown(baseMarkdown: string, localMarkdown: string, remoteMarkdown: string): MarkdownMergeResult {
  if (localMarkdown === remoteMarkdown) return { status: 'clean', markdown: localMarkdown }
  if (localMarkdown === baseMarkdown) return { status: 'clean', markdown: remoteMarkdown }
  if (remoteMarkdown === baseMarkdown) return { status: 'clean', markdown: localMarkdown }

  const splitLines = (markdown: string) => (markdown === '' ? [] : markdown.split(/\r?\n/))
  const regions = diff3Merge(
    splitLines(localMarkdown),
    splitLines(baseMarkdown),
    splitLines(remoteMarkdown),
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
