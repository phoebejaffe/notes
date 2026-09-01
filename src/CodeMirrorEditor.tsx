import { useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { Decoration, EditorView, keymap, lineNumbers, ViewPlugin, type DecorationSet } from '@codemirror/view'
import { parseMarkdown, type ParsedMarkdown } from './markerEngine'

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
    for (const { from, to } of view.visibleRanges) {
      let position = from
      while (position <= to) {
        const line = view.state.doc.lineAt(position)
        const lineIndex = line.number - 1
        const className = lineStyle(parsed, lineIndex)
        if (className) ranges.push(Decoration.line({ attributes: { class: className } }).range(line.from))
        if (className === 'cm-marker-line') {
          const markerStart = line.text.indexOf('<!--')
          const markerEnd = line.text.lastIndexOf('-->')
          if (markerStart >= 0 && markerEnd > markerStart) {
            ranges.push(Decoration.mark({ class: 'cm-marker-syntax' }).range(line.from + markerStart, line.from + markerStart + 4))
            ranges.push(Decoration.mark({ class: 'cm-marker-syntax' }).range(line.from + markerEnd, line.from + markerEnd + 3))
            const body = line.text.slice(markerStart + 4, markerEnd)
            const tokens = /\/?(?:"(?:\\.|[^"])*"|\S+)/gu
            let token: RegExpExecArray | null
            while ((token = tokens.exec(body))) {
              ranges.push(Decoration.mark({ class: 'cm-tag-chip' }).range(line.from + markerStart + 4 + token.index, line.from + markerStart + 4 + token.index + token[0].length))
            }
          }
        }
        if (line.to >= to) break
        position = line.to + 1
      }
    }
    return Decoration.set(ranges)
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
  const [initialValue] = useState(value)

  useEffect(() => { onChangeRef.current = onChange }, [onChange])
  useEffect(() => { onSelectionRef.current = onSelection }, [onSelection])

  useEffect(() => {
    if (!host.current) return
    const view = new EditorView({
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          lineNumbers(),
          markdown(),
          keymap.of([...defaultKeymap, indentWithTab]),
          EditorView.baseTheme({ '.cm-marker-line': { color: '#8c8794', fontStyle: 'italic' } }),
          rangeDecorations,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString())
            if (update.selectionSet || update.docChanged) {
              const selection = update.state.selection.main
              onSelectionRef.current?.(selection.from, selection.to)
            }
          }),
          EditorView.theme({ '&': { minHeight: '330px' }, '.cm-scroller': { overflow: 'auto' } }),
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
