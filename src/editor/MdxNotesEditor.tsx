import { useEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent } from 'react'
import { MDXEditor, type MDXEditorMethods } from '@mdxeditor/editor'
import { parseMarkdown, toggleMutedLines } from '../markerEngine'
import { EditorActionsProvider } from './editorActions'
import { mdxEditorPlugins } from './mdxEditorPlugins'
import { preserveMarkerLines } from './markdownSourcePreservation'
import type { MdxNotesEditorProps } from './editorTypes'

function suppressMutedPrefix(element: HTMLElement) {
  if (element.querySelector(':scope > .notes-muted-prefix')) return
  const textNode = [...element.childNodes].find((node): node is Text => node.nodeType === Node.TEXT_NODE && node.textContent?.trimStart().startsWith('%%') === true)
  if (!textNode?.textContent) return
  const leadingWhitespace = textNode.textContent.match(/^\s*/u)?.[0] ?? ''
  const prefixLength = leadingWhitespace.length + 2 + (textNode.textContent[leadingWhitespace.length + 2] === ' ' ? 1 : 0)
  const prefix = document.createElement('span')
  prefix.className = 'notes-muted-prefix'
  prefix.contentEditable = 'false'
  prefix.setAttribute('aria-hidden', 'true')
  prefix.textContent = textNode.textContent.slice(0, prefixLength)
  textNode.textContent = textNode.textContent.slice(prefixLength)
  textNode.parentNode?.insertBefore(prefix, textNode)
}

function applyMutedVisibility(root: HTMLElement | null, hidden: boolean) {
  if (!root) return
  root.querySelectorAll<HTMLElement>('[data-prototype-muted="true"], p, li, blockquote').forEach((element) => {
    const muted = element.matches('[data-prototype-muted="true"]') || element.textContent?.trimStart().startsWith('%%')
    element.classList.toggle('notes-muted-block', muted)
    if (muted) {
      suppressMutedPrefix(element)
      element.hidden = hidden
    }
  })
}

function tagColor(tag: string, colors: Record<string, string>) {
  if (colors[tag]) return colors[tag]
  const palette = ['#6d9b91', '#8975aa', '#c88968', '#7190b0', '#b28a55']
  return palette[[...tag].reduce((sum, character) => sum + character.codePointAt(0)!, 0) % palette.length]
}

function applyTagDecorations(root: HTMLElement | null, source: string, colors: Record<string, string>) {
  const content = root?.querySelector<HTMLElement>('.mdxeditor-root-contenteditable')
  if (!root || !content) return
  root.querySelectorAll<HTMLElement>('.notes-tag-border-overlay').forEach((element) => element.remove())
  content.querySelectorAll<HTMLElement>('[data-notes-tagged], [data-notes-tag-chip]').forEach((element) => {
    element.removeAttribute('data-notes-tagged')
    element.removeAttribute('data-notes-tag-color')
    element.style.removeProperty('--notes-tag-color')
    element.removeAttribute('data-notes-tag-chip')
  })
  const blocks = [...content.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre')]
  const lines = source.split('\n')
  const parsed = parseMarkdown(source)
  let previousTags = ''
  let sourceSearchStart = 0
  const blockLines = new Map<HTMLElement, number>()
  blocks.forEach((block) => {
    const blockText = block.textContent?.replace(/\s+/gu, ' ').trim() ?? ''
    const lineIndex = lines.findIndex((line, index) => {
      if (index < sourceSearchStart || !line.trim() || /^\s*(?:%%\s+)?<!--[\s\S]*-->\s*$/u.test(line)) return false
      const sourceText = line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)/u, '').replace(/<[^>]+>/gu, '').replace(/[\\*_`]/gu, '').replace(/\s+/gu, ' ').trim()
      return sourceText && (blockText.includes(sourceText) || sourceText.includes(blockText))
    })
    if (lineIndex < 0) return
    sourceSearchStart = lineIndex + 1
    blockLines.set(block, lineIndex)
    const tags = parsed.ranges.filter((range) => range.startLine < lineIndex && lineIndex < range.endLine).map((range) => range.tag)
    if (!tags.length) { previousTags = ''; return }
    const tagValue = tags.join(', ')
    block.dataset.notesTagged = tagValue
    const color = tagColor(tags[0], colors)
    block.dataset.notesTagColor = color
    block.style.setProperty('--notes-tag-color', color)
    if (tagValue !== previousTags) {
      const chipTarget = block.tagName === 'LI' ? block.closest<HTMLElement>('ul,ol') ?? block : block
      chipTarget.dataset.notesTagChip = tagValue
      chipTarget.style.setProperty('--notes-tag-color', color)
    }
    previousTags = tagValue
  })

  const rootRect = root.getBoundingClientRect()
  parsed.ranges.forEach((range) => {
    const taggedBlocks = [...blockLines.entries()].filter(([, lineIndex]) => range.startLine < lineIndex && lineIndex < range.endLine).map(([block]) => block)
    if (!taggedBlocks.length) return
    const firstBlock = taggedBlocks[0]
    const lastBlock = taggedBlocks[taggedBlocks.length - 1]
    const firstRect = (firstBlock.tagName === 'LI' ? firstBlock.closest<HTMLElement>('ul,ol') : firstBlock)?.getBoundingClientRect() ?? firstBlock.getBoundingClientRect()
    const lastRect = (lastBlock.tagName === 'LI' ? lastBlock.closest<HTMLElement>('ul,ol') : lastBlock)?.getBoundingClientRect() ?? lastBlock.getBoundingClientRect()
    const overlay = document.createElement('span')
    overlay.className = 'notes-tag-border-overlay'
    overlay.style.left = '0px'
    overlay.style.top = `${firstRect.top - rootRect.top}px`
    overlay.style.height = `${lastRect.bottom - firstRect.top}px`
    overlay.style.backgroundColor = tagColor(range.tag, colors)
    root.appendChild(overlay)
  })
}

function selectedSourceRange(source: string, selectedText: string) {
  if (!selectedText) return undefined
  const from = source.indexOf(selectedText)
  if (from < 0) return undefined
  return { from, to: from + selectedText.length }
}

function sourceLineForRenderedText(source: string, renderedText: string) {
  const normalized = renderedText.replace(/\s+/gu, ' ').trim()
  if (!normalized) return -1
  return source.split('\n').findIndex((line) => {
    const sourceText = line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)/u, '').replace(/<[^>]+>/gu, '').replace(/[\\*_`]/gu, '').replace(/\s+/gu, ' ').trim()
    return sourceText && (sourceText.includes(normalized) || normalized.includes(sourceText))
  })
}

export function MdxNotesEditor({ value, onChange, autoFocus = false, hideMutedLines = false, tagColors = {}, showUndoRedo = false }: MdxNotesEditorProps) {
  const editorRef = useRef<MDXEditorMethods>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const valueRef = useRef(value)
  const onChangeRef = useRef(onChange)
  const selectedTextRef = useRef('')
  const caretBlockTextRef = useRef('')
  const userInteractedRef = useRef(false)
  const suppressChangeRef = useRef(false)

  const commit = useMemo(() => (markdown: string) => {
    valueRef.current = markdown
    suppressChangeRef.current = true
    editorRef.current?.setMarkdown(markdown)
    onChangeRef.current(markdown)
    window.requestAnimationFrame(() => { suppressChangeRef.current = false })
  }, [])

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
    host.addEventListener('click', markInteraction)
    return () => {
      host.removeEventListener('beforeinput', markInteraction)
      host.removeEventListener('keydown', markInteraction)
      host.removeEventListener('paste', markInteraction)
      host.removeEventListener('click', markInteraction)
    }
  }, [])

  useEffect(() => {
    if (valueRef.current === value) return
    valueRef.current = value
    suppressChangeRef.current = true
    editorRef.current?.setMarkdown(value)
    const frame = window.requestAnimationFrame(() => { suppressChangeRef.current = false })
    return () => window.cancelAnimationFrame(frame)
  }, [value])

  useEffect(() => {
    const updateSelection = () => {
      const selection = window.getSelection()
      if (!selection || !hostRef.current?.contains(selection.anchorNode)) return
      selectedTextRef.current = selection.toString()
      const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement
      caretBlockTextRef.current = anchor?.closest('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre')?.textContent ?? ''
    }
    document.addEventListener('selectionchange', updateSelection)
    return () => document.removeEventListener('selectionchange', updateSelection)
  }, [])

  useEffect(() => {
    let cancelled = false
    let attempts = 0
    let frame = 0
    const apply = () => {
      if (cancelled) return
      applyMutedVisibility(hostRef.current, hideMutedLines)
      applyTagDecorations(hostRef.current, value, tagColors)
      attempts += 1
      if (attempts < 8) frame = window.requestAnimationFrame(apply)
    }
    frame = window.requestAnimationFrame(apply)
    const retry = window.setTimeout(apply, 150)
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
      window.clearTimeout(retry)
    }
  }, [hideMutedLines, tagColors, value])

  const actions = useMemo(() => ({
    showUndoRedo,
    addTag: (tagValue: string) => {
      const tag = tagValue.trim()
      const range = selectedSourceRange(valueRef.current, selectedTextRef.current)
      if (!tag || !range) return
      const source = valueRef.current
      const startLine = source.lastIndexOf('\n', range.from - 1) + 1
      const endLineIndex = source.indexOf('\n', range.to)
      const endLine = endLineIndex < 0 ? source.length : endLineIndex
      const open = `<!-- ${tag} -->`
      const close = `<!-- /${tag} -->`
      commit(`${source.slice(0, startLine)}${open}\n${source.slice(startLine, endLine)}\n${close}${source.slice(endLine)}`)
    },
    toggleMute: () => {
      const source = valueRef.current
      const range = selectedSourceRange(source, selectedTextRef.current)
      if (range) {
        const startLine = source.slice(0, range.from).split('\n').length - 1
        const endLine = source.slice(0, range.to).split('\n').length - 1
        commit(toggleMutedLines(source, startLine, endLine).source)
        return
      }
      const line = sourceLineForRenderedText(source, caretBlockTextRef.current)
      if (line >= 0) commit(toggleMutedLines(source, line, line).source)
    },
  }), [commit, showUndoRedo])

  function focusEditor(event: MouseEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest('.mdxeditor-toolbar')) return
    editorRef.current?.focus()
  }

  function handleEditorKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === '/') {
      event.preventDefault()
      actions.toggleMute()
    }
  }

  return <div className="notes-mdx-editor" ref={hostRef} onClick={focusEditor} onKeyDown={handleEditorKeyDown}>
    <EditorActionsProvider value={actions}>
      <MDXEditor
        ref={editorRef}
        markdown={value}
        autoFocus={autoFocus}
        onChange={(markdown) => {
          if (!userInteractedRef.current || suppressChangeRef.current) return
          const preserved = preserveMarkerLines(valueRef.current, markdown)
          valueRef.current = preserved
          onChangeRef.current(preserved)
        }}
        plugins={mdxEditorPlugins()}
      />
    </EditorActionsProvider>
  </div>
}
