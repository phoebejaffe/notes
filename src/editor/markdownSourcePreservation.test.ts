import { describe, expect, it } from 'vitest'
import { comparableLineText, preserveMarkerLines, sourceLineForRenderedText } from './markdownSourcePreservation'
import { sourceLineRangeForRenderedSelection } from './markdownSourcePreservation'

describe('Markdown source preservation', () => {
  it('keeps application marker lines when the rich editor omits comments', () => {
    const previous = '<!-- therapy -->\nprivate note\n<!-- /therapy -->'
    expect(preserveMarkerLines(previous, 'private note edited')).toBe('<!-- therapy -->\nprivate note edited\n<!-- /therapy -->')
  })

  it('does not duplicate comments already emitted by the editor', () => {
    const source = '<!-- therapy -->\nnote\n<!-- /therapy -->'
    expect(preserveMarkerLines(source, source)).toBe(source)
  })

  it('keeps a newly inserted trailing line inside a closing tag', () => {
    const previous = '<!-- therapy -->\nlast line\n<!-- /therapy -->'
    expect(preserveMarkerLines(previous, 'last line\n')).toBe('<!-- therapy -->\nlast line\n\n<!-- /therapy -->')
  })
})

describe('Rendered text to source line matching', () => {
  it('matches a rendered line back to its plain source line', () => {
    expect(sourceLineForRenderedText('first\nsecond line\nthird', 'second line')).toBe(1)
  })

  it('matches a rendered line whose source is a Markdown link', () => {
    const source = '[💡](https://us-central1-pebble-ring-sync-20260911.cloudfunctions.net/recordingAudio?id=1b043d673ce2b8cc3a9bcd133823ca59&t=7PTRd5wANKZwUrA9t-PtC8c0HaBxM1ER6Aj98vM2j5g) Transcribe with a better voice model.'
    expect(sourceLineForRenderedText(source, '💡 Transcribe with a better voice model.')).toBe(0)
  })
  it('maps a multi-line rendered selection to its full source line range', () => {
    const source = '- first line\n- second line\n- third line\nafter'
    expect(sourceLineRangeForRenderedSelection(source, 'first line\nsecond line\nthird line')).toEqual({ startLine: 0, endLine: 2 })
    expect(sourceLineRangeForRenderedSelection('first\nunrelated\nsecond\nthird', 'first second third')).toBeUndefined()
  })
    expect(sourceLineRangeForRenderedSelection('not brought that to him,  \nyou ok not sprintibng and what covid test', 'not brought that to him, you ok not sprintibng and what covid test')).toEqual({ startLine: 0, endLine: 1 })

  it('matches a muted line whose source is a Markdown link', () => {
    const source = '%% [💡](https://example.com/recording) Transcribe with a better voice model.'
    expect(sourceLineForRenderedText(source, '%% 💡 Transcribe with a better voice model.')).toBe(0)
  })

  it('reduces images to their alt text', () => {
    expect(comparableLineText('![diagram](https://example.com/a.png) after')).toBe('diagram after')
  })

  it('strips list, heading, and emphasis markers', () => {
    expect(comparableLineText('- [ ] **buy** _milk_')).toBe('buy milk')
  })
})
