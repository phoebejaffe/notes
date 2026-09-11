export function adjacentBlockIndex(key: string, currentIndex: number, blockCount: number, caretOffset: number, textLength: number) {
  const forward = key === 'ArrowDown' || key === 'ArrowRight'
  const backward = key === 'ArrowUp' || key === 'ArrowLeft'
  if (!forward && !backward) return undefined
  const atBoundary = forward ? caretOffset >= textLength : caretOffset === 0
  if (!atBoundary) return undefined
  const nextIndex = currentIndex + (forward ? 1 : -1)
  return nextIndex >= 0 && nextIndex < blockCount ? nextIndex : undefined
}
