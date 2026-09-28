import { expect, test, type Page } from '@playwright/test'
import {
  editorFor,
  expectSource,
  selectRenderedRange,
  selectRenderedText,
  selectionSnapshot,
  setCaretAtText,
  sourceFor,
} from './support/editor'

const UNDO_KEY = process.platform === 'darwin' ? 'Meta+z' : 'Control+z'

const sourceText = async (page: Page) => (await sourceFor(page).textContent()) ?? ''

test('deleting a multi-block selection drops exactly those blocks', async ({ page }) => {
  await page.goto('/prototype?scenario=movement-sweep')
  const root = editorFor(page)

  // From the start of "bravo para" through the middle of the quote block.
  await selectRenderedRange(root, 'bravo para', 'quote one')
  await expect.poll(async () => (await selectionSnapshot(page)).text).toContain('quote one')
  await page.keyboard.press('Shift')
  await page.keyboard.press('Backspace')

  await expect.poll(async () => sourceText(page)).not.toContain('bravo para')
  const source = await sourceText(page)
  console.log('post-delete source:\n' + source)
  expect(source).not.toContain('heading here')
  expect(source).not.toContain('bullet one')
  expect(source).not.toContain('bullet two')
  expect(source).not.toContain('bullet three')
  expect(source).not.toContain('nested one')
  expect(source).not.toContain('nested two')
  expect(source).not.toContain('quote one')
  // Neighbors outside the selection survive untouched.
  expect(source).toContain('alpha one')
  expect(source).toContain('alpha two')
  expect(source).toContain('ordered one')
  expect(source).toContain('ordered two')
  expect(source).toContain('tail one')
  expect(source).toContain('tail two')
  // The remaining selection collapses to a caret.
  await expect.poll(async () => (await selectionSnapshot(page)).collapsed).toBe(true)
})

test('typing over a cross-block selection replaces the blocks with the typed text', async ({ page }) => {
  await page.goto('/prototype?scenario=movement-sweep')
  const root = editorFor(page)

  await selectRenderedRange(root, 'bravo para', 'bullet two')
  await expect.poll(async () => (await selectionSnapshot(page)).text).toContain('bullet two')

  await page.keyboard.type('replaced')

  await expect.poll(async () => sourceText(page)).toContain('replaced')
  const source = await sourceText(page)
  console.log('post-type source:\n' + source)
  expect(source).not.toContain('bravo para')
  expect(source).not.toContain('heading here')
  expect(source).not.toContain('bullet one')
  expect(source).not.toContain('bullet two')
  // Neighbors outside the selection survive untouched.
  expect(source).toContain('alpha one')
  expect(source).toContain('alpha two')
  expect(source).toContain('bullet three')
  expect(source).toContain('quote one')
  expect(source).toContain('tail one')
  expect(source).toContain('tail two')
})

test.describe('enter splits a heading/list item/blockquote into well-formed markdown', () => {
  test('enter mid-heading splits into a heading and a new block', async ({ page }) => {
    await page.goto('/prototype?scenario=structure')
    const root = editorFor(page)

    // Caret between "Headi" and "ng target". The Shift press absorbs the
    // swallowed first keypress after a programmatic DOM selection.
    await setCaretAtText(root, 'Heading target', 5)
    await page.keyboard.press('Shift')
    await page.keyboard.press('Enter')

    await expect.poll(async () => sourceText(page)).toMatch(/^# Headi$/mu)
    const source = await sourceText(page)
    console.log('heading split source:\n' + source)
    // The trailing half lands on its own line as a new block; no text is lost.
    expect(source).toMatch(/^(?:#+\s+)?ng target$/mu)
    expect(source).toContain('prefix alpha')
    expect(source).toContain('quote target')
    expect(source).toContain('suffix omega')
  })

  test('enter mid-list-item splits into two list items', async ({ page }) => {
    await page.goto('/prototype?scenario=structure')
    const root = editorFor(page)

    // Caret between "bulle" and "t target".
    await setCaretAtText(root, 'bullet target', 5)
    await page.keyboard.press('Shift') // absorb swallowed first keypress
    await page.keyboard.press('Enter')

    await expect.poll(async () => sourceText(page)).toMatch(/^- bulle$/mu)
    const source = await sourceText(page)
    console.log('list split source:\n' + source)
    expect(source).toMatch(/^- t target$/mu)
    expect(source).toContain('prefix alpha')
    expect(source).toContain('suffix omega')
  })

  test('enter mid-quote splits the quote and keeps both halves quoted', async ({ page }) => {
    await page.goto('/prototype?scenario=structure')
    const root = editorFor(page)

    // Caret between "quote " and "target".
    await setCaretAtText(root, 'quote target', 6)
    await page.keyboard.press('Shift') // absorb swallowed first keypress
    await page.keyboard.press('Enter')

    // mdast escapes a trailing space as &#x20; — e.g. `> quote&#x20;`.
    await expect.poll(async () => sourceText(page)).toMatch(/^> ?quote(?:&#x20;| )?$/mu)
    const source = await sourceText(page)
    console.log('quote split source:\n' + source)
    expect(source).toMatch(/^> ?target ?$/mu)
    expect(source).toContain('prefix alpha')
    expect(source).toContain('suffix omega')
  })
})

test('pasting multi-line markdown round-trips into canonical source', async ({ page }) => {
  await page.goto('/prototype?scenario=plain-text')
  const root = editorFor(page)

  await setCaretAtText(root, 'alpha target middle', 'alpha target middle'.length)

  const pasted = 'pasted one\n\npasted two\n- pasted item'
  // The paste listener lives on Lexical's root element — the inner
  // [contenteditable] child of .mdxeditor-root-contenteditable.
  const dispatched = await root.evaluate((element, text) => {
    const target = element.querySelector('[contenteditable="true"]') ?? element
    const data = new DataTransfer()
    data.setData('text/plain', text)
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    if (!event.clipboardData) Object.defineProperty(event, 'clipboardData', { value: data })
    try {
      const result = target.dispatchEvent(event)
      // dispatchEvent returns false when a handler called preventDefault —
      // i.e. a paste listener actually consumed the synthetic event.
      return { consumed: !result, defaultPrevented: event.defaultPrevented }
    } catch (error) {
      return { error: String(error) }
    }
  }, pasted)

  let delivered = false
  try {
    await expect.poll(async () => sourceText(page), { timeout: 2_000 }).toContain('pasted one')
    delivered = true
  } catch {
    delivered = false
  }
  console.log(`paste delivery: ClipboardEvent ${JSON.stringify(dispatched)} delivered=${delivered}`)

  if (!delivered) {
    await page.evaluate((text) => document.execCommand('insertText', false, text), pasted)
  }

  await expect.poll(async () => sourceText(page)).toContain('pasted one')
  await expect.poll(async () => sourceText(page)).toContain('pasted two')
  // "- pasted item" round-trips as a real list item in the canonical source.
  await expect.poll(async () => sourceText(page)).toMatch(/^- pasted item$/mu)
  const source = await sourceText(page)
  console.log('post-paste source:\n' + source)
  expect(source).toContain('prefix alpha')
  expect(source).toContain('bold target')
  expect(source).toContain('suffix omega')
  await expect(root.locator('li', { hasText: 'pasted item' })).toHaveCount(1)
})

test.describe('undo restores the source after source-space operations', () => {
  test('undo reverts a mute toggle', async ({ page }) => {
    await page.goto('/prototype?scenario=muted')
    const root = editorFor(page)

    await setCaretAtText(root, 'plain target', 2)
    await page.keyboard.press('Control+/')
    await expectSource(page, /plain target %%/u)

    // The commit restored the caret programmatically; a real click lands a
    // settled caret before undo so the keypress is not swallowed.
    await root.locator('p', { hasText: 'plain target' }).click()
    await page.keyboard.press(UNDO_KEY)
    await expect.poll(async () => sourceText(page)).toMatch(/^plain target$/mu)
    const source = await sourceText(page)
    console.log('mute undo source:\n' + source)
    expect(source).not.toContain('plain target %%')
    expect(source).toContain('%% already muted')
  })

  test('undo reverts an applied tag', async ({ page }) => {
    await page.goto('/prototype?scenario=tagging')
    const root = editorFor(page)

    await selectRenderedText(root, 'second line')
    await page.getByLabel('Tag name').fill('fresh')
    await page.keyboard.press('Enter')
    await expectSource(page, /:::tag\{name="fresh"\}/u)

    // Focus the editor before undoing.
    await root.locator('p', { hasText: 'suffix omega' }).click()
    await page.keyboard.press(UNDO_KEY)

    await expect.poll(async () => sourceText(page)).not.toContain(':::tag')
    const source = await sourceText(page)
    console.log('tag undo source:\n' + source)
    expect(source).toContain('first line')
    expect(source).toContain('second line')
    expect(source).toContain('third line')
    expect(source).toContain('suffix omega')
  })

  test('undo reverts a checklist toggle', async ({ page }) => {
    await page.goto('/prototype?scenario=checklist')
    const root = editorFor(page)

    const target = root.locator('li', { hasText: 'first task' })
    const box = await target.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.click(box!.x + 5, box!.y + 5)
    await expectSource(page, /- \[x\] first task/u)

    await page.keyboard.press(UNDO_KEY)
    await expect.poll(async () => sourceText(page)).toMatch(/^- \[ \] first task$/mu)
    const source = await sourceText(page)
    console.log('checklist undo source:\n' + source)
    expect(source).not.toContain('- [x] first task')
  })
})

const SHORTCUTS: Array<{ input: string; expected: RegExp }> = [
  { input: '- ', expected: /^- Line B$/mu },
  { input: '> ', expected: /^> Line B$/mu },
  { input: '1. ', expected: /^1\. Line B$/mu },
  { input: '# ', expected: /^# Line B$/mu },
  // `- ` fires the bullet transformer first; the `[ ] ` typed inside the new
  // list item is then converted to a checkbox by the editor's own handler
  // (Lexical element transformers don't run inside list items).
  { input: '- [ ] ', expected: /^- \[ \] Line B$/mu },
  { input: '- [x] ', expected: /^- \[x\] Line B$/mu },
]

test.describe('markdown input shortcuts produce canonical syntax', () => {
  for (const { input, expected } of SHORTCUTS) {
    // line-movement-hard is blank-separated, so 'Line B' is a real block —
    // element transformers only fire at block starts, not mid-paragraph
    // soft-break lines.
    test(`typing "${input.trimEnd()}" at a block start converts the block`, async ({ page }) => {
      await page.goto('/prototype?scenario=line-movement-hard')
      const root = editorFor(page)

      await setCaretAtText(root, 'Line B', 0)
      await page.keyboard.type(input)

      await expect.poll(async () => sourceText(page)).toMatch(expected)
      const source = await sourceText(page)
      expect(source).toContain('Line A')
      expect(source).toContain('Line C')
    })
  }
})
