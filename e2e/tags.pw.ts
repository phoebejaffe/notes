import { expect, test } from '@playwright/test'
import { editorFor, expectSource, selectRenderedRange, selectRenderedText, selectionSnapshot, setCaretAtText } from './support/editor'

test('tagging a collapsed caret wraps the complete containing line', async ({ page }) => {
  await page.goto('/prototype?scenario=tagging')
  const root = editorFor(page)
  await setCaretAtText(root, 'second line', 0)
  await page.getByLabel('Tag name').fill('therapy')
  await page.keyboard.press('Enter')
  await expectSource(page, /first line\n:::tag\{name="therapy"\}\nsecond line\n:::\nthird line/u)
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toContain('second line')
})

test('tagging a multi-line selection expands to complete lines and preserves surrounding text', async ({ page }) => {
  await page.goto('/prototype?scenario=tagging')
  const root = editorFor(page)
  await selectRenderedRange(root, 'first line', 'second line')
  await page.getByLabel('Tag name').fill('multi line')
  await page.keyboard.press('Enter')
  await expectSource(page, /prefix alpha\n:::tag\{name="multi line"\}\nfirst line\nsecond line\n:::\nthird line\nsuffix omega/u)
})

test('tagging formatted content keeps the rendered selection active', async ({ page }) => {
  await page.goto('/prototype?scenario=formatting')
  const root = editorFor(page)
  await selectRenderedText(root, 'plain target text')
  const before = await selectionSnapshot(page)
  await page.getByLabel('Tag name').fill('review')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await selectionSnapshot(page)).text).toBe(before.text)
})
