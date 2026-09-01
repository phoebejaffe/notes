import { describe, expect, it } from 'vitest'
import { addTagToRange, formatMarker, lineRangeForSelection, normalizeRepeatedOpens, parseMarkdown } from './markerEngine'

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
})
