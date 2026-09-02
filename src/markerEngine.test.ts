import { describe, expect, it } from 'vitest'
import { addTagToRange, findMarkerTagRename, formatMarker, lineRangeForSelection, normalizeRepeatedOpens, parseMarkdown, removeTagAtPosition, renameMatchingTag, renameTagEverywhere } from './markerEngine'

describe('marker engine', () => {
  it('parses independent crossing spans and emoji tags', () => {
    const source = ['<!-- therapy 🧠 -->', 'session', '<!-- /therapy -->', '<!-- 👩‍⚕️ -->', 'follow up', '<!-- /🧠 /👩‍⚕️ -->'].join('\n')
    const parsed = parseMarkdown(source)
    expect(parsed.diagnostics).toEqual([])
    expect(parsed.ranges.map(({ tag }) => tag)).toEqual(['therapy', '🧠', '👩‍⚕️'])
    expect(parsed.ranges[1]).toMatchObject({ startLine: 0, endLine: 5 })
  })

  it('supports quoted tag names and keeps marker lines intact', () => {
    const marker = formatMarker('open', ['mental health', '🧠'])
    expect(marker).toBe('<!-- "mental health" 🧠 -->')
    expect(parseMarkdown(`${marker}\nnotes\n<!-- /"mental health" /🧠 -->`).ranges).toHaveLength(2)
  })

  it('rejects mixed operations on one marker line', () => {
    const parsed = parseMarkdown('<!-- therapy /work -->\nnote')
    expect(parsed.diagnostics[0].message).toContain('separate lines')
  })

  it('normalizes a repeated opening without deleting text', () => {
    const source = '<!-- therapy -->\none\n<!-- therapy -->\ntwo'
    const result = normalizeRepeatedOpens(source)
    expect(result.changed).toBe(true)
    expect(result.source).toBe('<!-- therapy -->\none\n<!-- /therapy -->\n<!-- therapy -->\ntwo')
  })

  it('expands a partial selection to complete lines', () => {
    const source = 'first\nsecond\nthird'
    expect(lineRangeForSelection(source, 8, 14)).toEqual({ startLine: 1, endLine: 2 })
  })

  it('adds separate opening and closing marker lines', () => {
    const result = addTagToRange('one\ntwo\nthree', 1, 1, 'therapy')
    expect(result.source).toBe('one\n<!-- therapy -->\ntwo\n<!-- /therapy -->\nthree')
  })

  it('renames the matching close when a rendered opening chip changes', () => {
    const before = '<!-- therapy -->\nnote\n<!-- /therapy -->'
    const after = '<!-- wellness -->\nnote\n<!-- /therapy -->'
    expect(findMarkerTagRename(before, after)).toEqual({ line: 0, oldTag: 'therapy', newTag: 'wellness' })
    expect(renameMatchingTag(after, 0, 'therapy', 'wellness')).toBe('<!-- wellness -->\nnote\n<!-- /wellness -->')
  })

  it('removes an active tag and both marker lines without deleting note text', () => {
    const source = '<!-- therapy -->\nprivate note\n<!-- /therapy -->'
    expect(removeTagAtPosition(source, 1, 'therapy').source).toBe('private note')
  })

  it('does not interpret inserted nested markers as a tag rename', () => {
    const before = '<!-- therapy -->\nprivate note\n<!-- /therapy -->'
    const after = addTagToRange(before, 1, 1, 'meeting').source
    expect(findMarkerTagRename(before, after)).toBeUndefined()
    expect(after).toContain('<!-- therapy -->')
    expect(after).toContain('<!-- meeting -->')
  })

  it('renames every matching marker while preserving quoted names', () => {
    const source = '<!-- therapy -->\none\n<!-- /therapy -->\n<!-- "therapy notes" therapy -->\ntwo\n<!-- /therapy /"therapy notes" -->'
    expect(renameTagEverywhere(source, 'therapy', 'wellness')).toBe('<!-- wellness -->\none\n<!-- /wellness -->\n<!-- "therapy notes" wellness -->\ntwo\n<!-- /wellness /"therapy notes" -->')
  })
})
