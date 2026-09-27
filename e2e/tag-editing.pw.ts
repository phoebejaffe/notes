import { expect, test, type Page } from '@playwright/test'
import { editorFor, selectionSnapshot, setCaretAtText, sourceFor } from './support/editor'

const sourceText = async (page: Page) => (await sourceFor(page).textContent()) ?? ''

test("enter at the end of a tag's last line stays inside the tag", async ({ page }) => {
  await page.goto('/prototype?scenario=tag-edges')
  const root = editorFor(page)
  await expect(root.locator('.notes-tag-directive')).toHaveCount(1)
  await setCaretAtText(root, 'tag last line', 'tag last line'.length)
  await page.keyboard.press('Enter')
  await page.keyboard.type('new line')
  // The source must still end with the tag's closing `:::` and the typed text
  // must land before it — i.e. inside the tag, not after it.
  await expect.poll(() => sourceText(page)).toMatch(/tag last line\n+new line\n:::\s*$/)
})

test("enter at the start of a tag's first line keeps content inside the tag", async ({ page }) => {
  await page.goto('/prototype?scenario=tag-edges')
  const root = editorFor(page)
  await expect(root.locator('.notes-tag-directive')).toHaveCount(1)
  await setCaretAtText(root, 'tag first line', 0)
  await page.keyboard.press('Enter')
  await page.keyboard.type('above')
  // Standard split semantics: Enter at offset 0 leaves an empty paragraph above
  // and keeps the caret with the text, so 'above' glues onto 'tag first line'.
  // What matters is that everything stays inside the tag.
  await expect.poll(() => sourceText(page)).toMatch(/:::tag\{name="edge"\}[\s\S]*abovetag first line\n+tag last line\n+:::\s*$/)
})

test("backspace at the start of a tag's first child", async ({ page }) => {
  await page.goto('/prototype?scenario=tag-edges')
  const root = editorFor(page)
  await expect(root.locator('.notes-tag-directive')).toHaveCount(1)
  await setCaretAtText(root, 'tag first line', 0)
  await page.keyboard.press('Backspace')
  // Intended: the line stays inside the tag (or merges gracefully within it).
  // The delimiters must survive and 'tag first line' must remain between them.
  await expect.poll(() => sourceText(page)).toMatch(/:::tag\{name="edge"\}[\s\S]*tag first line[\s\S]*:::/)
})

test('backspace merges a paragraph into the preceding blockquote without corrupting source', async ({ page }) => {
  await page.goto('/prototype?scenario=muted')
  const root = editorFor(page)
  await expect(root.locator('blockquote')).toHaveCount(1)
  await setCaretAtText(root, 'suffix omega', 0)
  await page.keyboard.press('Backspace')
  // 'suffix omega' directly follows '> quote target', so backspace should merge
  // the paragraph into the blockquote rather than leaving two separate blocks.
  await expect.poll(async () => (await root.locator('blockquote').last().textContent()) ?? '').toContain('suffix omega')
  // The rest of the document must remain intact and the merged text must be in
  // the source (exported as a lazy continuation line of the blockquote, e.g.
  // `> quote target\nsuffix omega`, or appended inline).
  await expect.poll(() => sourceText(page)).toMatch(
    /^prefix alpha\nplain target\n\n%% already muted\n\n- list target\n## heading target\n- \[ \] task target\n> quote target/u,
  )
  await expect.poll(() => sourceText(page)).toContain('suffix omega')
})

test('emptying a tag keeps its delimiters and stays editable', async ({ page }) => {
  await page.goto('/prototype?scenario=tag-edges')
  const root = editorFor(page)
  const tag = root.locator('.notes-tag-directive')
  await expect(tag).toHaveCount(1)
  // Select all rendered text inside the tag with real key-driven selection so
  // Lexical observes it (a synthetic DOM range is not adopted by its internal
  // selection and Backspace becomes a no-op). Shift+End overshoots — it swallows
  // the paragraph's trailing break and leaks into the invisible empty paragraph
  // after the tag — so extend by line instead.
  const wantedSelection = 'tag first line\ntag last line'
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await setCaretAtText(root, 'tag last line', 'tag last line'.length)
    await page.waitForTimeout(150)
    await page.keyboard.press('Shift+ArrowUp')
    await page.keyboard.press('Shift+Home')
    // Give Lexical a beat to commit the extended selection — its async
    // reconciliation can briefly revert the DOM caret to a stale internal
    // selection. Verify it stuck before deleting.
    await page.waitForTimeout(300)
    if ((await selectionSnapshot(page)).text === wantedSelection) break
  }
  await expect.poll(async () => (await selectionSnapshot(page)).text).toBe(wantedSelection)
  await page.keyboard.press('Backspace')
  // Deleting everything inside the tag must not destroy the tag itself.
  await expect.poll(() => sourceText(page)).toMatch(/^\s*:::tag\{name="edge"\}\n+:::\s*$/)
  // The emptied tag must still accept caret + text.
  await tag.click()
  await expect.poll(async () => page.evaluate(() => {
    const anchor = window.getSelection()?.anchorNode
    const element = anchor instanceof Element ? anchor : anchor?.parentElement
    return !!element?.closest('.notes-tag-directive')
  })).toBe(true)
  await page.keyboard.type('fresh')
  await expect.poll(() => sourceText(page)).toMatch(/:::tag\{name="edge"\}\n+fresh\n*:::/)
})

test("enter inside a nested tag's last line stays inside the inner tag", async ({ page }) => {
  await page.goto('/prototype?scenario=nested-tags')
  const root = editorFor(page)
  await expect(root.locator('.notes-tag-directive')).toHaveCount(2)
  await setCaretAtText(root, 'inner line', 'inner line'.length)
  await page.keyboard.press('Enter')
  await page.keyboard.type('x')
  // 'x' must land inside the inner tag: after 'inner line' and before the inner
  // `:::` that precedes 'outer last', without corrupting the outer directive.
  // (Export may leave incidental whitespace on the broken line.)
  await expect.poll(() => sourceText(page)).toMatch(/inner line\s*\n+\s*x[\s\S]*?:::\s*\nouter last/)
})
