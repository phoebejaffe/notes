import { describe, expect, it } from 'vitest'
import { adjacentBlockIndex } from './editorNavigation'

describe('editor boundary navigation', () => {
  it('moves through untagged and tagged blocks in document order', () => {
    expect(adjacentBlockIndex('ArrowDown', 0, 4, 12, 12)).toBe(1)
    expect(adjacentBlockIndex('ArrowDown', 1, 4, 12, 12)).toBe(2)
    expect(adjacentBlockIndex('ArrowDown', 2, 4, 12, 12)).toBe(3)
  })

  it('moves backward through the same sequence', () => {
    expect(adjacentBlockIndex('ArrowUp', 3, 4, 0, 12)).toBe(2)
    expect(adjacentBlockIndex('ArrowUp', 2, 4, 0, 12)).toBe(1)
    expect(adjacentBlockIndex('ArrowUp', 1, 4, 0, 12)).toBe(0)
  })

  it('does not move while the caret is inside a block', () => {
    expect(adjacentBlockIndex('ArrowDown', 0, 4, 4, 12)).toBeUndefined()
    expect(adjacentBlockIndex('ArrowUp', 1, 4, 4, 12)).toBeUndefined()
  })
})
