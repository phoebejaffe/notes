import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { MDXEditor, type MDXEditorMethods } from '@mdxeditor/editor'
import { $createParagraphNode, $getNodeByKey, $getNodeFromDOMNode, $getRoot, $getSelection, $setSelection, $isRangeSelection, type LexicalEditor } from 'lexical'
import { checklistToPlainText, moveLines, parseMarkdown, preserveMutedLines, removeChecklist, removeTagAtPosition, toggleChecklist, toggleMutedLines } from '../markerEngine'
import { EditorActionsProvider } from './editorActions'
import { mdxEditorPlugins } from './mdxEditorPlugins'
import { commentsToTagDirectives } from './tagSyntax'
import { comparableLineText, markdownForEditor, restoreMarkdownSpacing, sourceLineRangeForRenderedSelection } from './markdownSourcePreservation'
import { $isTagBlockNode } from './TagBlockNode'
import { AudioPlayerPopover } from './AudioPlayerPopover'
import type { MdxNotesEditorProps } from './editorTypes'

function isAudioRecordingUrl(href: string | null | undefined): boolean {
  if (!href) return false
  try {
    const url = new URL(href)
    return url.hostname === 'us-central1-pebble-ring-sync-20260911.cloudfunctions.net' && url.pathname.startsWith('/recordingAudio')
  } catch {
    return false
  }
}

function suppressMutedMarkers(element: HTMLElement, hidden: boolean) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let textNode = walker.nextNode() as Text | null
  while (textNode) {
    if (!textNode.parentElement?.closest('.notes-muted-prefix, .notes-muted-line')) nodes.push(textNode)
    textNode = walker.nextNode() as Text | null
  }

  nodes.forEach((node) => {
    const text = node.textContent ?? ''
    const matches = [...text.matchAll(/(^|\n)(\s*%%\s?)/gu)]
    if (!matches.length) return

    const fragment = document.createDocumentFragment()
    let cursor = 0
    matches.forEach((match) => {
      const markerStart = match.index + match[1].length
      const markerEnd = markerStart + match[2].length
      const nextLine = text.indexOf('\n', markerEnd)
      const lineEnd = nextLine < 0 ? text.length : nextLine
      fragment.append(text.slice(cursor, markerStart))

      const prefix = document.createElement('span')
      prefix.className = 'notes-muted-prefix'
      prefix.contentEditable = 'false'
      prefix.setAttribute('aria-hidden', 'true')
      prefix.textContent = text.slice(markerStart, markerEnd)
      fragment.append(prefix)

      const line = document.createElement('span')
      line.className = 'notes-muted-line'
      line.hidden = hidden
      line.textContent = text.slice(markerEnd, lineEnd)
      fragment.append(line)
      cursor = lineEnd
    })
    fragment.append(text.slice(cursor))
    node.replaceWith(fragment)
  })
}

function refreshMutedHighlights(hidden: boolean) {
  if (typeof CSS === 'undefined' || !CSS.highlights) return
  const lineRanges: Range[] = []

  document.querySelectorAll<HTMLElement>('.mdxeditor-root-contenteditable').forEach((content) => {
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
    let textNode = walker.nextNode() as Text | null
    while (textNode) {
      if (!textNode.parentElement?.closest('.notes-muted-prefix')) {
        const text = textNode.textContent ?? ''
        for (const match of text.matchAll(/(^|\n)\s*%%\s?/gu)) {
          const lineStart = match.index + match[1].length
          const nextLine = text.indexOf('\n', lineStart)
          const lineEnd = nextLine < 0 ? text.length : nextLine
          const range = document.createRange()
          range.setStart(textNode, lineStart)
          range.setEnd(textNode, lineEnd)
          lineRanges.push(range)
        }
      }
      textNode = walker.nextNode() as Text | null
    }
  })

  CSS.highlights.set('notes-muted-line', new Highlight(...(hidden ? [] : lineRanges)))
  CSS.highlights.set('notes-muted-line-hidden', new Highlight(...(hidden ? lineRanges : [])))
}

function applyMutedVisibility(root: HTMLElement | null, hidden: boolean) {
  if (!root) return
  const selection = window.getSelection()
  const savedRange = selection?.rangeCount && selection.anchorNode && root.contains(selection.anchorNode)
    ? selection.getRangeAt(0).cloneRange()
    : null
  root.querySelectorAll<HTMLElement>('[data-prototype-muted="true"], h1, h2, h3, h4, h5, h6, p, li, blockquote').forEach((element) => {
    const renderedText = element.textContent ?? ''
    const hasMutedLine = /(?:^|\n)\s*%%(?:\s|$)/u.test(renderedText)
    const contentLines = renderedText.split('\n').filter((line) => line.trim())
    const allContentMuted = contentLines.length > 0 && contentLines.every((line) => /^\s*%%(?:\s|$)/u.test(line))
    const blockMuted = element.matches('[data-prototype-muted="true"]') || allContentMuted
    element.classList.toggle('notes-muted-block', blockMuted)
    if (hasMutedLine && allContentMuted) suppressMutedMarkers(element, hidden)
    if (element.hidden !== (blockMuted && hidden)) element.hidden = blockMuted && hidden
  })
  refreshMutedHighlights(hidden)
  if (savedRange && selection && savedRange.startContainer.isConnected && savedRange.endContainer.isConnected) {
    selection.removeAllRanges()
    selection.addRange(savedRange)
  }
}

function tagColor(tag: string, colors: Record<string, string>) {
  if (colors[tag]) return colors[tag]
  const palette = ['#6d9b91', '#8975aa', '#c88968', '#7190b0', '#b28a55']
  return palette[[...tag].reduce((sum, character) => sum + character.codePointAt(0)!, 0) % palette.length]
}

function setAttr(element: HTMLElement, name: string, value: string | undefined) {
  if (value === undefined) {
    if (element.hasAttribute(name)) element.removeAttribute(name)
  } else if (element.getAttribute(name) !== value) element.setAttribute(name, value)
}

function setTagColorStyle(element: HTMLElement, color: string | undefined) {
  const current = element.style.getPropertyValue('--notes-tag-color')
  if (color === undefined) {
    if (current) element.style.removeProperty('--notes-tag-color')
  } else if (current !== color) element.style.setProperty('--notes-tag-color', color)
}

function applyTagDecorations(root: HTMLElement | null, source: string, colors: Record<string, string>) {
  const content = root?.querySelector<HTMLElement>('.mdxeditor-root-contenteditable')
  if (!root || !content) return
  root.querySelectorAll<HTMLElement>('.notes-tag-border-overlay').forEach((element) => element.remove())
  const desired = new Map<HTMLElement, { tagged?: string; chip?: string; color?: string }>()
  const want = (element: HTMLElement) => {
    const entry = desired.get(element) ?? {}
    desired.set(element, entry)
    return entry
  }
  if (!content.querySelector('.notes-tag-directive')) {
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
        const sourceText = comparableLineText(line)
        return sourceText && (blockText.includes(sourceText) || sourceText.includes(blockText))
      })
      if (lineIndex < 0) return
      sourceSearchStart = lineIndex + 1
      blockLines.set(block, lineIndex)
      const tags = parsed.ranges.filter((range) => range.startLine < lineIndex && lineIndex < range.endLine).map((range) => range.tag)
      if (!tags.length) { previousTags = ''; return }
      const tagValue = tags.join(', ')
      const color = tagColor(tags[0], colors)
      const entry = want(block)
      entry.tagged = tagValue
      entry.color = color
      if (tagValue !== previousTags) {
        const chipTarget = block.tagName === 'LI' ? block.closest<HTMLElement>('ul,ol') ?? block : block
        const chipEntry = want(chipTarget)
        chipEntry.chip = tagValue
        chipEntry.color = color
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
  const decorated = new Set(content.querySelectorAll<HTMLElement>('[data-notes-tagged], [data-notes-tag-chip]'))
  desired.forEach((entry, element) => {
    decorated.delete(element)
    setAttr(element, 'data-notes-tagged', entry.tagged)
    setAttr(element, 'data-notes-tag-color', entry.tagged ? entry.color : undefined)
    setAttr(element, 'data-notes-tag-chip', entry.chip)
    setTagColorStyle(element, entry.color)
  })
  decorated.forEach((element) => {
    setAttr(element, 'data-notes-tagged', undefined)
    setAttr(element, 'data-notes-tag-color', undefined)
    setAttr(element, 'data-notes-tag-chip', undefined)
    setTagColorStyle(element, undefined)
  })
}

function readRenderedSelection(root: HTMLElement | null) {
  const content = root?.querySelector<HTMLElement>('.mdxeditor-root-contenteditable')
  const selection = window.getSelection()
  if (!content || !selection || !content.contains(selection.anchorNode)) return undefined
  const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement
  const block = anchor?.closest<HTMLElement>('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre')
  let caretOffset = 0
  const caretText = selection.isCollapsed && selection.anchorNode?.nodeType === Node.TEXT_NODE
    ? selection.anchorNode.textContent ?? ''
    : block?.textContent ?? ''
  let caretTextOffset = 0
  if (block && selection.isCollapsed) {
    const range = document.createRange()
    range.selectNodeContents(block)
    range.setEnd(selection.anchorNode!, selection.anchorOffset)
    caretOffset = range.toString().length
    caretTextOffset = selection.anchorNode?.nodeType === Node.TEXT_NODE ? selection.anchorOffset : caretOffset
  }
  return { text: selection.toString(), blockText: block?.textContent ?? '', caretOffset, caretText, caretTextOffset }
}

function selectedSourceRange(source: string, selectedText: string) {
  if (!selectedText) return undefined
  const from = source.indexOf(selectedText)
  if (from >= 0) return { from, to: from + selectedText.length }
  const lineRange = sourceLineRangeForRenderedSelection(source, selectedText)
  if (!lineRange) return undefined
  const lines = source.split('\n')
  const lineStart = lines.slice(0, lineRange.startLine).reduce((offset, line) => offset + line.length + 1, 0)
  const lineEnd = lineStart + lines.slice(lineRange.startLine, lineRange.endLine + 1).join('\n').length
  return { from: lineStart, to: lineEnd }
}

function restoreEditorSelection(editor: LexicalEditor | null, root: HTMLElement | null, selectedText: string, blockText: string, caretOffset: number, caretText: string, caretTextOffset: number) {
  const content = root?.querySelector<HTMLElement>('.mdxeditor-root-contenteditable')
  if (!content || (!selectedText && !blockText)) return
  const selection = window.getSelection()
  if (!selection) return
  const blocks = [...content.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre')]
  let target = blocks.find((element) => {
    const text = element.textContent ?? ''
    return selectedText ? text.includes(selectedText) : text.includes(caretText || blockText)
  })
  const nodes: Text[] = []
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    nodes.push(node as Text)
    node = walker.nextNode()
  }
  if (!nodes.length) return
  const locate = (text: string, fromEnd = false) => {
    const ordered = fromEnd ? [...nodes].reverse() : nodes
    for (const textNode of ordered) {
      const value = textNode.textContent ?? ''
      const index = fromEnd ? value.lastIndexOf(text) : value.indexOf(text)
      if (index >= 0) return { node: textNode, offset: fromEnd ? index + text.length : index }
    }
    return undefined
  }
  const range = document.createRange()
  if (selectedText) {
    const exactTarget = target && locate(selectedText)
    if (exactTarget) {
      const end = locate(selectedText, true)
      if (!end) return
      range.setStart(exactTarget.node, exactTarget.offset)
      range.setEnd(end.node, end.offset)
    } else {
      const chunks = selectedText.trim().split(/\n+/u).map((chunk) => chunk.trim()).filter(Boolean)
      const firstChunk = chunks[0] ?? ''
      const lastChunk = chunks.at(-1) ?? ''
      const start = locate(firstChunk) ?? locate(firstChunk.split(/\s+/u)[0] ?? '')
      const end = locate(lastChunk, true) ?? locate(lastChunk.split(/\s+/u).at(-1) ?? '', true)
      if (!start || !end) return
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)
    }
  } else {
    let fallbackCaretOffset: number | undefined
    if (!target) {
      const nextToken = blockText.slice(Math.min(caretOffset, blockText.length)).match(/\S+/u)?.[0]
      const previousToken = blockText.slice(0, Math.min(caretOffset, blockText.length)).match(/\S+$/u)?.[0]
      const token = nextToken ?? previousToken
      if (token) {
        target = blocks.find((element) => (element.textContent ?? '').includes(token))
        fallbackCaretOffset = nextToken ? (target?.textContent ?? '').indexOf(token) : (target?.textContent ?? '').indexOf(token) + token.length
      }
      if (!target || fallbackCaretOffset === undefined || fallbackCaretOffset < 0) return
    }
    const targetNodes: Text[] = []
    const targetWalker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
    let targetNode = targetWalker.nextNode()
    while (targetNode) {
      targetNodes.push(targetNode as Text)
      targetNode = targetWalker.nextNode()
    }
    const caretTextStart = caretText ? (target.textContent ?? '').indexOf(caretText) : -1
    let remaining = Math.max(0, fallbackCaretOffset ?? (caretTextStart >= 0 ? caretTextStart + caretTextOffset : caretOffset))
    const caretNode = targetNodes.find((textNode) => {
      const length = textNode.textContent?.length ?? 0
      if (remaining <= length) return true
      remaining -= length
      return false
    })
    if (!caretNode) return
    range.setStart(caretNode, remaining)
    range.collapse(true)
  }
  selection.removeAllRanges()
  selection.addRange(range)
  if (editor && range.startContainer.nodeType === Node.TEXT_NODE) {
    const domNode = range.startContainer as Text
    editor.update(() => {
      const lexicalNode = $getNodeFromDOMNode(domNode)
      const lexicalSelection = $getSelection()
      if (lexicalNode && lexicalNode.getType() === 'text' && $isRangeSelection(lexicalSelection)) {
        lexicalSelection.anchor.set(lexicalNode.getKey(), range.startOffset, 'text')
        lexicalSelection.focus.set(lexicalNode.getKey(), range.startOffset, 'text')
      }
    })
  }
}

function sourceLineForRenderedCaret(source: string, renderedBlockText: string, caretOffset: number) {
  const normalizedBlock = renderedBlockText.replace(/%%\s*/gu, '').replace(/\s+/gu, ' ').trim()
  if (normalizedBlock) {
    const exactLine = source.split('\n').findIndex((line) => {
      const comparable = comparableLineText(line).replace(/^%%\s+/u, '')
      return comparable === normalizedBlock
    })
    if (exactLine >= 0) return exactLine
    const blockRange = sourceLineRangeForRenderedSelection(source, renderedBlockText)
    if (blockRange) {
      let renderedOffset = 0
      const lines = source.split('\n')
      for (let lineIndex = blockRange.startLine; lineIndex <= blockRange.endLine; lineIndex += 1) {
        const comparable = comparableLineText(lines[lineIndex]).replace(/^%%\s+/u, '')
        if (!comparable) continue
        if (caretOffset <= renderedOffset + comparable.length) return lineIndex
        renderedOffset += comparable.length + 1
      }
      return blockRange.endLine
    }
  }
  const lines = source.split('\n')
  let renderedOffset = 0
  let lastLine = -1
  for (const [lineIndex, line] of lines.entries()) {
    const comparable = comparableLineText(line)
    if (!comparable) continue
    const lineEnd = renderedOffset + comparable.length
    if (caretOffset <= lineEnd) return lineIndex
    renderedOffset = lineEnd + 1
    lastLine = lineIndex
  }
  return lastLine
}

function sourceLineRange(source: string, selectedText: string, blockText: string, caretOffset = 0) {
  const range = selectedSourceRange(source, selectedText)
  if (range) {
    return {
      startLine: source.slice(0, range.from).split('\n').length - 1,
      endLine: source.slice(0, range.to).split('\n').length - 1,
    }
  }
  const line = sourceLineForRenderedCaret(source, blockText, caretOffset)
  return line < 0 ? undefined : { startLine: line, endLine: line }
}

const RECENT_TAGS_KEY = 'notes-recent-tags'

// Top-level editable blocks. Paragraphs nested in list items, blockquotes, or
// tag directives are part of their container block, so they're excluded.
const TOP_LEVEL_BLOCK_SELECTOR = '.notes-tag-directive, h1,h2,h3,h4,h5,h6,li,blockquote,pre,p:not(li p):not(blockquote p):not(.notes-tag-directive p)'

function topLevelBlocks(content: HTMLElement | null | undefined) {
  return [...content?.querySelectorAll<HTMLElement>(TOP_LEVEL_BLOCK_SELECTOR) ?? []]
}

function loadRecentTags() {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_TAGS_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string') : []
  } catch {
    return []
  }
}

export function MdxNotesEditor({ value, onChange, autoFocus = false, hideMutedLines = false, tagColors = {}, showUndoRedo = false, rawTextMode = false, taskShortcut = 'Mod-Shift-c' }: MdxNotesEditorProps) {
  const editorRef = useRef<MDXEditorMethods>(null)
  const [lexicalEditor, setLexicalEditor] = useState<LexicalEditor | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const valueRef = useRef(commentsToTagDirectives(value))
  const onChangeRef = useRef(onChange)
  const selectedTextRef = useRef('')
  const caretBlockTextRef = useRef('')
  const caretOffsetRef = useRef(0)
  const caretTextRef = useRef('')
  const caretTextOffsetRef = useRef(0)
  const userInteractedRef = useRef(false)
  const suppressChangeRef = useRef(false)
  const programmaticMarkdownRef = useRef<string | null>(null)
  const [selectionState, setSelectionState] = useState({ text: '', blockText: '', caretOffset: 0 })
  const [audioPopover, setAudioPopover] = useState<{ url: string; rect: DOMRect } | null>(null)
  const [recentTags, setRecentTags] = useState<string[]>(loadRecentTags)
  const boundaryParagraphRef = useRef<{ key: string; armed: boolean } | null>(null)

  const commit = useMemo(() => (markdown: string) => {
    const selectedText = selectedTextRef.current
    const blockText = caretBlockTextRef.current
    const caretOffset = caretOffsetRef.current
    const caretText = caretTextRef.current
    const caretTextOffset = caretTextOffsetRef.current
    valueRef.current = markdown
    programmaticMarkdownRef.current = markdown
    suppressChangeRef.current = true
    editorRef.current?.setMarkdown(markdownForEditor(markdown))
    onChangeRef.current(markdown)
    window.requestAnimationFrame(() => {
      restoreEditorSelection(lexicalEditor, hostRef.current, selectedText, blockText, caretOffset, caretText, caretTextOffset)
      window.requestAnimationFrame(() => {
        restoreEditorSelection(lexicalEditor, hostRef.current, selectedText, blockText, caretOffset, caretText, caretTextOffset)
        suppressChangeRef.current = false
      })
    })
  }, [lexicalEditor])

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const markInteraction = (event: Event) => {
      if (host.contains(event.target as Node)) {
        userInteractedRef.current = true
        if (event.type === 'beforeinput' || event.type === 'keydown' || event.type === 'paste') programmaticMarkdownRef.current = null
      }
    }
    const preserveEditorSelection = (event: globalThis.MouseEvent) => {
      const target = event.target as HTMLElement
      if (target.closest('.mdxeditor-toolbar button')) event.preventDefault()
    }
    const handleFocusEdge = (event: Event) => {
      const detail = (event as CustomEvent).detail as { direction: 'up' | 'down' } | undefined
      const direction = detail?.direction ?? 'down'
      userInteractedRef.current = true
      const textarea = host.querySelector<HTMLTextAreaElement>('.notes-raw-editor')
      if (textarea) {
        textarea.focus()
        textarea.setSelectionRange(direction === 'up' ? textarea.value.length : 0, direction === 'up' ? textarea.value.length : 0)
        return
      }
      const editor = lexicalEditor
      if (!editor) return
      editor.update(() => {
        const root = $getRoot()
        // ArrowUp lands on the last non-empty child — the last visible line —
        // skipping the empty trailing paragraph Lexical appends after
        // directives and other non-paragraph blocks.
        const children = root.getChildren()
        const target = direction === 'up'
          ? children.findLast((child) => child.getTextContent().length) ?? children[children.length - 1]
          : children[0]
        if (!target) return
        if ($isTagBlockNode(target)) {
          const tagChildren = target.getChildren()
          const child = direction === 'up'
            ? tagChildren.findLast((nested) => nested.getTextContent().length) ?? tagChildren[tagChildren.length - 1]
            : tagChildren[0]
          if (direction === 'up') child?.selectEnd()
          else child?.selectStart()
        } else if (direction === 'up') {
          target.selectEnd()
        } else {
          target.selectStart()
        }
      })
      editor.focus()
    }
    host.addEventListener('beforeinput', markInteraction)
    host.addEventListener('keydown', markInteraction)
    host.addEventListener('paste', markInteraction)
    host.addEventListener('pointerdown', markInteraction, true)
    host.addEventListener('click', markInteraction)
    host.addEventListener('mousedown', preserveEditorSelection)
    host.addEventListener('notes-focus-edge', handleFocusEdge)
    return () => {
      host.removeEventListener('beforeinput', markInteraction)
      host.removeEventListener('keydown', markInteraction)
      host.removeEventListener('paste', markInteraction)
      host.removeEventListener('pointerdown', markInteraction, true)
      host.removeEventListener('click', markInteraction)
      host.removeEventListener('mousedown', preserveEditorSelection)
      host.removeEventListener('notes-focus-edge', handleFocusEdge)
    }
  }, [lexicalEditor])

  useEffect(() => {
    const editorValue = commentsToTagDirectives(value)
    if (valueRef.current === editorValue) return
    valueRef.current = editorValue
    suppressChangeRef.current = true
    editorRef.current?.setMarkdown(markdownForEditor(editorValue))
    const frame = window.requestAnimationFrame(() => { suppressChangeRef.current = false })
    return () => window.cancelAnimationFrame(frame)
  }, [value])

  useEffect(() => {
    const host = hostRef.current
    const updateSelection = () => {
      const boundary = boundaryParagraphRef.current
      if (boundary?.armed) {
        const content = hostRef.current?.querySelector<HTMLElement>('.mdxeditor-root-contenteditable')
        const first = topLevelBlocks(content)[0]
        const anchor = window.getSelection()?.anchorNode
        if (!first || !anchor || !first.contains(anchor)) {
          boundaryParagraphRef.current = null
          const selectionLeftEditor = !anchor || !content?.contains(anchor)
          lexicalEditor?.update(() => {
            const node = $getNodeByKey(boundary.key)
            if (!node || node.getTextContent().length !== 0) return
            // If the caret moved to another editor, the lexical selection is
            // stale (pointing at this paragraph). Clear it first so removing
            // the node doesn't drag the DOM selection back into this editor.
            if (selectionLeftEditor) $setSelection(null)
            node.remove()
          })
        }
      }
      const selection = window.getSelection()
      const content = hostRef.current?.querySelector<HTMLElement>('.mdxeditor-root-contenteditable')
      const hasSelection = !!selection && !selection.isCollapsed && !!content?.contains(selection.anchorNode)
      host?.classList.toggle('notes-has-selection', hasSelection)
      if (!selection || !content?.contains(selection.anchorNode)) return
      const selectedText = selection.toString()
      const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement
      const block = anchor?.closest<HTMLElement>('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre')
      const blockText = block?.textContent ?? ''
      const caretText = selection.isCollapsed && selection.anchorNode?.nodeType === Node.TEXT_NODE
        ? selection.anchorNode.textContent ?? ''
        : blockText
      const caretTextOffset = selection.isCollapsed && selection.anchorNode?.nodeType === Node.TEXT_NODE
        ? selection.anchorOffset
        : 0
      selectedTextRef.current = selectedText
      caretBlockTextRef.current = blockText
      if (selection.isCollapsed) {
        caretTextRef.current = caretText
        caretTextOffsetRef.current = caretTextOffset
      }
      if (block && selection.isCollapsed) {
        const caretRange = document.createRange()
        caretRange.selectNodeContents(block)
        caretRange.setEnd(selection.anchorNode!, selection.anchorOffset)
        caretOffsetRef.current = caretRange.toString().length
      }
      setSelectionState({ text: selectedText, blockText, caretOffset: caretOffsetRef.current })
    }
    document.addEventListener('selectionchange', updateSelection)
    return () => {
      host?.classList.remove('notes-has-selection')
      document.removeEventListener('selectionchange', updateSelection)
    }
  }, [lexicalEditor])

  useEffect(() => {
    let cancelled = false
    let attempts = 0
    let frame = 0
    const apply = () => {
      if (cancelled) return
      applyMutedVisibility(hostRef.current, hideMutedLines)
      applyTagDecorations(hostRef.current, value, tagColors)
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

  const selectionLines = useMemo(() => sourceLineRange(value, selectionState.text, selectionState.blockText, selectionState.caretOffset), [selectionState, value])
  const activeTags = useMemo(() => {
    if (!selectionLines) return []
    const parsed = parseMarkdown(value)
    return [...new Set(parsed.ranges.filter((range) => range.startLine <= selectionLines.endLine && range.endLine >= selectionLines.startLine).map((range) => range.tag))]
  }, [selectionLines, value])

  const plugins = useMemo(() => mdxEditorPlugins(setLexicalEditor), [])
  const actions = useMemo(() => ({
    activeTags,
    recentTags,
    showUndoRedo,
    addTag: (tagValue: string) => {
      const currentSelection = readRenderedSelection(hostRef.current)
      const selectedText = currentSelection?.text ?? selectionState.text
      const blockText = currentSelection?.blockText ?? selectionState.blockText
      if (currentSelection) {
        caretTextRef.current = currentSelection.caretText
        caretTextOffsetRef.current = currentSelection.caretTextOffset
      }
      const tag = tagValue.trim()
      const source = valueRef.current
      const selectedRange = selectedSourceRange(source, selectedText)
      const caretLine = selectedRange ? -1 : sourceLineForRenderedCaret(source, blockText, currentSelection?.caretOffset ?? caretOffsetRef.current)
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
      const currentSelection = readRenderedSelection(hostRef.current)
      const selectedText = currentSelection?.text ?? selectionState.text
      const blockText = currentSelection?.blockText ?? selectionState.blockText
      if (currentSelection) {
        caretTextRef.current = currentSelection.caretText
        caretTextOffsetRef.current = currentSelection.caretTextOffset
      }
      selectedTextRef.current = selectedText
      const range = selectedSourceRange(source, selectedText)
      if (range) {
        const startLine = source.slice(0, range.from).split('\n').length - 1
        const endLine = source.slice(0, range.to).split('\n').length - 1
        commit(toggleMutedLines(source, startLine, endLine).source)
        return
      }
      const line = sourceLineForRenderedCaret(source, blockText, currentSelection?.caretOffset ?? caretOffsetRef.current)
      if (line >= 0) commit(toggleMutedLines(source, line, line).source)
    },
    toggleChecklist: () => {
      const source = valueRef.current
      const currentSelection = readRenderedSelection(hostRef.current)
      const blockText = currentSelection?.blockText ?? selectionState.blockText
      if (currentSelection) {
        caretTextRef.current = currentSelection.caretText
        caretTextOffsetRef.current = currentSelection.caretTextOffset
      }
      const line = sourceLineForRenderedCaret(source, blockText, currentSelection?.caretOffset ?? caretOffsetRef.current)
      if (line >= 0) commit(toggleChecklist(source, line))
    },
    removeChecklist: () => {
      const source = valueRef.current
      const currentSelection = readRenderedSelection(hostRef.current)
      const blockText = currentSelection?.blockText ?? selectionState.blockText
      if (currentSelection) {
        caretTextRef.current = currentSelection.caretText
        caretTextOffsetRef.current = currentSelection.caretTextOffset
      }
      const line = sourceLineForRenderedCaret(source, blockText, currentSelection?.caretOffset ?? caretOffsetRef.current)
      if (line >= 0) commit(removeChecklist(source, line))
    },
    checklistToPlainText: () => {
      const source = valueRef.current
      const currentSelection = readRenderedSelection(hostRef.current)
      const blockText = currentSelection?.blockText ?? selectionState.blockText
      if (currentSelection) {
        caretTextRef.current = currentSelection.caretText
        caretTextOffsetRef.current = currentSelection.caretTextOffset
      }
      const line = sourceLineForRenderedCaret(source, blockText, currentSelection?.caretOffset ?? caretOffsetRef.current)
      if (line >= 0) commit(checklistToPlainText(source, line))
    },
    moveLines: (direction: 'up' | 'down') => {
      const source = valueRef.current
      const currentSelection = readRenderedSelection(hostRef.current)
      const selectedText = currentSelection?.text ?? selectionState.text
      const blockText = currentSelection?.blockText ?? selectionState.blockText
      if (currentSelection) {
        caretTextRef.current = currentSelection.caretText
        caretTextOffsetRef.current = currentSelection.caretTextOffset
      }
      selectedTextRef.current = selectedText
      const range = selectedSourceRange(source, selectedText)
      const startLine = range ? source.slice(0, range.from).split('\n').length - 1 : sourceLineForRenderedCaret(source, blockText, currentSelection?.caretOffset ?? caretOffsetRef.current)
      const endLine = range ? source.slice(0, range.to).split('\n').length - 1 : startLine
      if (startLine >= 0 && endLine >= startLine) commit(moveLines(source, startLine, endLine, direction))
    },
  }), [activeTags, commit, recentTags, selectionLines, selectionState, showUndoRedo])

  useEffect(() => {
    if (rawTextMode) return
    const host = hostRef.current
    if (!host) return
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey
      const taskShortcutKey = taskShortcut.toLowerCase().split('-').at(-1)
      if (modifier && event.shiftKey && !event.altKey && event.key.toLowerCase() === taskShortcutKey) {
        event.preventDefault()
        event.stopPropagation()
        actions.checklistToPlainText()
        return
      }
      if (modifier && !event.altKey && event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        if (event.shiftKey) actions.removeChecklist()
        else actions.toggleChecklist()
        return
      }
      if (event.altKey && !modifier && !event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault()
        event.stopPropagation()
        actions.moveLines(event.key === 'ArrowUp' ? 'up' : 'down')
      }
    }
    host.addEventListener('keydown', handleShortcut, true)
    return () => host.removeEventListener('keydown', handleShortcut, true)
  }, [actions, rawTextMode, taskShortcut])

  function openExternalLink(href: string) {
    if ('__TAURI_INTERNALS__' in window) {
      void import('@tauri-apps/plugin-shell').then(({ open }) => open(href))
    } else {
      window.open(href, '_blank', 'noopener,noreferrer')
    }
  }

  function focusEditor(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement
    const link = target.closest<HTMLAnchorElement>('a[href]')
    if (link && hostRef.current?.querySelector('.mdxeditor-root-contenteditable')?.contains(link)) {
      event.preventDefault()
      if (isAudioRecordingUrl(link.href)) setAudioPopover({ url: link.href, rect: link.getBoundingClientRect() })
      else openExternalLink(link.href)
      return
    }
    if (target.closest('.mdxeditor-toolbar, [contenteditable]:not([contenteditable="false"])')) return
    editorRef.current?.focus()
  }

  function caretAtEditorEdge(direction: 'up' | 'down'): boolean {
    const selection = window.getSelection()
    if (!selection || !selection.isCollapsed) return false
    const content = hostRef.current?.querySelector<HTMLElement>('.mdxeditor-root-contenteditable')
    if (!content || !content.contains(selection.anchorNode)) return false
    const blocks = topLevelBlocks(content)
    if (!blocks.length) return false
    const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement
    const currentBlock = anchor?.closest<HTMLElement>(TOP_LEVEL_BLOCK_SELECTOR)
    if (!currentBlock) return false
    const index = blocks.indexOf(currentBlock)
    if (index < 0) return false
    // The caret is only at the editor edge when every block beyond it in that
    // direction is empty — e.g. the trailing paragraph Lexical appends after a
    // directive or other non-paragraph block.
    const beyond = direction === 'up' ? blocks.slice(0, index) : blocks.slice(index + 1)
    if (beyond.some((block) => block.textContent.length)) return false
    // Container blocks (tag directives, blockquotes) may have padding or extra
    // children, so the edge line lives in the first/last non-empty child.
    let edgeBlock: HTMLElement = currentBlock
    if (currentBlock.matches('.notes-tag-directive, blockquote')) {
      const children = [...currentBlock.children] as HTMLElement[]
      const childIndex = children.findIndex((child) => child.contains(selection.anchorNode))
      if (childIndex < 0) return false
      const innerBeyond = direction === 'up' ? children.slice(0, childIndex) : children.slice(childIndex + 1)
      if (innerBeyond.some((child) => child.textContent.length)) return false
      edgeBlock = children[childIndex]
    }
    // Empty blocks have a zero-size caret rect; treat them as being at both edges
    if (edgeBlock.textContent.length === 0) return true
    const caretRect = selection.getRangeAt(0).getBoundingClientRect()
    const blockRect = edgeBlock.getBoundingClientRect()
    const lineHeight = parseFloat(getComputedStyle(edgeBlock).lineHeight) || caretRect.height || 20
    if (direction === 'up') return caretRect.top <= blockRect.top + lineHeight * 0.5
    return caretRect.bottom >= blockRect.bottom - lineHeight * 0.5
  }

  function firstBlockIsTag(): boolean {
    const content = hostRef.current?.querySelector<HTMLElement>('.mdxeditor-root-contenteditable')
    return !!topLevelBlocks(content)[0]?.classList.contains('notes-tag-directive')
  }

  function focusBeforeTag() {
    lexicalEditor?.update(() => {
      const root = $getRoot()
      const firstChild = root.getFirstChild()
      if ($isTagBlockNode(firstChild)) {
        const paragraph = $createParagraphNode()
        firstChild.insertBefore(paragraph)
        paragraph.selectStart()
        const key = paragraph.getKey()
        boundaryParagraphRef.current = { key, armed: false }
        // Lexical commits the new selection asynchronously; a selectionchange
        // can fire with the pre-insert anchor first. Arm the cleanup only after
        // the caret has had a frame to settle inside the boundary paragraph.
        window.requestAnimationFrame(() => {
          if (boundaryParagraphRef.current?.key === key) boundaryParagraphRef.current.armed = true
        })
      }
    })
  }

  function focusAdjacentEditor(direction: 'up' | 'down') {
    const card = hostRef.current?.closest<HTMLElement>('.day-card')
    if (!card) return
    const cards = [...card.parentElement?.querySelectorAll<HTMLElement>('.day-card') ?? []]
    const index = cards.indexOf(card)
    if (index < 0) return
    const targetCard = direction === 'up' ? cards[index - 1] : cards[index + 1]
    if (!targetCard) return
    const targetEditor = targetCard.querySelector<HTMLElement>('.notes-mdx-editor')
    if (!targetEditor) return
    targetEditor.dispatchEvent(new CustomEvent('notes-focus-edge', { detail: { direction }, bubbles: false }))
  }

  function handleEditorKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === '/') {
      event.preventDefault()
      actions.toggleMute()
      return
    }
    if (event.key === '"' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const selection = window.getSelection()
      if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
        const content = hostRef.current?.querySelector<HTMLElement>('.mdxeditor-root-contenteditable')
        if (content?.contains(selection.anchorNode)) {
          event.preventDefault()
          const selectedText = selection.toString()
          document.execCommand('insertText', false, '"' + selectedText + '"')
          const updated = window.getSelection()
          if (updated && updated.rangeCount > 0) {
            const range = updated.getRangeAt(0)
            const node = range.endContainer
            const offset = range.endOffset
            if (node.nodeType === Node.TEXT_NODE && offset >= selectedText.length + 2) {
              range.setStart(node, offset - selectedText.length - 1)
              range.setEnd(node, offset - 1)
              updated.removeAllRanges()
              updated.addRange(range)
            }
          }
          return
        }
      }
    }
    const plainArrow = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    if (event.key === 'ArrowUp' && plainArrow && caretAtEditorEdge('up')) {
      event.preventDefault()
      if (firstBlockIsTag()) {
        focusBeforeTag()
      } else {
        focusAdjacentEditor('up')
      }
      return
    }
    if (event.key === 'ArrowDown' && plainArrow && caretAtEditorEdge('down')) {
      event.preventDefault()
      focusAdjacentEditor('down')
      return
    }
  }

  // Keep the raw textarea as tall as its content, like the rich editor.
  useLayoutEffect(() => {
    const textarea = hostRef.current?.querySelector<HTMLTextAreaElement>('.notes-raw-editor')
    if (!rawTextMode || !textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight}px`
  }, [rawTextMode, value])

  if (rawTextMode) return <div className="notes-mdx-editor notes-raw-mode" ref={hostRef}><textarea className="notes-raw-editor" value={value} autoFocus={autoFocus} spellCheck={false} onKeyDown={(event) => {
    const target = event.currentTarget
    const modifier = event.metaKey || event.ctrlKey
    const taskShortcutParts = taskShortcut.toLowerCase().split('-')
    const taskShortcutKey = taskShortcutParts.at(-1)
    if (modifier && event.shiftKey && !event.altKey && event.key.toLowerCase() === taskShortcutKey) {
      event.preventDefault()
      const line = target.value.slice(0, target.selectionStart).split('\n').length - 1
      const nextValue = checklistToPlainText(target.value, line)
      if (nextValue !== target.value) {
        valueRef.current = nextValue
        onChangeRef.current(nextValue)
      }
      return
    }
    if (modifier && !event.altKey && event.key === 'Enter') {
      event.preventDefault()
      const line = target.value.slice(0, target.selectionStart).split('\n').length - 1
      const nextValue = event.shiftKey ? removeChecklist(target.value, line) : toggleChecklist(target.value, line)
      if (nextValue !== target.value) {
        valueRef.current = nextValue
        onChangeRef.current(nextValue)
      }
      return
    }
    if (event.altKey && !modifier && !event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      const selectionStart = target.selectionStart
      const selectionEnd = target.selectionEnd
      const lines = target.value.split('\n')
      const startLine = target.value.slice(0, selectionStart).split('\n').length - 1
      const endLine = target.value.slice(0, selectionEnd).split('\n').length - 1
      const direction = event.key === 'ArrowUp' ? 'up' : 'down'
      const adjacentLine = direction === 'up' ? startLine - 1 : endLine + 1
      const delta = adjacentLine < 0 || adjacentLine >= lines.length
        ? 0
        : direction === 'up' ? -(lines[adjacentLine].length + 1) : lines[adjacentLine].length + 1
      const nextValue = moveLines(target.value, startLine, endLine, direction)
      if (nextValue !== target.value) {
        valueRef.current = nextValue
        onChangeRef.current(nextValue)
        window.requestAnimationFrame(() => {
          target.focus()
          target.setSelectionRange(selectionStart + delta, selectionEnd + delta)
        })
      }
      return
    }
    if (event.key === '"' && !event.metaKey && !event.ctrlKey && !event.altKey && event.currentTarget.selectionStart !== event.currentTarget.selectionEnd) {
      event.preventDefault()
      const start = target.selectionStart
      const end = target.selectionEnd
      const selectedText = target.value.slice(start, end)
      const newValue = target.value.slice(0, start) + '"' + selectedText + '"' + target.value.slice(end)
      valueRef.current = newValue
      onChangeRef.current(newValue)
      window.requestAnimationFrame(() => target.setSelectionRange(start + 1, start + 1 + selectedText.length))
      return
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    const atFirstLine = event.key === 'ArrowUp' && target.selectionStart === 0
    const atLastLine = event.key === 'ArrowDown' && target.selectionStart === target.value.length
    if (!atFirstLine && !atLastLine) return
    event.preventDefault()
    focusAdjacentEditor(event.key === 'ArrowUp' ? 'up' : 'down')
  }} onChange={(event) => { valueRef.current = event.target.value; onChangeRef.current(event.target.value) }} /></div>


  return <div className="notes-mdx-editor" ref={hostRef} onClick={focusEditor} onKeyDownCapture={handleEditorKeyDown}>
    <EditorActionsProvider value={actions}>
      <MDXEditor
        ref={editorRef}
        markdown={markdownForEditor(commentsToTagDirectives(value))}
        autoFocus={autoFocus}
        onChange={(markdown) => {
          if (!userInteractedRef.current || suppressChangeRef.current) return
          if (programmaticMarkdownRef.current !== null) {
            programmaticMarkdownRef.current = null
            return
          }
          const preserved = restoreMarkdownSpacing(valueRef.current, preserveMutedLines(valueRef.current, markdown))
          valueRef.current = preserved
          onChangeRef.current(preserved)
        }}
        plugins={plugins}
      />
    </EditorActionsProvider>
    {audioPopover && <AudioPlayerPopover url={audioPopover.url} anchorRect={audioPopover.rect} onClose={() => setAudioPopover(null)} />}
  </div>
}
