import { useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, deleteCharBackwardStrict, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Decoration, EditorView, keymap, lineNumbers, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'
import { findMarkerTagRename, isMutedLine, mutedMarkerPosition, parseMarkdown, renameMatchingTag, toggleMutedLines, type ParsedMarkdown } from './markerEngine'

function lineStyle(parsed: ParsedMarkdown, lineIndex: number, tagColors: Record<string, string>) {
  if (parsed.markers.some((item) => item.line === lineIndex)) return 'cm-marker-line'
  const activeTags = parsed.ranges.filter((item) => item.startLine < lineIndex && lineIndex < item.endLine).sort((left, right) => left.startLine - right.startLine)
  if (!activeTags.length) return ''
  const outerColor = tagColors[activeTags[0].tag]
  const innerColor = tagColors[activeTags[1]?.tag ?? activeTags[0].tag]
  const adjacent = activeTags.some((item) => parsed.ranges.some((other) => other !== item && (other.endLine === item.startLine || item.endLine === other.startLine)))
  const overlap = activeTags.length > 1
  const layerClasses = activeTags.slice(0, 4).map((tag, index) => `${index === 0 ? 'cm-tag-color' : ['cm-tag-inner-color', 'cm-tag-third-color', 'cm-tag-fourth-color'][index - 1]}-${[...tag.tag].reduce((sum, character) => sum + character.codePointAt(0)!, 0) % 5}`).join(' ')
  return `cm-tagged-line cm-tagged-${Math.min(activeTags.length, 4)} ${layerClasses}${outerColor ? ' cm-tag-custom-outer' : ''}${overlap ? ` cm-tagged-overlap${innerColor ? ' cm-tag-custom-inner' : ''}` : ''}${adjacent ? ' cm-tagged-adjacent' : ''}`
}

function tagDepthAtLine(parsed: ParsedMarkdown, lineIndex: number) {
  return parsed.ranges.filter((range) => range.startLine < lineIndex && lineIndex < range.endLine).length
}

function maxTagDepth(parsed: ParsedMarkdown) {
  return parsed.lines.reduce((maximum, _line, index) => Math.max(maximum, Math.max(0, tagDepthAtLine(parsed, index) - 1)), 0)
}

function markdownLineStyle(line: string) {
  if (/^\s*#{1,6}\s/u.test(line)) return 'cm-heading-line'
  if (/^\s*(?:[-*+]\s|\d+[.)]\s)/u.test(line)) return 'cm-list-line'
  return ''
}

function lineMatchesFilter(parsed: ParsedMarkdown, lineIndex: number, filterTags: string[], hideMutedLines: boolean) {
  if (hideMutedLines && isMutedLine(parsed.lines[lineIndex] ?? '')) return false
  if (!filterTags.length) return true
  const selected = new Set(filterTags)
  const marker = parsed.markers.find((item) => item.line === lineIndex)
  if (marker?.tags.some((tag) => selected.has(tag))) return true
  return parsed.ranges.some((range) => selected.has(range.tag) && range.startLine < lineIndex && lineIndex < range.endLine)
}

function lineIsNavigable(parsed: ParsedMarkdown, lineIndex: number, filterTags: string[], hideMutedLines: boolean) {
  return !parsed.markers.some((marker) => marker.line === lineIndex) && lineMatchesFilter(parsed, lineIndex, filterTags, hideMutedLines)
}

function moveToVisibleLine(view: EditorView, direction: -1 | 1, filterTags: string[], hideMutedLines: boolean) {
  const selection = view.state.selection.main
  const currentLine = view.state.doc.lineAt(selection.head)
  const currentLineIndex = currentLine.number - 1
  const parsed = parseMarkdown(view.state.doc.toString())
  if (isMutedLine(currentLine.text) || parsed.ranges.some((range) => range.startLine < currentLineIndex && currentLineIndex < range.endLine)) return false
  const cursorCoords = view.coordsAtPos(selection.head)
  const lineEndCoords = view.coordsAtPos(currentLine.to)
  if (direction < 0 && selection.head !== currentLine.from) return false
  if (direction > 0 && (!cursorCoords || !lineEndCoords || cursorCoords.bottom < lineEndCoords.bottom - 1)) return false
  let targetLineIndex = currentLineIndex + direction
  while (targetLineIndex >= 0 && targetLineIndex < parsed.lines.length && !lineIsNavigable(parsed, targetLineIndex, filterTags, hideMutedLines)) targetLineIndex += direction
  if (targetLineIndex === currentLineIndex + direction) return false
  if (targetLineIndex < 0 || targetLineIndex >= parsed.lines.length) return true
  const targetLine = view.state.doc.line(targetLineIndex + 1)
  const column = Math.min(selection.head - view.state.doc.line(currentLineIndex + 1).from, targetLine.length)
  view.dispatch({ selection: { anchor: targetLine.from + column } })
  return true
}

function toggleTaskAtSelection(view: EditorView) {
  const selection = view.state.selection.main
  const line = view.state.doc.lineAt(selection.from)
  const match = line.text.match(/^(?:\s*(?:[-*+]|\d+[.)])\s+)?\[([ xX])\]/u)
  if (!match) return false
  const from = line.from + match[0].indexOf('[')
  view.dispatch({ changes: { from, to: from + 3, insert: match[1].toLowerCase() === 'x' ? '[ ]' : '[x]' } })
  return true
}

function toggleMutedAtSelection(view: EditorView) {
  const selection = view.state.selection.main
  const startLine = view.state.doc.lineAt(selection.from).number - 1
  const endLine = view.state.doc.lineAt(selection.to).number - 1
  const result = toggleMutedLines(view.state.doc.toString(), startLine, endLine)
  if (!result.changes.length) return false
  view.dispatch({ changes: result.changes })
  return true
}

function toggleMarkdownMark(view: EditorView, opening: string, closing: string) {
  const selection = view.state.selection.main
  const selectedText = view.state.sliceDoc(selection.from, selection.to)
  const before = view.state.sliceDoc(Math.max(0, selection.from - opening.length), selection.from)
  const after = view.state.sliceDoc(selection.to, selection.to + closing.length)
  if (before === opening && after === closing) {
    view.dispatch({
      changes: [{ from: selection.from - opening.length, to: selection.from, insert: '' }, { from: selection.to, to: selection.to + closing.length, insert: '' }],
      selection: { anchor: selection.from - opening.length, head: selection.to - opening.length },
    })
  } else if (selectedText) {
    view.dispatch({
      changes: [{ from: selection.to, insert: closing }, { from: selection.from, insert: opening }],
      selection: { anchor: selection.from + opening.length, head: selection.to + opening.length },
    })
  } else {
    view.dispatch({ changes: { from: selection.from, insert: `${opening}${closing}` }, selection: { anchor: selection.from + opening.length } })
  }
  return true
}

class TaskCheckboxWidget extends WidgetType {
  private readonly checked: boolean
  private readonly from: number

  constructor(checked: boolean, from: number) {
    super()
    this.checked = checked
    this.from = from
  }

  eq(other: TaskCheckboxWidget) {
    return this.checked === other.checked
  }

  toDOM(view: EditorView) {
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = this.checked
    input.className = 'cm-task-checkbox'
    input.setAttribute('aria-label', this.checked ? 'Mark task incomplete' : 'Mark task complete')
    input.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      view.dispatch({ changes: { from: this.from, to: this.from + 3, insert: this.checked ? '[ ]' : '[x]' } })
    })
    return input
  }

  ignoreEvent() {
    return true
  }
}

function createRangeDecorations(tagColors: Record<string, string>, filterTags: string[], sourceMode: boolean, hideMutedLines: boolean) {
  return ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = this.build(view)
  }

  update(update: { view: EditorView; docChanged: boolean; viewportChanged: boolean }) {
    if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view)
  }

  build(view: EditorView) {
    const parsed = parseMarkdown(view.state.doc.toString())
    const ranges = []
    const seenLines = new Set<number>()
    for (const { from, to } of view.visibleRanges) {
      let position = from
      while (position <= to) {
        const line = view.state.doc.lineAt(position)
        const lineIndex = line.number - 1
        if (seenLines.has(lineIndex)) {
          if (line.to >= to) break
          position = line.to + 1
          continue
        }
        seenLines.add(lineIndex)
        const rangeClass = lineStyle(parsed, lineIndex, tagColors)
        const mutedMarker = mutedMarkerPosition(line.text)
        const className = [rangeClass, markdownLineStyle(line.text), mutedMarker ? 'cm-muted-line' : '', lineMatchesFilter(parsed, lineIndex, filterTags, hideMutedLines) ? '' : 'cm-filter-hidden'].filter(Boolean).join(' ')
        const activeTags = parsed.ranges.filter((item) => item.startLine < lineIndex && lineIndex < item.endLine).sort((left, right) => left.startLine - right.startLine)
        const customColors = activeTags.slice(0, 4).map((range, index) => tagColors[range.tag] ? `--tag-${['outer', 'inner', 'third', 'fourth'][index]}:${tagColors[range.tag]}` : '').filter(Boolean).join(';')
        const dayInset = Math.min(maxTagDepth(parsed), 4) * 3
        const borderCount = rangeClass.includes('cm-tagged-line') ? Math.min(activeTags.length, 4) : 0
        const lineInset = rangeClass.includes('cm-marker-line') ? 0 : dayInset + (borderCount ? borderCount * 3 + 12 : 0)
        const lineStyles = [`--tag-border-start:0px`, `--tag-text-inset:${lineInset}px`, `padding-left:${lineInset}px`, customColors].filter(Boolean).join(';')
        if (className) ranges.push(Decoration.line({ attributes: { class: className, style: lineStyles } }).range(line.from))
        if (mutedMarker && !sourceMode) ranges.push(Decoration.mark({ class: 'cm-muted-marker' }).range(line.from + mutedMarker.start, line.from + mutedMarker.end))
        if (!sourceMode) {
          const taskMatch = line.text.match(/^(?:\s*(?:[-*+]|\d+[.)])\s+)?\[([ xX])\]/u)
          if (taskMatch && taskMatch.index !== undefined) {
            const checkboxStart = line.from + taskMatch.index + taskMatch[0].indexOf('[')
            ranges.push(Decoration.replace({ widget: new TaskCheckboxWidget(taskMatch[1].toLowerCase() === 'x', checkboxStart) }).range(checkboxStart, checkboxStart + 3))
          }
        }
        if (rangeClass === 'cm-marker-line') {
          const markerStart = line.text.indexOf('<!--')
          const markerEnd = line.text.lastIndexOf('-->')
          if (markerStart >= 0 && markerEnd > markerStart) {
            const body = line.text.slice(markerStart + 4, markerEnd)
            const tokens = /\/?(?:"(?:\\.|[^"])*"|\S+)/gu
            const tokenRanges: Array<{ index: number; value: string }> = []
            let token: RegExpExecArray | null
            while ((token = tokens.exec(body))) tokenRanges.push({ index: token.index, value: token[0] })
            if (tokenRanges.length) {
              const first = tokenRanges[0]
              const last = tokenRanges[tokenRanges.length - 1]
              ranges.push(Decoration.mark({ class: 'cm-marker-syntax' }).range(line.from + markerStart, line.from + markerStart + 4 + first.index))
              ranges.push(Decoration.mark({ class: 'cm-marker-syntax' }).range(line.from + markerStart + 4 + last.index + last.value.length, line.from + markerEnd + 3))
              tokenRanges.forEach(({ index, value }) => {
                const tag = value.replace(/^\//u, '').replace(/^"|"$/gu, '').normalize('NFC')
                const tagHash = [...tag].reduce((sum, character) => sum + character.codePointAt(0)!, 0) % 5
                const customColor = tagColors[tag]
                const outerTags = parsed.ranges.filter((range) => range.startLine < lineIndex && lineIndex < range.endLine).sort((left, right) => left.startLine - right.startLine)
                const outerColors = outerTags.slice(0, 4).map((range) => tagColors[range.tag] ?? ['#6d9b91', '#8975aa', '#c88968', '#7190b0', '#b28a55'][[...range.tag].reduce((sum, character) => sum + character.codePointAt(0)!, 0) % 5])
                const outerClass = outerColors.length ? ` cm-has-outer-border${outerColors.length > 3 ? ' cm-has-quadruple-outer-border' : outerColors.length > 2 ? ' cm-has-triple-outer-border' : outerColors.length > 1 ? ' cm-has-double-outer-border' : ''}` : ''
                const outerStyle = outerColors.map((color, colorIndex) => `--marker-outer-${colorIndex + 1}:${color}`).join(';')
                const labelInset = outerTags.length * 3
                const chipStyle = [customColor ? `--tag-color:${customColor}` : '', outerStyle, `--tag-label-inset:${labelInset}px`].filter(Boolean).join(';')
                ranges.push(Decoration.mark({ class: `cm-tag-chip cm-tag-color-${tagHash}${outerClass}`, attributes: { style: chipStyle } }).range(line.from + markerStart + 4 + index, line.from + markerStart + 4 + index + value.length))
              })
            }
          }
        }
        const strongPattern = /(?<![*_])(\*\*|__)(?![*_])(\S(?:.*?\S)?)\1(?![*_])/gu
        for (const match of line.text.matchAll(strongPattern)) {
          ranges.push(Decoration.mark({ class: 'cm-strong-text' }).range(line.from + match.index!, line.from + match.index! + match[0].length))
        }
        const triplePattern = /(?<!\*)\*{3}(\S(?:.*?\S)?)\*{3}(?!\*)/gu
        for (const match of line.text.matchAll(triplePattern)) {
          ranges.push(Decoration.mark({ class: 'cm-strong-text cm-emphasis-text' }).range(line.from + match.index!, line.from + match.index! + match[0].length))
        }
        const italicPattern = /(^|[^*_])([*_])(?!\2)(\S(?:.*?\S)?)\2(?![*_])/gu
        for (const match of line.text.matchAll(italicPattern)) {
          const start = line.from + match.index! + match[1].length
          ranges.push(Decoration.mark({ class: 'cm-emphasis-text' }).range(start, start + match[0].length - match[1].length))
        }
        const underlinePattern = /<u>(\S(?:.*?\S)?)<\/u>/giu
        for (const match of line.text.matchAll(underlinePattern)) {
          ranges.push(Decoration.mark({ class: 'cm-underline-text' }).range(line.from + match.index!, line.from + match.index! + match[0].length))
        }
        const strikethroughPattern = /(?<!~)~~(\S(?:.*?\S)?)~~(?!~)/gu
        for (const match of line.text.matchAll(strikethroughPattern)) {
          ranges.push(Decoration.mark({ class: 'cm-strikethrough-dim' }).range(line.from + match.index!, line.from + match.index! + match[0].length))
          ranges.push(Decoration.mark({ class: 'cm-strikethrough-text' }).range(line.from + match.index! + 2, line.from + match.index! + match[0].length - 2))
        }
        if (line.to >= to) break
        position = line.to + 1
      }
    }
    return Decoration.set(ranges, true)
  }
  }, { decorations: (value) => value.decorations })
}

interface CodeMirrorEditorProps {
  value: string
  onChange: (value: string) => void
  onSelection?: (from: number, to: number) => void
  focusAtEnd?: boolean
  sourceMode?: boolean
  tagColors?: Record<string, string>
  restoreSelection?: { from: number; to: number }
  hideTagSyntax?: boolean
  strikethroughShortcut?: string
  taskToggleShortcut?: string
  filterTags?: string[]
  hideMutedLines?: boolean
  commandRequest?: { id: number; kind: 'bold' | 'italic' | 'strikethrough' | 'mute' }
}

export function CodeMirrorEditor({ value, onChange, onSelection, focusAtEnd = false, sourceMode = false, tagColors = {}, restoreSelection, hideTagSyntax = true, strikethroughShortcut = 'Mod-Shift-x', taskToggleShortcut = 'Mod-Enter', filterTags = [], hideMutedLines = false, commandRequest }: CodeMirrorEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onSelectionRef = useRef(onSelection)
  const sourceModeRef = useRef(sourceMode)
  const selectionRef = useRef({ from: 0, to: 0 })
  const syncingRenameRef = useRef(false)
  const [initialValue] = useState(value)

  useEffect(() => { onChangeRef.current = onChange }, [onChange])
  useEffect(() => { onSelectionRef.current = onSelection }, [onSelection])
  useEffect(() => { sourceModeRef.current = sourceMode }, [sourceMode])

  useEffect(() => {
    if (!host.current) return
    const view = new EditorView({
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          lineNumbers({ formatNumber: (lineNumber, state) => lineMatchesFilter(parseMarkdown(state.doc.toString()), lineNumber - 1, filterTags, hideMutedLines) ? String(lineNumber) : '' }),
          markdown(),
          syntaxHighlighting(defaultHighlightStyle),
          history(),
          keymap.of([
            { key: 'ArrowDown', run: (view) => moveToVisibleLine(view, 1, filterTags, hideMutedLines) },
            { key: 'Mod-/', run: toggleMutedAtSelection },
            { key: 'Backspace', run: deleteCharBackwardStrict },
            { key: 'Mod-b', run: (view) => toggleMarkdownMark(view, '**', '**') },
            { key: 'Mod-i', run: (view) => toggleMarkdownMark(view, '*', '*') },
            { key: 'Mod-u', run: (view) => toggleMarkdownMark(view, '<u>', '</u>') },
            { key: strikethroughShortcut, run: (view) => toggleMarkdownMark(view, '~~', '~~') },
            { key: taskToggleShortcut, run: toggleTaskAtSelection },
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          EditorView.lineWrapping,
          EditorView.baseTheme({ '.cm-marker-line': { color: '#8c8794', fontStyle: 'italic' } }),
          createRangeDecorations(tagColors, filterTags, sourceMode, hideMutedLines),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              let next = update.state.doc.toString()
              if (!sourceModeRef.current && !syncingRenameRef.current) {
                const rename = findMarkerTagRename(update.startState.doc.toString(), next)
                if (rename) {
                  const renamed = renameMatchingTag(next, rename.line, rename.oldTag, rename.newTag)
                  if (renamed !== next) {
                    syncingRenameRef.current = true
                    update.view.dispatch({ changes: { from: 0, to: next.length, insert: renamed } })
                    syncingRenameRef.current = false
                    next = renamed
                  }
                }
              }
              onChangeRef.current(next)
            }
            if (update.selectionSet || update.docChanged) {
              const selection = update.state.selection.main
              selectionRef.current = { from: selection.from, to: selection.to }
              onSelectionRef.current?.(selection.from, selection.to)
            }
          }),
          EditorView.theme({ '&': { minHeight: '50px' }, '.cm-scroller': { overflow: 'visible', overflowX: 'hidden' }, '.cm-content': { overflowWrap: 'anywhere' } }),
        ],
      }),
      parent: host.current,
    })
    viewRef.current = view
    if (focusAtEnd) {
      view.dispatch({ selection: { anchor: view.state.doc.length } })
      selectionRef.current = { from: view.state.doc.length, to: view.state.doc.length }
      view.focus()
    }
    return () => { viewRef.current = null; view.destroy() }
  }, [filterTags, focusAtEnd, hideMutedLines, hideTagSyntax, initialValue, sourceMode, strikethroughShortcut, tagColors, taskToggleShortcut])

  useEffect(() => {
    const view = viewRef.current
    if (!view || !commandRequest) return
    view.dispatch({ selection: { anchor: selectionRef.current.from, head: selectionRef.current.to } })
    if (commandRequest.kind === 'bold') toggleMarkdownMark(view, '**', '**')
    if (commandRequest.kind === 'italic') toggleMarkdownMark(view, '*', '*')
    if (commandRequest.kind === 'strikethrough') toggleMarkdownMark(view, '~~', '~~')
    if (commandRequest.kind === 'mute') toggleMutedAtSelection(view)
    view.focus()
  }, [commandRequest])

  const depthClass = Math.min(maxTagDepth(parseMarkdown(value)), 4)
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) {
      const from = Math.min(restoreSelection?.from ?? selectionRef.current.from, value.length)
      const to = Math.min(restoreSelection?.to ?? selectionRef.current.to, value.length)
      view.dispatch({ changes: { from: 0, to: current.length, insert: value }, selection: { anchor: from, head: to } })
      selectionRef.current = { from, to }
    }
  }, [restoreSelection, value])

  return <div className="editor-container">
    <div className={`codemirror-host tag-depth-${depthClass} ${sourceMode ? 'source-mode' : ''} ${hideTagSyntax ? 'hide-tag-syntax' : ''}`} ref={host} aria-label="Markdown editor" />
  </div>
}
