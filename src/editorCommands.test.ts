import { describe, expect, it } from 'vitest'
import { diffLines } from './editorCommands'

describe('editor commands', () => {
  it('returns changed diff rows', () => {
    expect(diffLines('one\ntwo', 'one\nthree')).toEqual([
      { kind: 'same', text: 'one', index: 0 },
      { kind: 'removed', text: 'two', index: 1 },
      { kind: 'added', text: 'three', index: 2 },
    ])
  })
})
