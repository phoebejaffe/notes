import { useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Decoration, EditorView, keymap, lineNumbers, ViewPlugin, type DecorationSet } from '@codemirror/view'
import { findMarkerTagRename, parseMarkdown, renameMatchingTag, type ParsedMarkdown } from './markerEngine'

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
  if (/^\\s*#{1,6}\\s/u.test(line)) return 'cm-heading-line'
  if (/^\\s*(?:[-*+]\\s|\\d+[.)]\\s)/u.test(line)) return 'cm-list-line'
  return ''
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

function createRangeDecorations(tagColors: Record<string, string>) {
  return ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = this.build(view)
  }

  update(update: { view: EditorView; docChanged: boolean }) {
    if (update.docChanged) this.decorations = this.build(update.view)
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
        const className = [rangeClass, markdownLineStyle(line.text)].filter(Boolean).join(' ')
        const activeTags = parsed.ranges.filter((item) => item.startLine < lineIndex && lineIndex < item.endLine).sort((left, right) => left.startLine - right.startLine)
        const customColors = activeTags.slice(0, 4).map((range, index) => tagColors[range.tag] ? `--tag-${['outer', 'inner', 'third', 'fourth'][index]}:${tagColors[range.tag]}` : '').filter(Boolean).join(';')
        const dayInset = Math.min(maxTagDepth(parsed), 4) * 3
        const borderCount = rangeClass.includes('cm-tagged-line') ? Math.min(activeTags.length, 4) : 0
        const lineInset = rangeClass.includes('cm-marker-line') ? 0 : dayInset + (borderCount ? borderCount * 3 + 12 : 0)
        const lineStyles = [`--tag-border-start:0px`, `--tag-text-inset:${lineInset}px`, `padding-left:${lineInset}px`, customColors].filter(Boolean).join(';')
        if (className) ranges.push(Decoration.line({ attributes: { class: className, style: lineStyles } }).range(line.from))
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
}

export function CodeMirrorEditor({ value, onChange, onSelection, focusAtEnd = false, sourceMode = false, tagColors = {}, restoreSelection, hideTagSyntax = true }: CodeMirrorEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onSelectionRef = useRef(onSelection)
  const sourceModeRef = useRef(sourceMode)
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
          lineNumbers(),
          markdown(),
          syntaxHighlighting(defaultHighlightStyle),
          history(),
          keymap.of([
            { key: 'Mod-b', run: (view) => toggleMarkdownMark(view, '**', '**') },
            { key: 'Mod-i', run: (view) => toggleMarkdownMark(view, '*', '*') },
            { key: 'Mod-u', run: (view) => toggleMarkdownMark(view, '<u>', '</u>') },
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          EditorView.lineWrapping,
          EditorView.baseTheme({ '.cm-marker-line': { color: '#8c8794', fontStyle: 'italic' } }),
          createRangeDecorations(tagColors),
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
      view.focus()
    }
    return () => { viewRef.current = null; view.destroy() }
  }, [focusAtEnd, hideTagSyntax, initialValue, tagColors])

  const depthClass = Math.min(maxTagDepth(parseMarkdown(value)), 4)
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) {
      const from = Math.min(restoreSelection?.from ?? view.state.selection.main.from, value.length)
      const to = Math.min(restoreSelection?.to ?? view.state.selection.main.to, value.length)
      view.dispatch({ changes: { from: 0, to: current.length, insert: value }, selection: { anchor: from, head: to } })
    }
  }, [restoreSelection, value])

  return <div className="editor-container">
    <div className={`codemirror-host tag-depth-${depthClass} ${sourceMode ? 'source-mode' : ''} ${hideTagSyntax ? 'hide-tag-syntax' : ''}`} ref={host} aria-label="Markdown editor" />
  </div>
}
