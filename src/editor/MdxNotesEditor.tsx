import { useEffect, useMemo, useRef, type MouseEvent } from 'react'
import { MDXEditor, type MDXEditorMethods } from '@mdxeditor/editor'
import { $createRangeSelection, $getNearestNodeFromDOMNode, $setSelection, type LexicalEditor } from 'lexical'
import { $getNearestNodeOfType } from '@lexical/utils'
import { INSERT_CHECK_LIST_COMMAND, ListItemNode } from '@lexical/list'
import { mdxEditorPlugins } from './mdxEditorPlugins'
import { markdownForEditor, restoreMarkdownSpacing } from './markdownSpacing'
import { buildDocumentMap, contentEditable, placeCaretAtCanonicalLine, reapplyUntilSettled, selectCanonicalLines, selectionLineRange } from './sourceMapping'
import { clearMutedDecorations, nearestVisibleLine, refreshMutedDecorations } from './mutedDecorations'
import { checklistToPlainText, moveLinesDetailed, preserveMutedLines, removeChecklist, toggleMutedLines } from '../markerEngine'
import type { MdxNotesEditorProps } from './editorTypes'

type Restore =
  | { type: 'caret'; line: number; offset: number }
  | { type: 'range'; startLine: number; endLine: number }

export function MdxNotesEditor({ value, onChange, autoFocus = false, hideMutedLines = false }: MdxNotesEditorProps) {
  const editorRef = useRef<MDXEditorMethods>(null)
  const lexicalEditorRef = useMemo(() => ({ current: null as LexicalEditor | null }), [])
  const hostRef = useRef<HTMLDivElement>(null)
  const valueRef = useRef(value)
  const onChangeRef = useRef(onChange)
  const hideMutedLinesRef = useRef(hideMutedLines)
  const userInteractedRef = useRef(false)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const markInteraction = (event: Event) => {
      if (host.contains(event.target as Node)) userInteractedRef.current = true
    }
    host.addEventListener('beforeinput', markInteraction)
    host.addEventListener('keydown', markInteraction)
    host.addEventListener('paste', markInteraction)
    host.addEventListener('pointerdown', markInteraction, true)
    host.addEventListener('click', markInteraction)
    return () => {
      host.removeEventListener('beforeinput', markInteraction)
      host.removeEventListener('keydown', markInteraction)
      host.removeEventListener('paste', markInteraction)
      host.removeEventListener('pointerdown', markInteraction, true)
      host.removeEventListener('click', markInteraction)
    }
  }, [])

  // Muted-line decorations are recomputed from the canonical source whenever
  // it changes — CSS highlight ranges track DOM text, so they must be rebuilt
  // after every re-import. Retried over frames for decorator content.
  // Only reads refs, so it is safe to call from any effect or handler.
  const refreshDecorations = () => {
    const host = hostRef.current
    if (!host) return
    const apply = () => refreshMutedDecorations(host, valueRef.current, hideMutedLinesRef.current)
    apply()
    requestAnimationFrame(apply)
    requestAnimationFrame(() => requestAnimationFrame(apply))
  }
  const refreshDecorationsRef = useRef(refreshDecorations)
  useEffect(() => {
    refreshDecorationsRef.current = refreshDecorations
  })

  useEffect(() => {
    hideMutedLinesRef.current = hideMutedLines
    const host = hostRef.current
    if (!host) return
    // Note the caret's canonical line before hiding collapses blocks, then
    // restore it — on the nearest still-visible line if its own disappeared.
    const map = buildDocumentMap(valueRef.current)
    const range = selectionLineRange(host, map)
    refreshDecorationsRef.current()
    if (!range) return
    const line = hideMutedLines ? nearestVisibleLine(valueRef.current, range.startLine) : range.startLine
    const offset = line === range.startLine ? range.caretOffset : 0
    reapplyUntilSettled(() => placeCaretAtCanonicalLine(host, map, line, offset))
  }, [hideMutedLines])

  useEffect(() => {
    refreshDecorationsRef.current()
    const host = hostRef.current
    return () => { if (host) clearMutedDecorations(host) }
  }, [])

  useEffect(() => {
    if (valueRef.current === value) return
    valueRef.current = value
    editorRef.current?.setMarkdown(markdownForEditor(value).markdown)
    refreshDecorationsRef.current()
  }, [value])

  // Editor commands run on keydown capture so Lexical never sees them. Line
  // edits are applied to the canonical Markdown and re-imported; the caret or
  // selection is then restored by mapping canonical lines back through mdast
  // source positions (see sourceMapping.ts).
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const commit = (markdown: string, restore?: Restore) => {
      valueRef.current = markdown
      editorRef.current?.setMarkdown(markdownForEditor(markdown).markdown)
      onChangeRef.current(markdown)
      if (!restore) return
      const map = buildDocumentMap(markdown)
      reapplyUntilSettled(() => restore.type === 'caret'
        ? placeCaretAtCanonicalLine(host, map, restore.line, restore.offset)
        : selectCanonicalLines(host, map, restore.startLine, restore.endLine))
      refreshDecorationsRef.current()
    }

    // Cmd+/ and the toolbar mute button both toggle ` %%` on the selected
    // canonical source lines.
    const muteSelection = () => {
      const map = buildDocumentMap(valueRef.current)
      const range = selectionLineRange(host, map)
      if (!range) return false
      const result = toggleMutedLines(valueRef.current, range.startLine, range.endLine)
      if (result.source === valueRef.current) return false
      commit(result.source, range.collapsed
        ? { type: 'caret', line: range.startLine, offset: range.caretOffset }
        : { type: 'range', startLine: range.startLine, endLine: range.endLine })
      return true
    }

    const lexicalPointFor = (node: Node, offset: number): [string, number, 'text' | 'element'] | null => {
      const lexicalNode = $getNearestNodeFromDOMNode(node)
      if (!lexicalNode) return null
      return [lexicalNode.getKey(), offset, node.nodeType === Node.TEXT_NODE ? 'text' : 'element']
    }

    const toggleChecklistItem = () => {
      const editor = lexicalEditorRef.current
      if (!editor) return
      const domSelection = window.getSelection()
      let insert = false
      editor.update(() => {
        const anchorNode = domSelection?.anchorNode ?? null
        const anchorLexical = anchorNode ? $getNearestNodeFromDOMNode(anchorNode) : null
        const item = anchorLexical ? $getNearestNodeOfType(anchorLexical, ListItemNode) : null
        if (item) {
          const checked = item.getChecked()
          item.setChecked(checked === undefined ? false : !checked)
        } else if (domSelection?.anchorNode && domSelection.focusNode) {
          // The Lexical selection can lag the DOM selection after a commit —
          // rebuild it from the DOM before inserting a list at the caret.
          const anchor = lexicalPointFor(domSelection.anchorNode, domSelection.anchorOffset)
          const focus = lexicalPointFor(domSelection.focusNode, domSelection.focusOffset)
          if (anchor && focus) {
            const range = $createRangeSelection()
            range.anchor.set(...anchor)
            range.focus.set(...focus)
            $setSelection(range)
            insert = true
          }
        }
      })
      if (insert) editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined)
    }

    const caretInNestedEditor = () => {
      const editable = contentEditable(host)
      const anchor = window.getSelection()?.anchorNode
      const editableAtCaret = anchor ? (anchor instanceof Element ? anchor : anchor.parentElement)?.closest('[contenteditable="true"]') : null
      return !!editable && !!editableAtCaret && editableAtCaret !== editable
    }

    const runCommand = (event: KeyboardEvent): boolean => {
      const mod = event.metaKey || event.ctrlKey

      if (event.altKey && !mod && !event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        const map = buildDocumentMap(valueRef.current)
        const range = selectionLineRange(host, map)
        if (!range) return false
        const moved = moveLinesDetailed(valueRef.current, range.startLine, range.endLine, event.key === 'ArrowUp' ? 'up' : 'down')
        if (!moved) return true
        commit(moved.source, range.collapsed
          ? { type: 'caret', line: moved.startLine, offset: range.caretOffset }
          : { type: 'range', startLine: moved.startLine, endLine: moved.endLine })
        return true
      }

      if (!mod) return false

      if (!event.shiftKey && event.key === '/') return muteSelection()

      // Cmd+Shift+Enter drops the checkbox marker while keeping the list item —
      // inside a 'check' list Lexical normalizes undefined `checked` back to a
      // checkbox, so this has to happen in Markdown space.
      if (event.shiftKey && event.key === 'Enter') {
        const map = buildDocumentMap(valueRef.current)
        const range = selectionLineRange(host, map)
        if (!range) return false
        const next = removeChecklist(valueRef.current, range.startLine)
        if (next === valueRef.current) return false
        commit(next, { type: 'caret', line: range.startLine, offset: range.caretOffset })
        return true
      }

      // Lexical node commands only make sense in the outer editor — selections
      // inside nested directive editors are not visible to it.
      if (caretInNestedEditor()) return false

      if (event.key === 'Enter') {
        toggleChecklistItem()
        return true
      }

      if (event.shiftKey && event.key.toLowerCase() === 'c') {
        const map = buildDocumentMap(valueRef.current)
        const range = selectionLineRange(host, map)
        if (!range) return false
        const next = checklistToPlainText(valueRef.current, range.startLine)
        if (next === valueRef.current) return false
        commit(next, { type: 'caret', line: range.startLine, offset: range.caretOffset })
        return true
      }

      return false
    }

    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (!target || target.closest('input, textarea, select')) return
      if (!target.closest('.mdxeditor-root-contenteditable')) return
      if (runCommand(event)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    host.addEventListener('keydown', handler, true)
    host.addEventListener('notes-mute-toggle', muteSelection)
    return () => {
      host.removeEventListener('keydown', handler, true)
      host.removeEventListener('notes-mute-toggle', muteSelection)
    }
  }, [lexicalEditorRef])

  function focusEditor(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement
    if (target.closest('.mdxeditor-toolbar, [contenteditable]:not([contenteditable="false"])')) return
    editorRef.current?.focus()
  }

  const plugins = useMemo(() => mdxEditorPlugins(lexicalEditorRef), [lexicalEditorRef])

  return <div className="notes-mdx-editor" ref={hostRef} onClick={focusEditor}>
    <MDXEditor
      ref={editorRef}
      markdown={markdownForEditor(value).markdown}
      autoFocus={autoFocus}
      toMarkdownOptions={{ bullet: '-' }}
      onChange={(markdown) => {
        if (!userInteractedRef.current) return
        const tight = restoreMarkdownSpacing(valueRef.current, markdown)
        const restored = preserveMutedLines(valueRef.current, tight)
        if (restored === valueRef.current) return
        valueRef.current = restored
        onChangeRef.current(restored)
        refreshDecorationsRef.current()
      }}
      plugins={plugins}
    />
  </div>
}
