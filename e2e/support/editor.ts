import { expect, type Locator, type Page } from '@playwright/test'

export const BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,li,blockquote,pre,p:not(li p):not(blockquote p):not(.notes-tag-directive p)'

export function editorFor(page: Page) {
  return page.locator('.mdxeditor-root-contenteditable').first()
}

export function sourceFor(page: Page) {
  return page.getByTestId('prototype-source')
}

export async function expectSource(page: Page, expected: string | RegExp) {
  await expect(sourceFor(page)).toHaveText(expected)
}

export async function clickTextCaret(page: Page, root: Locator, text: string, offset = 0) {
  await root.getByText(text, { exact: true }).last().click()
  await page.keyboard.press('Home')
  for (let index = 0; index < offset; index += 1) await page.keyboard.press('ArrowRight')
}

export async function setCaret(block: Locator, offset: number) {
  await block.evaluate((element, requestedOffset) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    let remaining = requestedOffset
    while (node) {
      const length = node.textContent?.length ?? 0
      if (remaining <= length) {
        const range = document.createRange()
        range.setStart(node, remaining)
        range.collapse(true)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        ;(element.closest('[contenteditable="true"]') as HTMLElement | null)?.focus()
        document.dispatchEvent(new Event('selectionchange'))
        return
      }
      remaining -= length
      node = walker.nextNode()
    }
    const range = document.createRange()
    range.selectNodeContents(element)
    range.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, offset)
}

export async function setCaretAtText(root: Locator, text: string, offset = 0) {
  await root.evaluate((element, value) => {
    ;(element.closest('[contenteditable="true"]') as HTMLElement | null)?.focus()
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      const index = (node.textContent ?? '').indexOf(value.text)
      if (index >= 0) {
        const range = document.createRange()
        range.setStart(node, index + Math.min(value.offset, value.text.length))
        range.collapse(true)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
        return
      }
      node = walker.nextNode()
    }
    throw new Error(`Could not find rendered caret text: ${value.text}`)
  }, { text, offset })
}

export async function selectRenderedText(root: Locator, text: string) {
  await root.evaluate((element, selectedText) => {
    const textNodes: Text[] = []
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      textNodes.push(node as Text)
      node = walker.nextNode()
    }
    const fullText = textNodes.map((textNode) => textNode.textContent ?? '').join('')
    const startIndex = fullText.indexOf(selectedText)
    if (startIndex < 0) throw new Error(`Could not find rendered selection: ${selectedText}`)
    const locate = (position: number) => {
      let offset = 0
      for (const textNode of textNodes) {
        const length = textNode.textContent?.length ?? 0
        if (position <= offset + length) return { node: textNode, offset: position - offset }
        offset += length
      }
      const last = textNodes.at(-1)
      return { node: last, offset: last?.textContent?.length ?? 0 }
    }
    const start = locate(startIndex)
    const end = locate(startIndex + selectedText.length)
    if (!start.node || !end.node) throw new Error('Selection endpoints were not found')
    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  }, text)
}

export async function selectRenderedRange(root: Locator, startText: string, endText: string) {
  await root.evaluate((element, values) => {
    const locate = (text: string, atEnd = false) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node) {
        const value = node.textContent ?? ''
        const index = value.indexOf(text)
        if (index >= 0) return { node: node as Text, offset: index + (atEnd ? text.length : 0) }
        node = walker.nextNode()
      }
      return undefined
    }
    const start = locate(values.start)
    const end = locate(values.end, true)
    if (!start || !end) throw new Error(`Could not find rendered range: ${values.start} → ${values.end}`)
    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  }, { start: startText, end: endText })
}

export async function selectionSnapshot(page: Page) {
  return page.evaluate(() => {
    const selection = window.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    const anchor = selection?.anchorNode instanceof Element ? selection.anchorNode : selection?.anchorNode?.parentElement
    const block = anchor?.closest('h1,h2,h3,h4,h5,h6,li,blockquote,pre,p')
    const scrollElement = document.scrollingElement
    return {
      text: selection?.toString() ?? '',
      collapsed: selection?.isCollapsed ?? true,
      blockText: block?.textContent ?? '',
      anchorOffset: selection?.anchorOffset ?? -1,
      focusOffset: selection?.focusOffset ?? -1,
      caretTop: range?.getBoundingClientRect().top ?? -1,
      scrollTop: scrollElement?.scrollTop ?? 0,
    }
  })
}

export async function waitForSelectionText(page: Page, text: string) {
  await expect.poll(async () => (await selectionSnapshot(page)).text).toBe(text)
}
