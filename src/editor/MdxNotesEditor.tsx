import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { MDXEditor, type MDXEditorMethods } from '@mdxeditor/editor'
import { $createParagraphNode, $getNodeByKey, $getRoot, $setSelection, type LexicalEditor } from 'lexical'
import { parseMarkdown, removeTagAtPosition, toggleMutedLines } from '../markerEngine'
import { EditorActionsProvider } from './editorActions'
import { mdxEditorPlugins } from './mdxEditorPlugins'
import { commentsToTagDirectives } from './tagSyntax'
import { $isTagBlockNode } from './TagBlockNode'
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
      if (element.hidden !== hidden) element.hidden = hidden
    }
  })
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
        const sourceText = line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)/u, '').replace(/^\[[ xX]\]\s+/u, '').replace(/<[^>]+>/gu, '').replace(/[\\*_`]/gu, '').replace(/\s+/gu, ' ').trim()
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

function applyChecklistWidgets(root: HTMLElement | null, getSource: () => string, commit: (markdown: string) => void) {
  if (!root) return
  const lines = getSource().split('\n')
  let searchStart = 0
  const managedItems = new Set<HTMLElement>()
  root.querySelectorAll<HTMLElement>('li').forEach((item) => {
    const existing = item.querySelector<HTMLInputElement>(':scope > .notes-checklist-checkbox')
    const lineIndex = lines.findIndex((line, index) => index >= searchStart && /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+/u.test(line) && sourceLineForRenderedText(line, item.textContent ?? '') >= 0)
    const match = lineIndex < 0 ? null : lines[lineIndex].match(/^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/u)
    if (lineIndex < 0 || !match) {
      existing?.remove()
      return
    }
    searchStart = lineIndex + 1
    const checked = match[2].toLowerCase() === 'x'
    managedItems.add(item)
    if (existing) {
      if (existing.dataset.checklistLine !== String(lineIndex)) existing.dataset.checklistLine = String(lineIndex)
      if (existing.checked !== checked) existing.checked = checked
      return
    }
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.className = 'notes-checklist-checkbox'
    input.checked = checked
    input.dataset.checklistLine = String(lineIndex)
    input.contentEditable = 'false'
    input.setAttribute('aria-label', checked ? 'Mark task incomplete' : 'Mark task complete')
    input.addEventListener('change', () => {
      const nextLines = getSource().split('\n')
      const line = nextLines[Number(input.dataset.checklistLine)]
      const current = line?.match(/^(\s*(?:[-*+]|\d+[.)])\s+)\[[ xX]\]/u)
      if (!current) return
      nextLines[Number(input.dataset.checklistLine)] = `${current[1]}[${input.checked ? 'x' : ' '}]${line.slice(current[0].length)}`
      commit(nextLines.join('\n'))
    })
    item.insertBefore(input, item.firstChild)
  })
  root.querySelectorAll<HTMLElement>('.notes-checklist-checkbox').forEach((input) => {
    if (input.parentElement && !managedItems.has(input.parentElement)) input.remove()
  })
}

export function MdxNotesEditor({ value, onChange, autoFocus = false, hideMutedLines = false, tagColors = {}, showUndoRedo = false, rawTextMode = false }: MdxNotesEditorProps) {
  const editorRef = useRef<MDXEditorMethods>(null)
  const [lexicalEditor, setLexicalEditor] = useState<LexicalEditor | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const valueRef = useRef(commentsToTagDirectives(value))
  const onChangeRef = useRef(onChange)
  const selectedTextRef = useRef('')
  const caretBlockTextRef = useRef('')
  const userInteractedRef = useRef(false)
  const suppressChangeRef = useRef(false)
  const [selectionState, setSelectionState] = useState({ text: '', blockText: '' })
  const [recentTags, setRecentTags] = useState<string[]>(loadRecentTags)
  const boundaryParagraphRef = useRef<{ key: string; armed: boolean } | null>(null)

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
    host.addEventListener('click', markInteraction)
    host.addEventListener('mousedown', preserveEditorSelection)
    host.addEventListener('notes-focus-edge', handleFocusEdge)
    return () => {
      host.removeEventListener('beforeinput', markInteraction)
      host.removeEventListener('keydown', markInteraction)
      host.removeEventListener('paste', markInteraction)
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
    editorRef.current?.setMarkdown(editorValue)
    const frame = window.requestAnimationFrame(() => { suppressChangeRef.current = false })
    return () => window.cancelAnimationFrame(frame)
  }, [value])

  useEffect(() => {
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
  }, [lexicalEditor])

  useEffect(() => {
    let cancelled = false
    let attempts = 0
    let frame = 0
    const apply = () => {
      if (cancelled) return
      applyMutedVisibility(hostRef.current, hideMutedLines)
      applyTagDecorations(hostRef.current, value, tagColors)
      applyChecklistWidgets(hostRef.current, () => valueRef.current, commit)
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

  const plugins = useMemo(() => mdxEditorPlugins(setLexicalEditor), [])
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

  if (rawTextMode) return <div className="notes-mdx-editor notes-raw-mode" ref={hostRef}><textarea className="notes-raw-editor" value={value} autoFocus={autoFocus} spellCheck={false} onKeyDown={(event) => {
    if (event.key === '"' && !event.metaKey && !event.ctrlKey && !event.altKey && event.currentTarget.selectionStart !== event.currentTarget.selectionEnd) {
      event.preventDefault()
      const target = event.currentTarget
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
    const target = event.currentTarget
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
        markdown={commentsToTagDirectives(value)}
        autoFocus={autoFocus}
        onChange={(markdown) => {
          if (!userInteractedRef.current || suppressChangeRef.current) return
          valueRef.current = markdown
          onChangeRef.current(markdown)
        }}
        plugins={plugins}
      />
    </EditorActionsProvider>
  </div>
}
