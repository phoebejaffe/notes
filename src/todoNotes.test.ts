import { describe, expect, it } from 'vitest'
import type { NamedDocument } from './storage'
import { compareTodoNotes, isTodoNote } from './todoNotes'

function note(partial: Partial<NamedDocument>): NamedDocument {
  return { id: 'id', title: '', markdown: '', lane: 1, order: 0, collapsed: false, updatedAt: 0, ...partial }
}

describe('isTodoNote', () => {
  it('matches titles starting with todo, case-insensitive and trimmed', () => {
    expect(isTodoNote(note({ title: 'todo' }))).toBe(true)
    expect(isTodoNote(note({ title: 'Todo chores' }))).toBe(true)
    expect(isTodoNote(note({ title: '  TODO  ' }))).toBe(true)
    expect(isTodoNote(note({ title: 'todos' }))).toBe(true)
    expect(isTodoNote(note({ title: 'todo-work' }))).toBe(true)
  })

  it('rejects non-todo titles', () => {
    expect(isTodoNote(note({ title: 'my todo' }))).toBe(false)
    expect(isTodoNote(note({ title: 'a todo list' }))).toBe(false)
    expect(isTodoNote(note({ title: '' }))).toBe(false)
  })

  it('excludes tombstones', () => {
    expect(isTodoNote(note({ title: 'todo', deleted: true }))).toBe(false)
  })
})

describe('compareTodoNotes', () => {
  it('sorts alphabetically by title, case-insensitive', () => {
    const notes = [
      note({ id: 'c', title: 'todo work' }),
      note({ id: 'a', title: 'Todo' }),
      note({ id: 'b', title: 'todo chores' }),
    ]
    expect(notes.sort(compareTodoNotes).map((n) => n.title)).toEqual(['Todo', 'todo chores', 'todo work'])
  })
})
