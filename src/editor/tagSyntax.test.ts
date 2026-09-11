import { describe, expect, it } from 'vitest'
import { commentsToTagDirectives } from './tagSyntax'

describe('tag syntax conversion', () => {
  it('converts nested comment tags to container directives', () => {
    const source = '<!-- therapy -->\ncontent\n<!-- private -->\nsecret\n<!-- /private -->\n<!-- /therapy -->'
    expect(commentsToTagDirectives(source)).toBe(':::tag{name="therapy"}\ncontent\n:::tag{name="private"}\nsecret\n:::\n:::')
  })

  it('leaves malformed comment tags unchanged', () => {
    const source = '<!-- therapy -->\ncontent'
    expect(commentsToTagDirectives(source)).toBe(source)
  })

  it('leaves crossing ranges unchanged for safe migration', () => {
    const source = '<!-- one two -->\ncontent\n<!-- /one -->\nmore\n<!-- /two -->'
    expect(commentsToTagDirectives(source)).toBe(source)
  })

  it('preserves tags containing spaces in directive attributes', () => {
    const source = '<!-- "spring launch" -->\ncontent\n<!-- /"spring launch" -->'
    expect(commentsToTagDirectives(source)).toBe(':::tag{name="spring launch"}\ncontent\n:::')
  })
})
