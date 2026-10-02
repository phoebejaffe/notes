import { describe, expect, it } from 'vitest'
import { addTagDirectiveToRange, checklistToPlainText, extractLinesForMove, indentLines, lineRangeForSelection, markdownMarkState, moveLines, parseMarkdown, isMutedLine, preserveMutedLines, removeChecklist, removeTagAtPosition, renameTagEverywhere, sourceMatchesFilter, stripMutedMarkers, toggleChecklist, toggleMutedLines } from './markerEngine'

describe('marker engine', () => {
  it('parses nested tag directives including emoji names', () => {
    const source = ['::::tag{name="therapy 🧠"}', 'session', ':::tag{name="👩‍⚕️"}', 'follow up', ':::', '::::'].join('\n')
    const parsed = parseMarkdown(source)
    expect(parsed.diagnostics).toEqual([])
    expect(parsed.ranges.map(({ tag }) => tag)).toEqual(['👩‍⚕️', 'therapy 🧠'])
    expect(parsed.ranges[1]).toMatchObject({ startLine: 0, endLine: 5 })
  })

  it('parses quoted directive tag names', () => {
    const parsed = parseMarkdown(':::tag{name="mental health"}\nnotes\n:::')
    expect(parsed.diagnostics).toEqual([])
    expect(parsed.ranges.map(({ tag }) => tag)).toEqual(['mental health'])
  })

  it('round-trips tag names containing quotes and ampersands', () => {
    const tagged = addTagDirectiveToRange('note', 0, 0, 'a"b & c').source
    expect(tagged).toBe(':::tag{name="a&quot;b &amp; c"}\nnote\n:::')
    expect(parseMarkdown(tagged).ranges[0].tag).toBe('a"b & c')
  })

  it('reports directives without a name and closes without opens', () => {
    const unnamed = parseMarkdown(':::tag{}\nnote\n:::')
    expect(unnamed.diagnostics[0].message).toContain('name attribute')
    const orphan = parseMarkdown('note\n:::')
    expect(orphan.diagnostics[0].message).toContain('without a matching open')
    const unclosed = parseMarkdown(':::tag{name="work"}\nnote')
    expect(unclosed.diagnostics[0].message).toContain('still open')
  })

  it('expands a partial selection to complete lines', () => {
    const source = 'first\nsecond\nthird'
    expect(lineRangeForSelection(source, 8, 14)).toEqual({ startLine: 1, endLine: 2 })
  })

  it('adds separate opening and closing directive lines', () => {
    const result = addTagDirectiveToRange('one\ntwo\nthree', 1, 1, 'therapy')
    expect(result.source).toBe('one\n:::tag{name="therapy"}\ntwo\n:::\nthree')
  })

  it('wraps every line in a multi-line tag selection', () => {
    const result = addTagDirectiveToRange('one\ntwo\nthree\nafter', 0, 2, 'therapy')
    expect(result.source).toBe(':::tag{name="therapy"}\none\ntwo\nthree\n:::\nafter')
  })

  it('matches one-word tags when filtering a tagged range', () => {
    const source = ':::tag{name="work"}\n\n:::'
    expect(sourceMatchesFilter(source, ['work'], false)).toBe(true)
    expect(sourceMatchesFilter(source, ['other'], false)).toBe(false)
  })

  it('parses nested tag directives with longer outer fences', () => {
    const source = '::::tag{name="therapy"}\ncontent\n:::tag{name="private"}\nsecret\n:::\n::::'
    const parsed = parseMarkdown(source)
    expect(parsed.diagnostics).toEqual([])
    expect(parsed.ranges.map(({ tag, startLine, endLine }) => ({ tag, startLine, endLine }))).toEqual([
      { tag: 'private', startLine: 2, endLine: 4 },
      { tag: 'therapy', startLine: 0, endLine: 5 },
    ])
  })

  it('still parses same-length nested directives as nested ranges', () => {
    // lenient stack parsing — micromark needs longer outer fences to render
    // nesting, but app-level tooling accepts the plain form too.
    const parsed = parseMarkdown(':::tag{name="a"}\n:::tag{name="b"}\nx\n:::\n:::')
    expect(parsed.ranges.map(({ tag }) => tag)).toEqual(['b', 'a'])
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

  it('removes an active tag directive without deleting note text', () => {
    const source = ':::tag{name="therapy"}\nprivate note\n:::'
    expect(removeTagAtPosition(source, 1, 'therapy').source).toBe('private note')
  })

  it('removes only the innermost matching tag when nested', () => {
    const source = '::::tag{name="therapy"}\n:::tag{name="private"}\nsecret\n:::\n::::'
    expect(removeTagAtPosition(source, 2, 'private').source).toBe('::::tag{name="therapy"}\nsecret\n::::')
    expect(removeTagAtPosition(source, 2, 'therapy').source).toBe(':::tag{name="private"}\nsecret\n:::')
  })

  it('mutes and unmutes plain, list, and heading lines with a trailing marker', () => {
    const source = 'plain\n  indented\n- grocery item\n## heading'
    const muted = toggleMutedLines(source, 0, 3)
    expect(muted.source).toBe('plain %%\n  indented %%\n- grocery item %%\n## heading %%')
    expect(isMutedLine(muted.source.split('\n')[2])).toBe(true)
    expect(toggleMutedLines(muted.source, 0, 3).source).toBe(source)
  })

  it('recognizes muted markers anywhere in a line', () => {
    expect(['%% plain', '- %% bullet', '  1. %% nested', '## %% heading', 'plain %%', 'a %% b', 'a%%b'].every(isMutedLine)).toBe(true)
    expect(['plain', '- bullet', '% single', '%percent%% word'].map(isMutedLine)).toEqual([false, false, false, true])
  })

  it('strips muted markers wherever they sit', () => {
    expect(stripMutedMarkers('foo %%')).toBe('foo')
    expect(stripMutedMarkers('%% foo')).toBe('foo')
    expect(stripMutedMarkers(' %% foo')).toBe('foo')
    expect(stripMutedMarkers('foo %% bar')).toBe('foo bar')
    expect(stripMutedMarkers('- %% item')).toBe('- item')
    expect(stripMutedMarkers('  - item %%')).toBe('  - item')
    expect(stripMutedMarkers('## %% heading')).toBe('## heading')
    expect(stripMutedMarkers('%%')).toBe('')
  })

  it('preserves muted lines when the rich editor reserializes surrounding Markdown', () => {
    const previous = 'prefix\n%% plain target\n%% already muted\n- %% list target\n## %% heading target\nsuffix'
    const next = 'prefix\nplain target\nalready muted\n* list target\n## heading target\nsuffix'
    expect(preserveMutedLines(previous, next)).toBe('prefix\nplain target %%\nalready muted %%\n* list target %%\n## heading target %%\nsuffix')
  })

  it('keeps lines muted when their text is edited in the rich editor', () => {
    // The marker is hidden in the editor, so an edit exports unmarked text on
    // the same line — the mute must survive.
    expect(preserveMutedLines('foo %%\nbar', 'foo extended\nbar')).toBe('foo extended %%\nbar')
    expect(preserveMutedLines('a\nb %%', 'inserted\na\nb')).toBe('inserted\na\nb %%')
    expect(preserveMutedLines('a\na %%', 'a\na')).toBe('a\na %%')
  })

  it('mutes every line in a mixed selection without double-muting existing lines', () => {
    const source = 'plain\n%% already muted\n- list item\n## heading'
    const result = toggleMutedLines(source, 0, 3)
    expect(result.source).toBe('plain %%\n%% already muted\n- list item %%\n## heading %%')
    expect(result.source.split('\n').filter((line) => line.includes('%%')).every((line) => !line.includes('%%%%'))).toBe(true)
    expect(toggleMutedLines(result.source, 0, 3).source).toBe('plain\nalready muted\n- list item\n## heading')
  })

  it('unmutes a selection only when every selected line is muted', () => {
    const source = '%% plain\n- %% list item\n## %% heading'
    expect(toggleMutedLines(source, 0, 2).source).toBe('plain\n- list item\n## heading')
  })

  it('mutes a line containing a Markdown link without changing its content', () => {
    const source = '[💡](https://example.com/recording) Transcribe with a better voice model.'
    expect(toggleMutedLines(source, 0, 0).source).toBe('[💡](https://example.com/recording) Transcribe with a better voice model. %%')
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
    expect(toggleChecklist('muted %%', 0)).toBe('- [ ] muted %%')
    expect(toggleMutedLines('- %% [x] muted task', 0, 0).source).toBe('- [x] muted task')
  })

  it('indents and outdents list items in source space', () => {
    const source = '- one\n  - nested\n- two\nplain\n- [ ] task\n1. ordered'
    // indent affects list lines only; caret delta tracks the start line
    expect(indentLines(source, 1, 2, 'indent')).toEqual({ source: '- one\n    - nested\n  - two\nplain\n- [ ] task\n1. ordered', caretDelta: 2 })
    expect(indentLines(source, 0, 0, 'indent')).toEqual({ source: '  - one\n  - nested\n- two\nplain\n- [ ] task\n1. ordered', caretDelta: 2 })
    // outdent removes up to two leading spaces
    expect(indentLines(source, 1, 1, 'outdent')).toEqual({ source: '- one\n- nested\n- two\nplain\n- [ ] task\n1. ordered', caretDelta: -2 })
    // no leading whitespace → nothing to outdent
    expect(indentLines(source, 0, 0, 'outdent')).toBeNull()
    // non-list lines are untouched; all-plain ranges report no change
    expect(indentLines('plain\nmore', 0, 1, 'indent')).toBeNull()
    expect(indentLines(source, 3, 3, 'outdent')).toBeNull()
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

  it('moves an outside line into a tag at its edge, then keeps walking inside', () => {
    const source = 'Line above\n\n:::tag{name="brainstorm"}\nQuestions for Lyle\n- Line A\n:::\n\nLine below'
    // Below the tag: up enters at the bottom, blank-separated from the last
    // content line.
    const entered = 'Line above\n\n:::tag{name="brainstorm"}\nQuestions for Lyle\n- Line A\n\nLine below\n:::'
    expect(moveLines(source, 7, 7, 'up')).toBe(entered)
    // Up again moves it above the tag's last line (jumping the list); the
    // separator blank stays behind before the closer.
    expect(moveLines(entered, 6, 6, 'up')).toBe('Line above\n\n:::tag{name="brainstorm"}\nQuestions for Lyle\n\nLine below\n\n- Line A\n\n:::')
    // Above the tag: down enters at the top, and the redundant separator is
    // consumed.
    expect(moveLines(source, 0, 0, 'down')).toBe(':::tag{name="brainstorm"}\nLine above\n\nQuestions for Lyle\n- Line A\n:::\n\nLine below')
  })

  it('moves a tag boundary instead of text when the selection straddles it', () => {
    const source = 'a\n\n:::tag{name="t"}\nb\nc\n:::\n\nd\ne'
    // Selection c..d straddles the close fence (lines 4..7). Moving up pulls
    // the outside part into the tag: the fence slides below the selection.
    expect(moveLines(source, 4, 7, 'up')).toBe('a\n\n:::tag{name="t"}\nb\nc\n\nd\n:::\ne')
    // Moving down shrinks the tag to exclude the inside part: the fence
    // slides above the selection.
    expect(moveLines(source, 4, 7, 'down')).toBe('a\n\n:::tag{name="t"}\nb\n:::\nc\n\nd\ne')
    // Straddling the open fence mirrors it: down encloses, up excludes.
    expect(moveLines(source, 1, 4, 'down')).toBe('a\n:::tag{name="t"}\n\nb\nc\n:::\n\nd\ne')
    expect(moveLines(source, 1, 4, 'up')).toBe('a\n\nb\nc\n:::tag{name="t"}\n:::\n\nd\ne')
    // More than one fence in the range is ambiguous — no move.
    const wrapped = 'x\n:::tag{name="t"}\ny\n:::\nz'
    expect(moveLines(wrapped, 0, 4, 'down')).toBe(wrapped)
  })

  it('moves a line inside a tag out across its boundary', () => {
    const source = 'Line above\n\n:::tag{name="brainstorm"}\nQuestions for Lyle\n- Line A\n:::\n\nLine below'
    expect(moveLines(source, 3, 3, 'up')).toBe('Line above\n\nQuestions for Lyle\n\n:::tag{name="brainstorm"}\n- Line A\n:::\n\nLine below')
    expect(moveLines(source, 4, 4, 'down')).toBe('Line above\n\n:::tag{name="brainstorm"}\nQuestions for Lyle\n:::\n\n- Line A\n\nLine below')
  })

  it('moves non-list content past an entire list as one block', () => {
    const source = 'before\n- parent one\n  - child one\n  - child two\n- parent two\n\nbelow para\nafter'
    expect(moveLines(source, 6, 6, 'up')).toBe('before\n\nbelow para\n\n- parent one\n  - child one\n  - child two\n- parent two\n\nafter')
    expect(moveLines(source, 0, 0, 'down')).toBe('- parent one\n  - child one\n  - child two\n- parent two\n\nbefore\n\nbelow para\nafter')
  })

  it('moves nested list lines without changing indentation or neighboring text', () => {
    const source = 'before\n- parent one\n  - child one\n  - child two\n- parent two\nafter'
    expect(moveLines(source, 2, 2, 'down')).toBe('before\n- parent one\n  - child two\n  - child one\n- parent two\nafter')
    expect(moveLines(source, 1, 3, 'down')).toBe('before\n- parent two\n- parent one\n  - child one\n  - child two\nafter')
  })

  it('keeps text outside a tagged line range unchanged', () => {
    const source = 'before\nfirst\nsecond\nafter'
    expect(addTagDirectiveToRange(source, 1, 2, 'therapy').source).toBe('before\n:::tag{name="therapy"}\nfirst\nsecond\n:::\nafter')
  })

  it('wraps a line range in a tag directive and rejects duplicate tags', () => {
    const source = 'before\nfirst\nsecond\nafter'
    expect(addTagDirectiveToRange(source, 1, 2, 'therapy').source).toBe('before\n:::tag{name="therapy"}\nfirst\nsecond\n:::\nafter')
    const tagged = ':::tag{name="therapy"}\ncontent\n:::'
    expect(addTagDirectiveToRange(tagged, 1, 1, 'therapy').error).toBeTruthy()
    expect(addTagDirectiveToRange(tagged, 1, 1, 'other').source).toBe('::::tag{name="therapy"}\n:::tag{name="other"}\ncontent\n:::\n::::')
  })

  it('tags a selection overlapping an existing tag as sibling + nested ranges', () => {
    // Lines 0-7 straddle `:::tag{t}` at 2 and `:::` at 5. The new tag wraps
    // the outside parts as siblings and nests inside the existing tag.
    const source = 'a\n\n:::tag{name="t"}\nb\nc\n:::\n\nd'
    expect(addTagDirectiveToRange(source, 0, 7, 'x').source).toBe(
      ':::tag{name="x"}\na\n\n:::\n::::tag{name="t"}\n:::tag{name="x"}\nb\nc\n:::\n::::\n:::tag{name="x"}\n\nd\n:::',
    )
    // The result is itself well-formed nested directives.
    const reparsed = parseMarkdown(addTagDirectiveToRange(source, 0, 7, 'x').source)
    expect(reparsed.diagnostics).toEqual([])
    expect(reparsed.ranges.map((range) => range.tag).sort()).toEqual(['t', 'x', 'x', 'x'])
    // A segment already inside the same tag is skipped; the rest still apply.
    const partiallyTagged = ':::tag{name="x"}\nb\n:::'
    const res = addTagDirectiveToRange('a\n\n' + partiallyTagged + '\n\nd', 0, 6, 'x')
    expect(res.error).toBeUndefined()
    expect(res.source).toBe(':::tag{name="x"}\na\n\n:::\n:::tag{name="x"}\nb\n:::\n:::tag{name="x"}\n\nd\n:::')
  })

  it('renames every matching directive while preserving quoted names', () => {
    const source = ':::tag{name="therapy"}\none\n:::\n:::tag{name="therapy notes"}\ntwo\n:::'
    expect(renameTagEverywhere(source, 'therapy', 'wellness')).toBe(':::tag{name="wellness"}\none\n:::\n:::tag{name="therapy notes"}\ntwo\n:::')
    expect(renameTagEverywhere(source, 'therapy notes', 'journal')).toBe(':::tag{name="therapy"}\none\n:::\n:::tag{name="journal"}\ntwo\n:::')
  })

  it('extracts a plain line range for a cross-editor move', () => {
    const source = 'one\n\ntwo\nthree\n\nfour'
    const extracted = extractLinesForMove(source, 2, 3)
    expect(extracted?.moved).toBe('two\nthree')
    expect(extracted?.source).toBe('one\n\n\nfour')
  })

  it('extracts the whole document when every line is selected', () => {
    const extracted = extractLinesForMove('one\ntwo', 0, 1)
    expect(extracted?.source).toBe('')
    expect(extracted?.moved).toBe('one\ntwo')
  })

  it('extracts directive contents raw, leaving the fences behind', () => {
    const source = ':::tag{name="t"}\na\nb\n:::'
    const extracted = extractLinesForMove(source, 1, 2)
    expect(extracted?.moved).toBe('a\nb')
    expect(extracted?.source).toBe(':::tag{name="t"}\n:::')
  })

  it('expands a partial-fence selection to the whole tag block', () => {
    const source = 'before\n\n:::tag{name="t"}\ninside\n:::'
    // Covers the opener but not the closer: the whole directive goes.
    const fromOpen = extractLinesForMove(source, 0, 2)
    expect(fromOpen?.moved).toBe('before\n\n:::tag{name="t"}\ninside\n:::')
    expect(fromOpen?.source).toBe('')
    // Covers the closer but not the opener.
    const fromClose = extractLinesForMove(source, 3, 4)
    expect(fromClose?.moved).toBe(':::tag{name="t"}\ninside\n:::')
    expect(fromClose?.source).toBe('before\n')
  })

  it('expands a selection that crosses one fence into the whole directive', () => {
    const source = ':::tag{name="t"}\ninside\n:::\nafter'
    const extracted = extractLinesForMove(source, 1, 3)
    expect(extracted?.moved).toBe(':::tag{name="t"}\ninside\n:::\nafter')
    expect(extracted?.source).toBe('')
  })

  it('moves a fully-selected tag block with nested fences intact', () => {
    const source = 'intro\n::::tag{name="outer"}\no\n:::tag{name="inner"}\ni\n:::\n::::\noutro'
    const extracted = extractLinesForMove(source, 1, 6)
    expect(extracted?.moved).toBe('::::tag{name="outer"}\no\n:::tag{name="inner"}\ni\n:::\n::::')
    expect(extracted?.source).toBe('intro\noutro')
    expect(parseMarkdown(extracted!.moved).diagnostics).toEqual([])
    expect(parseMarkdown(extracted!.source).diagnostics).toEqual([])
  })
})
