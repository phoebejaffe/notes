import { describe, expect, it } from 'vitest'
import { addTagToRange, checklistToPlainText, findMarkerTagRename, formatMarker, lineRangeForSelection, markdownMarkState, moveLines, normalizeRepeatedOpens, parseMarkdown, isMutedLine, preserveMutedLines, removeChecklist, removeTagAtPosition, renameMatchingTag, renameTagEverywhere, sourceMatchesFilter, toggleChecklist, toggleMutedLines } from './markerEngine'

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

  it('wraps every line in a multi-line tag selection', () => {
    const result = addTagToRange('one\ntwo\nthree\nafter', 0, 2, 'therapy')
    expect(result.source).toBe('<!-- therapy -->\none\ntwo\nthree\n<!-- /therapy -->\nafter')
  })

  it('matches one-word tags when filtering a tagged range', () => {
    const source = '<!-- work -->\n\n<!-- /work -->'
    expect(sourceMatchesFilter(source, ['work'], false)).toBe(true)
    expect(sourceMatchesFilter(source, ['other'], false)).toBe(false)
  })

  it('parses muted tag marker lines without changing their muted state', () => {
    const source = '%% <!-- foo -->\n%% escalation of privilege\n%% <!-- /foo -->\n%% boo\n%% '
    const parsed = parseMarkdown(source)
    expect(parsed.markers.map(({ kind, tags }) => ({ kind, tags }))).toEqual([
      { kind: 'open', tags: ['foo'] },
      { kind: 'close', tags: ['foo'] },
    ])
    expect(parsed.ranges).toEqual([{ tag: 'foo', startLine: 0, endLine: 2, start: 0, end: 43 }])
    expect(parsed.lines.every(isMutedLine)).toBe(true)
  })

  it('parses nested tag directives', () => {
    const source = ':::tag{name="therapy"}\ncontent\n:::tag{name="private"}\nsecret\n:::\n:::'
    const parsed = parseMarkdown(source)
    expect(parsed.diagnostics).toEqual([])
    expect(parsed.ranges.map(({ tag, startLine, endLine }) => ({ tag, startLine, endLine }))).toEqual([
      { tag: 'private', startLine: 2, endLine: 4 },
      { tag: 'therapy', startLine: 0, endLine: 5 },
    ])
  })

  it('parses directive tag names containing spaces', () => {
    const parsed = parseMarkdown(':::tag{name="spring launch"}\ncontent\n:::')
    expect(parsed.diagnostics).toEqual([])
    expect(parsed.ranges[0].tag).toBe('spring launch')
  })

  it('detects bold, italic, and combined asterisk marks', () => {
    expect(markdownMarkState('**bold**', 2, 6)).toEqual({ bold: true, italic: false, strikethrough: false })
    expect(markdownMarkState('*italic*', 1, 7)).toEqual({ bold: false, italic: true, strikethrough: false })
    expect(markdownMarkState('***both***', 3, 7)).toEqual({ bold: true, italic: true, strikethrough: false })
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

  it('mutes and unmutes plain, list, and heading lines', () => {
    const source = 'plain\n  indented\n- grocery item\n## heading'
    const muted = toggleMutedLines(source, 0, 3)
    expect(muted.source).toBe('%% plain\n  %% indented\n- %% grocery item\n## %% heading')
    expect(isMutedLine(muted.source.split('\n')[2])).toBe(true)
    expect(toggleMutedLines(muted.source, 0, 3).source).toBe(source)
  })

  it('preserves muted lines when the rich editor reserializes surrounding Markdown', () => {
    const previous = 'prefix\n%% plain target\n%% already muted\n- %% list target\n## %% heading target\nsuffix'
    const next = 'prefix\nplain target\nalready muted\n* list target\n## heading target\nsuffix'
    expect(preserveMutedLines(previous, next)).toBe('prefix\n%% plain target\n%% already muted\n* %% list target\n## %% heading target\nsuffix')
  })

  it('mutes every line in a mixed selection without double-muting existing lines', () => {
    const source = 'plain\n%% already muted\n- list item\n## heading'
    const result = toggleMutedLines(source, 0, 3)
    expect(result.source).toBe('%% plain\n%% already muted\n- %% list item\n## %% heading')
    expect(result.source.split('\n').filter((line) => line.includes('%%')).every((line) => !line.includes('%%%%'))).toBe(true)
    expect(toggleMutedLines(result.source, 0, 3).source).toBe('plain\nalready muted\n- list item\n## heading')
  })

  it('unmutes a selection only when every selected line is muted', () => {
    const source = '%% plain\n- %% list item\n## %% heading'
    expect(toggleMutedLines(source, 0, 2).source).toBe('plain\n- list item\n## heading')
  })

  it('mutes a line containing a Markdown link without changing its content', () => {
    const source = '[💡](https://example.com/recording) Transcribe with a better voice model.'
    expect(toggleMutedLines(source, 0, 0).source).toBe('%% [💡](https://example.com/recording) Transcribe with a better voice model.')
  })

  it('toggles checklist items and promotes other lines to tasks', () => {
    expect(toggleChecklist('- one\n- [ ] two\n- [x] three', 0)).toBe('- [ ] one\n- [ ] two\n- [x] three')
    expect(toggleChecklist('- one\n- [ ] two\n- [x] three', 1)).toBe('- one\n- [x] two\n- [x] three')
    expect(toggleChecklist('- one\n- [ ] two\n- [x] three', 2)).toBe('- one\n- [ ] two\n- [ ] three')
    expect(toggleChecklist('plain', 0)).toBe('- [ ] plain')
    expect(toggleChecklist('  indented', 0)).toBe('  - [ ] indented')
    expect(toggleChecklist('1. ordered', 0)).toBe('1. [ ] ordered')
  })

  it('keeps the muted marker when promoting muted lines to tasks', () => {
    expect(toggleChecklist('%% muted', 0)).toBe('- %% [ ] muted')
    expect(toggleChecklist('- %% muted item', 0)).toBe('- %% [ ] muted item')
    expect(toggleChecklist('- %% [ ] muted task', 0)).toBe('- %% [x] muted task')
    expect(toggleMutedLines('- %% [x] muted task', 0, 0).source).toBe('- [x] muted task')
  })

  it('removes checklist markers and leaves plain list items', () => {
    const source = '- [ ] one\n- [x] two\n- three\nplain'
    expect(removeChecklist(source, 0)).toBe('- one\n- [x] two\n- three\nplain')
    expect(removeChecklist(source, 1)).toBe('- [ ] one\n- two\n- three\nplain')
    expect(removeChecklist(source, 2)).toBe(source)
    expect(removeChecklist(source, 3)).toBe(source)
    expect(removeChecklist('- %% [x] muted', 0)).toBe('- %% muted')
    expect(removeChecklist('- [ ]', 0)).toBe('-')
  })

  it('converts checklist and list lines to plain text', () => {
    const source = '- [ ] one\n- [x] two\n- three\nplain'
    expect(checklistToPlainText(source, 0)).toBe('one\n- [x] two\n- three\nplain')
    expect(checklistToPlainText(source, 1)).toBe('- [ ] one\ntwo\n- three\nplain')
    expect(checklistToPlainText(source, 2)).toBe('- [ ] one\n- [x] two\nthree\nplain')
    expect(checklistToPlainText(source, 3)).toBe(source)
    expect(checklistToPlainText('  - [x] indented', 0)).toBe('  indented')
    expect(checklistToPlainText('1. [x] ordered', 0)).toBe('ordered')
    expect(checklistToPlainText('- %% [x] muted', 0)).toBe('%% muted')
    expect(checklistToPlainText('- %% muted item', 0)).toBe('%% muted item')
    expect(checklistToPlainText('- [ ]', 0)).toBe('')
  })

  it('moves selected lines up and down without changing their content', () => {
    expect(moveLines('one\ntwo\nthree\nfour', 1, 2, 'up')).toBe('two\nthree\none\nfour')
    expect(moveLines('one\ntwo\nthree\nfour', 1, 2, 'down')).toBe('one\nfour\ntwo\nthree')
    expect(moveLines('one\ntwo', 0, 0, 'up')).toBe('one\ntwo')
    expect(moveLines('one\ntwo', 1, 1, 'down')).toBe('one\ntwo')
  })

  it('moves hard-break paragraphs while leaving separator lines in place', () => {
    const source = 'Line A\n\nLine B\n\nLine C'
    expect(moveLines(source, 2, 2, 'up')).toBe('Line B\n\nLine A\n\nLine C')
    expect(moveLines(source, 2, 2, 'down')).toBe('Line A\n\nLine C\n\nLine B')
  })

  it('moves a tagged repeated-list fixture one source line at a time', () => {
    const source = 'Line above\n\n:::tag{name="brainstorm"}\nQuestions for Lyle\n- Line A\n- Line B\n- Line C\n:::\n\nLater list\n- Line D\n- Line E\n- Line F\n\nLine below'
    expect(moveLines(source, 5, 5, 'up')).toContain('Questions for Lyle\n- Line B\n- Line A\n- Line C')
    expect(moveLines(source, 11, 11, 'up')).toContain('Later list\n- Line E\n- Line D\n- Line F')
  })

  it('moves content inside a tagged segment without crossing its boundaries', () => {
    const source = 'Line above\n\n:::tag{name="brainstorm"}\nQuestions for Lyle\n- Line A\n- Line B\n- Line C\n:::\n\nLine below'
    expect(moveLines(source, 5, 5, 'up')).toBe('Line above\n\n:::tag{name="brainstorm"}\nQuestions for Lyle\n- Line B\n- Line A\n- Line C\n:::\n\nLine below')
    expect(moveLines(source, 5, 5, 'down')).toBe('Line above\n\n:::tag{name="brainstorm"}\nQuestions for Lyle\n- Line A\n- Line C\n- Line B\n:::\n\nLine below')
  })

  it('moves nested list lines without changing indentation or neighboring text', () => {
    const source = 'before\n- parent one\n  - child one\n  - child two\n- parent two\nafter'
    expect(moveLines(source, 2, 2, 'down')).toBe('before\n- parent one\n  - child two\n  - child one\n- parent two\nafter')
    expect(moveLines(source, 1, 3, 'down')).toBe('before\n- parent two\n- parent one\n  - child one\n  - child two\nafter')
  })

  it('keeps text outside a tagged line range unchanged', () => {
    const source = 'before\nfirst\nsecond\nafter'
    expect(addTagToRange(source, 1, 2, 'therapy').source).toBe('before\n<!-- therapy -->\nfirst\nsecond\n<!-- /therapy -->\nafter')
  })

  it('recognizes muted markers after list and heading prefixes', () => {
    expect(['%% plain', '- %% bullet', '  1. %% nested', '## %% heading'].every(isMutedLine)).toBe(true)
  })

  it('renames every matching marker while preserving quoted names', () => {
    const source = '<!-- therapy -->\none\n<!-- /therapy -->\n<!-- "therapy notes" therapy -->\ntwo\n<!-- /therapy /"therapy notes" -->'
    expect(renameTagEverywhere(source, 'therapy', 'wellness')).toBe('<!-- wellness -->\none\n<!-- /wellness -->\n<!-- "therapy notes" wellness -->\ntwo\n<!-- /wellness /"therapy notes" -->')
  })
})
