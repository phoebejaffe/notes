import { expect, test } from '@playwright/test'
import { editorFor, expectSource, selectionSnapshot, setCaretAtText } from './support/editor'

test('nested tags render nested directive blocks with distinct colors', async ({ page }) => {
  await page.goto('/prototype?scenario=nested-tags')
  const root = editorFor(page)
  const directives = page.locator('.notes-tag-directive')
  await expect(directives).toHaveCount(2)

  const outer = page.locator('.notes-tag-directive[data-tag-tag="outer"]')
  const inner = page.locator('.notes-tag-directive[data-tag-tag="inner"]')
  await expect(outer).toHaveCount(1)
  await expect(inner).toHaveCount(1)

  // The inner directive block is nested inside the outer one.
  await expect(outer.locator('.notes-tag-directive')).toHaveCount(1)
  await expect.poll(() => inner.evaluate((element) => element.parentElement?.closest('.notes-tag-directive')?.getAttribute('data-tag-tag'))).toBe('outer')

  // Tag colors are derived from the tag name — 'outer' and 'inner' must differ.
  const tagColor = (locator: typeof outer) => locator.evaluate((element) => getComputedStyle(element).getPropertyValue('--notes-tag-color').trim())
  await expect.poll(() => tagColor(outer)).not.toBe('')
  const [outerColor, innerColor] = await Promise.all([tagColor(outer), tagColor(inner)])
  expect(outerColor).not.toBe(innerColor)

  // The caret moves between inner and outer tag content like normal text.
  await setCaretAtText(root, 'inner line', 0)
  await page.keyboard.press('ArrowUp')
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toBe('outer first')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toBe('outer last')
})

test('moving a line out of an inner tag boundary with alt-arrow', async ({ page }) => {
  await page.goto('/prototype?scenario=nested-tags')
  const root = editorFor(page)
  await setCaretAtText(root, 'inner line', 0)
  await page.keyboard.press('Alt+ArrowDown')
  // The line escapes the inner tag into the outer tag, landing before 'outer
  // last'. Blank-line separation may vary; ordering is what matters.
  await expectSource(page, /:::\n\n?inner line\n\n?outer last/u)
})

test('removing a tag via its chip lands the caret sensibly', async ({ page }) => {
  await page.goto('/prototype?scenario=nested-tags')
  const root = editorFor(page)
  await setCaretAtText(root, 'inner line', 0)

  // Both enclosing tags surface as active chips (chip text is "<tag>×").
  const chips = page.locator('.notes-editor-active-tag')
  await expect.poll(async () => (await chips.allTextContents()).map((text) => text.replace(/×$/u, '').trim()).sort()).toEqual(['inner', 'outer'])

  await page.getByLabel('Remove inner', { exact: true }).click()

  // Only the inner :::tag{name="inner"} / ::: pair is removed.
  await expectSource(page, /:::tag\{name="outer"\}\nouter first\n\n?inner line\n\n?outer last\n:::/u)

  // The inner chip disappears; the outer tag remains active.
  await expect.poll(async () => (await chips.allTextContents()).map((text) => text.replace(/×$/u, '').trim())).toEqual(['outer'])

  // The caret lands back on 'inner line'. With the inner directive gone the
  // body's adjacent lines merge into one paragraph, so assert the caret
  // offset points at 'inner line' inside whatever block contains it.
  await expect.poll(async () => {
    const snapshot = await selectionSnapshot(page)
    const index = snapshot.blockText.indexOf('inner line')
    return index >= 0 && snapshot.anchorOffset >= index && snapshot.anchorOffset <= index + 'inner line'.length
  }).toBe(true)
})

test('tag names with spaces, unicode, and quotes round-trip', async ({ page }) => {
  await page.goto('/prototype?scenario=special-tag-names')
  const root = editorFor(page)
  const directives = page.locator('.notes-tag-directive')
  await expect(directives).toHaveCount(3)

  // The source stores a&quot;b — the rendered attribute should decode it.
  await expect(directives.nth(0)).toHaveAttribute('data-tag-tag', 'spring launch')
  await expect(directives.nth(1)).toHaveAttribute('data-tag-tag', 'üñícode ✨')
  await expect(directives.nth(2)).toHaveAttribute('data-tag-tag', 'a"b')

  await setCaretAtText(root, 'quoted', 0)
  await expect.poll(async () => (await page.locator('.notes-editor-active-tag').allTextContents()).map((text) => text.replace(/×$/u, '').trim())).toEqual(['a"b'])
})

test('creating a tag with a space via the toolbar input', async ({ page }) => {
  await page.goto('/prototype?scenario=tagging')
  const root = editorFor(page)
  await setCaretAtText(root, 'second line', 0)
  await page.getByLabel('Tag name').click()
  await page.keyboard.type('spring launch')
  await page.keyboard.press('Enter')
  await expectSource(page, /:::tag\{name="spring launch"\}\nsecond line\n:::/u)
})
