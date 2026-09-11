import { describe, expect, it } from 'vitest'
import { preserveMarkerLines } from './markdownSourcePreservation'

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
