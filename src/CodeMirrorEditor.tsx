import { useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Decoration, EditorView, keymap, lineNumbers, ViewPlugin, type DecorationSet } from '@codemirror/view'
import { findMarkerTagRename, parseMarkdown, renameMatchingTag, type ParsedMarkdown } from './markerEngine'

function lineStyle(parsed: ParsedMarkdown, lineIndex: number) {
  if (parsed.markers.some((item) => item.line === lineIndex)) return 'cm-marker-line'
  const activeTags = parsed.ranges.filter((item) => item.startLine < lineIndex && lineIndex < item.endLine)
  if (!activeTags.length) return ''
  const firstTag = activeTags[0].tag
  const tagHash = [...firstTag].reduce((sum, character) => sum + character.codePointAt(0)!, 0) % 5
  const adjacent = activeTags.some((item) => parsed.ranges.some((other) => other !== item && (other.endLine === item.startLine || item.endLine === other.startLine)))
  const overlap = activeTags.length > 1
  return `cm-tagged-line cm-tag-color-${tagHash}${overlap ? ' cm-tagged-overlap' : ''}${adjacent ? ' cm-tagged-adjacent' : ''}`
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

const rangeDecorations = ViewPlugin.fromClass(class {
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
        const className = [lineStyle(parsed, lineIndex), markdownLineStyle(line.text)].filter(Boolean).join(' ')
        if (className) ranges.push(Decoration.line({ attributes: { class: className } }).range(line.from))
        if (className === 'cm-marker-line') {
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
                const tag = value.replace(/^\//u, '').replace(/^"|"$/gu, '')
                const tagHash = [...tag].reduce((sum, character) => sum + character.codePointAt(0)!, 0) % 5
                ranges.push(Decoration.mark({ class: `cm-tag-chip cm-tag-color-${tagHash}` }).range(line.from + markerStart + 4 + index, line.from + markerStart + 4 + index + value.length))
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

interface CodeMirrorEditorProps {
  value: string
  onChange: (value: string) => void
  onSelection?: (from: number, to: number) => void
  focusAtEnd?: boolean
  sourceMode?: boolean
}

export function CodeMirrorEditor({ value, onChange, onSelection, focusAtEnd = false, sourceMode = false }: CodeMirrorEditorProps) {
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
          keymap.of([
            { key: 'Mod-b', run: (view) => toggleMarkdownMark(view, '**', '**') },
            { key: 'Mod-i', run: (view) => toggleMarkdownMark(view, '*', '*') },
            { key: 'Mod-u', run: (view) => toggleMarkdownMark(view, '<u>', '</u>') },
            ...defaultKeymap,
            indentWithTab,
          ]),
          EditorView.lineWrapping,
          EditorView.baseTheme({ '.cm-marker-line': { color: '#8c8794', fontStyle: 'italic' } }),
          rangeDecorations,
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
  }, [focusAtEnd, initialValue])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  return <div className={`codemirror-host ${sourceMode ? 'source-mode' : ''}`} ref={host} aria-label="Markdown editor" />
}
