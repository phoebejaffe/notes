import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { MDXEditor, type MDXEditorMethods } from '@mdxeditor/editor'
import { parseMarkdown, removeTagAtPosition, toggleMutedLines } from '../markerEngine'
import { EditorActionsProvider } from './editorActions'
import { mdxEditorPlugins } from './mdxEditorPlugins'
import { commentsToTagDirectives } from './tagSyntax'
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
  if (content.querySelector('.notes-tag-directive')) return
  const blocks = [...content.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,li,blockquote,pre,p:not(li p):not(blockquote p)')]
  const lines = source.split('\n')
  const parsed = parseMarkdown(source)
  let previousTags = ''
  let sourceSearchStart = 0
  const blockLines = new Map<HTMLElement, number>()
  blocks.forEach((block) => {
    const blockText = block.textContent?.replace(/\s+/gu, ' ').trim() ?? ''
    const lineIndex = lines.findIndex((line, index) => {
      if (index < sourceSearchStart || !line.trim() || /^\s*(?:%%\s+)?<!--[\s\S]*-->\s*$/u.test(line) || /^\s*:::tag\s*\{[^}]*\}\s*$/u.test(line) || /^\s*:::\s*$/u.test(line)) return false
      const sourceText = line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)/u, '').replace(/^\[[ xX]\]\s+/u, '').replace(/<[^>]+>/gu, '').replace(/[\\*_`]/gu, '').replace(/\s+/gu, ' ').trim()
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
    const sourceText = line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)/u, '').replace(/^\[[ xX]\]\s+/u, '').replace(/<[^>]+>/gu, '').replace(/[\\*_`]/gu, '').replace(/\s+/gu, ' ').trim()
    return sourceText && (sourceText.includes(normalized) || normalized.includes(sourceText))
  })
}

function restoreEditorSelection(root: HTMLElement | null, selectedText: string, blockText: string) {
  const content = root?.querySelector<HTMLElement>('.mdxeditor-root-contenteditable')
  if (!content || (!selectedText && !blockText)) return
  const target = [...content.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre')].find((element) => {
    const text = element.textContent ?? ''
    return selectedText ? text.includes(selectedText) : text.includes(blockText)
  })
  if (!target) return
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.selectNodeContents(target)
  selection.removeAllRanges()
  selection.addRange(range)
  target.closest<HTMLElement>('[contenteditable="true"]')?.focus()
}

function sourceLineRange(source: string, selectedText: string, caretBlockText: string) {
  const range = selectedSourceRange(source, selectedText)
  if (range) {
    return {
      startLine: source.slice(0, range.from).split('\n').length - 1,
      endLine: source.slice(0, range.to).split('\n').length - 1,
    }
  }
  const line = sourceLineForRenderedText(source, caretBlockText)
  return line < 0 ? undefined : { startLine: line, endLine: line }
}

const RECENT_TAGS_KEY = 'notes-recent-tags'

function loadRecentTags() {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_TAGS_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string') : []
  } catch {
    return []
  }
}

function applyChecklistWidgets(root: HTMLElement | null, source: string, commit: (markdown: string) => void) {
  if (!root) return
  root.querySelectorAll<HTMLElement>('.notes-checklist-checkbox').forEach((input) => input.remove())
  const lines = source.split('\n')
  let searchStart = 0
  root.querySelectorAll<HTMLElement>('li').forEach((item) => {
    const lineIndex = lines.findIndex((line, index) => index >= searchStart && /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+/u.test(line) && sourceLineForRenderedText(line, item.textContent ?? '') >= 0)
    if (lineIndex < 0) return
    searchStart = lineIndex + 1
    const match = lines[lineIndex].match(/^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/u)
    if (!match) return
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.className = 'notes-checklist-checkbox'
    input.checked = match[2].toLowerCase() === 'x'
    input.contentEditable = 'false'
    input.setAttribute('aria-label', input.checked ? 'Mark task incomplete' : 'Mark task complete')
    input.addEventListener('change', () => {
      const nextLines = [...lines]
      nextLines[lineIndex] = `${match[1]}[${input.checked ? 'x' : ' '}]${nextLines[lineIndex].slice(match[0].length)}`
      commit(nextLines.join('\n'))
    })
    item.insertBefore(input, item.firstChild)
  })
}

export function MdxNotesEditor({ value, onChange, autoFocus = false, hideMutedLines = false, tagColors = {}, showUndoRedo = false, rawTextMode = false }: MdxNotesEditorProps) {
  const editorRef = useRef<MDXEditorMethods>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const valueRef = useRef(commentsToTagDirectives(value))
  const onChangeRef = useRef(onChange)
  const selectedTextRef = useRef('')
  const caretBlockTextRef = useRef('')
  const userInteractedRef = useRef(false)
  const suppressChangeRef = useRef(false)
  const [selectionState, setSelectionState] = useState({ text: '', blockText: '' })
  const [recentTags, setRecentTags] = useState<string[]>(loadRecentTags)

  const commit = useMemo(() => (markdown: string) => {
    const selectedText = selectedTextRef.current
    const blockText = caretBlockTextRef.current
    valueRef.current = markdown
    suppressChangeRef.current = true
    editorRef.current?.setMarkdown(markdown)
    onChangeRef.current(markdown)
    window.requestAnimationFrame(() => {
      suppressChangeRef.current = false
      restoreEditorSelection(hostRef.current, selectedText, blockText)
    })
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
    const preserveEditorSelection = (event: globalThis.MouseEvent) => {
      const target = event.target as HTMLElement
      if (target.closest('.mdxeditor-toolbar button')) event.preventDefault()
    }
    host.addEventListener('beforeinput', markInteraction)
    host.addEventListener('keydown', markInteraction)
    host.addEventListener('paste', markInteraction)
    host.addEventListener('click', markInteraction)
    host.addEventListener('mousedown', preserveEditorSelection)
    return () => {
      host.removeEventListener('beforeinput', markInteraction)
      host.removeEventListener('keydown', markInteraction)
      host.removeEventListener('paste', markInteraction)
      host.removeEventListener('click', markInteraction)
      host.removeEventListener('mousedown', preserveEditorSelection)
    }
  }, [])

  useEffect(() => {
    const editorValue = commentsToTagDirectives(value)
    if (valueRef.current === editorValue) return
    valueRef.current = editorValue
    suppressChangeRef.current = true
    editorRef.current?.setMarkdown(editorValue)
    const frame = window.requestAnimationFrame(() => { suppressChangeRef.current = false })
    return () => window.cancelAnimationFrame(frame)
  }, [value])

  useEffect(() => {
    const updateSelection = () => {
      const selection = window.getSelection()
      const content = hostRef.current?.querySelector<HTMLElement>('.mdxeditor-root-contenteditable')
      if (!selection || !content?.contains(selection.anchorNode)) return
      const selectedText = selection.toString()
      const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement
      const blockText = anchor?.closest('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre')?.textContent ?? ''
      selectedTextRef.current = selectedText
      caretBlockTextRef.current = blockText
      setSelectionState({ text: selectedText, blockText })
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
      applyChecklistWidgets(hostRef.current, value, commit)
      attempts += 1
      if (attempts < 30) frame = window.requestAnimationFrame(apply)
    }
    frame = window.requestAnimationFrame(apply)
    const retry = window.setTimeout(apply, 600)
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
      window.clearTimeout(retry)
    }
  }, [commit, hideMutedLines, tagColors, value])

  const selectionLines = useMemo(() => sourceLineRange(value, selectionState.text, selectionState.blockText), [selectionState, value])
  const activeTags = useMemo(() => {
    if (!selectionLines) return []
    const parsed = parseMarkdown(value)
    return [...new Set(parsed.ranges.filter((range) => range.startLine <= selectionLines.endLine && range.endLine >= selectionLines.startLine).map((range) => range.tag))]
  }, [selectionLines, value])

  const actions = useMemo(() => ({
    activeTags,
    recentTags,
    showUndoRedo,
    addTag: (tagValue: string) => {
      const tag = tagValue.trim()
      const source = valueRef.current
      const selectedRange = selectedSourceRange(source, selectionState.text)
      const caretLine = selectedRange ? -1 : sourceLineForRenderedText(source, selectionState.blockText)
      const caretLineStart = caretLine >= 0 ? source.split('\n').slice(0, caretLine).reduce((offset, line) => offset + line.length + 1, 0) : -1
      const caretLineEnd = caretLine >= 0 ? caretLineStart + source.split('\n')[caretLine].length : -1
      const range = selectedRange ?? (caretLine >= 0 ? { from: caretLineStart, to: caretLineEnd } : undefined)
      if (!tag || !range) return
      const startLine = source.lastIndexOf('\n', range.from - 1) + 1
      const endLineIndex = source.indexOf('\n', range.to)
      const endLine = endLineIndex < 0 ? source.length : endLineIndex
      const open = `:::tag{name="${tag.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"}`
      const close = ':::'
      commit(`${source.slice(0, startLine)}${open}\n${source.slice(startLine, endLine)}\n${close}${source.slice(endLine)}`)
      const nextRecentTags = [tag, ...recentTags.filter((recent) => recent !== tag)].slice(0, 12)
      setRecentTags(nextRecentTags)
      localStorage.setItem(RECENT_TAGS_KEY, JSON.stringify(nextRecentTags))
    },
    removeTag: (tag: string) => {
      if (!selectionLines) return
      const result = removeTagAtPosition(valueRef.current, selectionLines.startLine, tag)
      if (!result.error) commit(result.source)
    },
    toggleMute: () => {
      const source = valueRef.current
      const range = selectedSourceRange(source, selectionState.text)
      if (range) {
        const startLine = source.slice(0, range.from).split('\n').length - 1
        const endLine = source.slice(0, range.to).split('\n').length - 1
        commit(toggleMutedLines(source, startLine, endLine).source)
        return
      }
      const line = sourceLineForRenderedText(source, selectionState.blockText)
      if (line >= 0) commit(toggleMutedLines(source, line, line).source)
    },
  }), [activeTags, commit, recentTags, selectionLines, selectionState, showUndoRedo])

  function focusEditor(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement
    if (target.closest('.mdxeditor-toolbar, [contenteditable="true"]')) return
    editorRef.current?.focus()
  }

  function handleEditorKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === '/') {
      event.preventDefault()
      actions.toggleMute()
    }
  }

  if (rawTextMode) return <div className="notes-mdx-editor notes-raw-mode" ref={hostRef}><textarea className="notes-raw-editor" value={value} autoFocus={autoFocus} spellCheck={false} onChange={(event) => { valueRef.current = event.target.value; onChangeRef.current(event.target.value) }} /></div>

  return <div className="notes-mdx-editor" ref={hostRef} onClick={focusEditor} onKeyDown={handleEditorKeyDown}>
    <EditorActionsProvider value={actions}>
      <MDXEditor
        ref={editorRef}
        markdown={commentsToTagDirectives(value)}
        autoFocus={autoFocus}
        onChange={(markdown) => {
          if (!userInteractedRef.current || suppressChangeRef.current) return
          valueRef.current = markdown
          onChangeRef.current(markdown)
        }}
        plugins={mdxEditorPlugins()}
      />
    </EditorActionsProvider>
  </div>
}
