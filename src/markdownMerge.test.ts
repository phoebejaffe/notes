import { describe, expect, it } from 'vitest'
import { mergeMarkdown } from './markdownMerge'

describe('mergeMarkdown', () => {
  it('merges a remote prepended transcription with a local edit elsewhere', () => {
    const base = 'first note\n\nolder note'
    const local = 'first note\n\nolder note edited locally'
    const remote = '💡 call the dentist\n\nfirst note\n\nolder note'

    expect(mergeMarkdown(base, local, remote)).toEqual({
      status: 'clean',
      markdown: '💡 call the dentist\n\nfirst note\n\nolder note edited locally',
    })
  })

  it('preserves a local deletion while remote prepends a task', () => {
    const base = '💡 old idea\n\nkeep this'
    const local = 'keep this'
    const remote = '- [ ] 💡 new task[ ](https://example.com/recording)\n💡 old idea\n\nkeep this'

    expect(mergeMarkdown(base, local, remote)).toEqual({
      status: 'clean',
      markdown: '- [ ] 💡 new task[ ](https://example.com/recording)\nkeep this',
    })
  })

  it('merges a local addition with a remote deletion in the same region', () => {
    const base = 'remove me\n\nkeep this'
    const local = 'local addition\n\nremove me\n\nkeep this'
    const remote = 'keep this'

    expect(mergeMarkdown(base, local, remote)).toEqual({
      status: 'clean',
      markdown: 'local addition\n\nkeep this',
    })
  })

  it('treats identical local and remote edits as a false conflict', () => {
    const base = 'before'
    const local = 'before\n\nsame addition'
    const remote = 'before\n\nsame addition'

    expect(mergeMarkdown(base, local, remote)).toEqual({ status: 'clean', markdown: remote })
  })

  it('reports a conflict when both sides change the same line differently', () => {
    expect(mergeMarkdown('shared line', 'local line', 'remote line')).toEqual({ status: 'conflict' })
  })

  it('merges an empty base with different local and remote additions', () => {
    expect(mergeMarkdown('', 'local note', '💡 remote transcription')).toEqual({
      status: 'clean',
      markdown: '💡 remote transcription\nlocal note',
    })
  })

  it('merges a remote prepend with a local edit to the first line', () => {
    const base = 'first note\n\nolder note'
    const local = 'first note edited\n\nolder note'
    const remote = '💡 call the dentist\n\nfirst note\n\nolder note'

    expect(mergeMarkdown(base, local, remote)).toEqual({
      status: 'clean',
      markdown: '💡 call the dentist\n\nfirst note edited\n\nolder note',
    })
  })

  it('keeps both sides when local and remote each prepend different lines', () => {
    const base = 'first note'
    const local = 'typed note\nfirst note'
    const remote = '💡 call the dentist\nfirst note'

    expect(mergeMarkdown(base, local, remote)).toEqual({
      status: 'clean',
      markdown: '💡 call the dentist\ntyped note\nfirst note',
    })
  })

  it('merges a remote append with a local edit to an earlier line', () => {
    const base = 'first note\n\nolder note'
    const local = 'first note edited\n\nolder note'
    const remote = 'first note\n\nolder note\n\n💡 late addition'

    expect(mergeMarkdown(base, local, remote)).toEqual({
      status: 'clean',
      markdown: 'first note edited\n\nolder note\n\n💡 late addition',
    })
  })

  it('accepts the remote document when local still matches base', () => {
    expect(mergeMarkdown('base', 'base', 'remote')).toEqual({ status: 'clean', markdown: 'remote' })
  })

  it('accepts the local document when remote still matches base', () => {
    expect(mergeMarkdown('base', 'local', 'base')).toEqual({ status: 'clean', markdown: 'local' })
  })
})
