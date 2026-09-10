import { describe, expect, it } from 'vitest'
import { continueTaskList, diffLines, toggleIndent, toggleList, toggleUnindent } from './editorCommands'

describe('editor commands', () => {
  it('toggles Markdown lists', () => {
    expect(toggleList('one\ntwo', 0, 1, 'bullet')).toBe('- one\n- two')
    expect(toggleList('- one\n- two', 0, 1, 'bullet')).toBe('one\ntwo')
    expect(toggleList('one', 0, 0, 'task')).toBe('- [ ] one')
  })

  it('indents and unindents selected lines', () => {
    expect(toggleUnindent(toggleIndent('one\ntwo', 0, 1), 0, 1)).toBe('one\ntwo')
  })

  it('continues checklist items on Enter', () => {
    const source = '- [ ] first'
    expect(continueTaskList(source, source.length)).toEqual({ source: '- [ ] first\n- [ ] ', cursor: 18 })
    expect(continueTaskList('plain text', 10)).toBeUndefined()
  })

  it('returns changed diff rows', () => {
    expect(diffLines('one\ntwo', 'one\nthree')).toEqual([
      { kind: 'same', text: 'one', index: 0 },
      { kind: 'removed', text: 'two', index: 1 },
      { kind: 'added', text: 'three', index: 2 },
    ])
  })
})
