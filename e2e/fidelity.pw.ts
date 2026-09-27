import { expect, test, type Page } from '@playwright/test'
import { editorFor, selectionSnapshot, setCaretAtText, sourceFor } from './support/editor'

// The rendered text and caret column of the visual line containing the
// collapsed caret. Soft-break lines share one block element (<p>) — in this
// editor they're a single text node with '\n' separators — so neither
// blockText nor the raw DOM anchorOffset identify which rendered line the
// caret sits on. This walks the block's text leaves (splitting on '\n' and
// <br>) and reports the caret's own segment plus its column within it, in
// rendered UTF-16 code units.
async function renderedCaret(page: Page): Promise<{ line: string | null; column: number | null }> {
  return page.evaluate(() => {
    const selection = window.getSelection()
    const node = selection?.anchorNode
    if (!node) return { line: null, column: null }
    const offset = selection?.anchorOffset ?? 0
    const element = node instanceof Element ? node : node.parentElement
    const block = element?.closest('p,li,blockquote,pre,h1,h2,h3,h4,h5,h6')
    if (!block) {
      return { line: node.nodeType === Node.TEXT_NODE ? node.textContent : null, column: null }
    }
    const segments: string[] = ['']
    let anchorSegment: number | null = null
    let anchorColumn: number | null = null
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      if (current.nodeName === 'BR') {
        segments.push('')
        continue
      }
      if (current.nodeType !== Node.TEXT_NODE) continue
      const text = current.textContent ?? ''
      if (current === node) {
        const before = text.slice(0, offset)
        const breaks = before.split('\n').length - 1
        anchorSegment = segments.length - 1 + breaks
        anchorColumn = (breaks === 0 ? segments[segments.length - 1].length : 0)
          + before.length - before.lastIndexOf('\n') - 1
      }
      text.split('\n').forEach((part, index) => {
        if (index === 0) segments[segments.length - 1] += part
        else segments.push(part)
      })
    }
    return {
      line: anchorSegment === null ? block.textContent : segments[anchorSegment] ?? '',
      column: anchorColumn,
    }
  })
}

test('an external update while focused preserves the caret and merges content', async ({ page }) => {
  await page.goto('/prototype?scenario=plain-text')
  const root = editorFor(page)

  await setCaretAtText(root, 'alpha target middle', 5)
  await page.getByRole('button', { name: 'External update' }).click()
  // The button click blurred the editor — put the caret straight back, then
  // let the +400ms setMarkdown land while the editor is focused.
  await setCaretAtText(root, 'alpha target middle', 5)

  await expect.poll(async () => sourceFor(page).textContent()).toContain('external update')
  // Wait for the re-import to reach the DOM, and for the caret to be restored
  // on the same rendered line it was on before the update.
  await expect.poll(async () => root.textContent()).toContain('external update')
  await expect.poll(() => renderedCaret(page)).toEqual({ line: 'alpha target middle', column: 5 })

  await page.keyboard.type('X')
  await expect.poll(async () => sourceFor(page).textContent()).toBe(
    'prefix alpha\nalphaX target middle\nformatted **bold target** and *italic target*\nsuffix omega\nexternal update',
  )
})

test('unicode and emoji caret offsets survive move and mute', async ({ page }) => {
  await page.goto('/prototype?scenario=unicode')
  const root = editorFor(page)
  const emojiLine = 'emoji 🧠 and flags 👩‍⚕️ mixed in'

  // (a) Alt+ArrowDown moves the whole first canonical line below the next one;
  // the caret must travel with the moved line.
  await setCaretAtText(root, 'mixed in', 0)
  await page.keyboard.press('Alt+ArrowDown')
  const movedSource = 'café naïve résumé\nemoji 🧠 and flags 👩‍⚕️ mixed in\n%% muted emoji 🎉 line\ntail'
  await expect.poll(async () => sourceFor(page).textContent()).toBe(movedSource)
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toContain('emoji 🧠')
  // Caret was just before 'mixed in' — 25 rendered code units into the line.
  await expect.poll(() => renderedCaret(page)).toEqual({ line: emojiLine, column: 25 })

  // (b) Control+/ appends ` %%` to the accented line without mangling it.
  await setCaretAtText(root, 'café naïve résumé', 0)
  await page.keyboard.press('Control+/')
  await expect.poll(async () => sourceFor(page).textContent()).toBe(
    'café naïve résumé %%\nemoji 🧠 and flags 👩‍⚕️ mixed in\n%% muted emoji 🎉 line\ntail',
  )

  // (c) Unmute the muted emoji line, then mute it again. Multi-byte content
  // round-trips exactly; the `%%` marker itself normalizes to end-of-line
  // (a leading `%% ` is re-appended as ` %%` — mutedness is what round-trips).
  await setCaretAtText(root, 'muted emoji 🎉 line', 0)
  await page.keyboard.press('Control+/')
  await expect.poll(async () => sourceFor(page).textContent()).toBe(
    'café naïve résumé %%\nemoji 🧠 and flags 👩‍⚕️ mixed in\nmuted emoji 🎉 line\ntail',
  )
  await setCaretAtText(root, 'muted emoji 🎉 line', 0)
  await page.keyboard.press('Control+/')
  await expect.poll(async () => sourceFor(page).textContent()).toBe(
    'café naïve résumé %%\nemoji 🧠 and flags 👩‍⚕️ mixed in\nmuted emoji 🎉 line %%\ntail',
  )
})

test('malformed tag directives degrade to plain text', async ({ page }) => {
  await page.goto('/prototype?scenario=malformed-directive')
  const root = editorFor(page)

  // No crash: the editor is visible and the malformed directive lines render
  // as literal editable text.
  await expect(root).toBeVisible()
  await expect.poll(async () => root.textContent()).toContain(':::tag{')
  await expect.poll(async () => ((await root.textContent()) ?? '').match(/:::/gu)?.length ?? 0).toBe(3)
  await expect.poll(async () => root.textContent()).toContain('broken open')

  await setCaretAtText(root, 'broken open', 0)
  await page.keyboard.type('!')
  // mdast-util-to-markdown defensively escapes directive-looking literal text
  // so it re-parses as plain text — semantically identical and stable.
  await expect.poll(async () => sourceFor(page).textContent()).toBe(
    'before\n\\:::tag{\n!broken open\n\\:::\nafter\n\\:::',
  )
  // The escaped form is stable: another edit doesn't keep rewriting it.
  // (The typed '~' is itself escaped since it could open a strikethrough.)
  await setCaretAtText(root, 'after', 0)
  await page.keyboard.type('~')
  await expect.poll(async () => sourceFor(page).textContent()).toBe(
    'before\n\\:::tag{\n!broken open\n\\:::\n\\~after\n\\:::',
  )
})

test('moved lines with multi-byte characters keep caret column', async ({ page }) => {
  await page.goto('/prototype?scenario=unicode')
  const root = editorFor(page)
  const emojiLine = 'emoji 🧠 and flags 👩‍⚕️ mixed in'

  // Caret at the end of the first rendered line (after 'mixed in').
  await setCaretAtText(root, 'mixed in', 'mixed in'.length)
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(async () => sourceFor(page).textContent()).toBe(
    'café naïve résumé\nemoji 🧠 and flags 👩‍⚕️ mixed in\n%% muted emoji 🎉 line\ntail',
  )

  // The caret column must survive the move in rendered-character units — not
  // clamped, not byte-mangled short of the emoji/ZWJ sequences. (Raw
  // anchorOffset is meaningless here: the paragraph is one shared text node,
  // so it includes the preceding 'café naïve résumé\n'.)
  await expect.poll(() => renderedCaret(page)).toEqual({ line: emojiLine, column: emojiLine.length })
})
