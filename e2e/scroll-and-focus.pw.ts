import { expect, test } from '@playwright/test'
import { editorFor, expectSource, selectionSnapshot, setCaretAtText } from './support/editor'

test('editing near the bottom does not jump the document scroll position', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 500 })
  await page.goto('/prototype?scenario=scroll')
  const root = editorFor(page)
  const target = root.locator('span[data-lexical-text="true"]', { hasText: 'scrolled target' }).last()
  await target.scrollIntoViewIfNeeded()
  await setCaretAtText(root, 'scrolled target', 'scrolled target'.length)
  await page.keyboard.type(' updated')
  await expectSource(page, /scrolled target updated/u)
  await expect.poll(async () => {
    const snapshot = await selectionSnapshot(page)
    return snapshot.caretTop > 0 && snapshot.caretTop < 500 && snapshot.scrollTop > 0
  }).toBe(true)
})

test('the moved caret remains in the editor after option movement', async ({ page }) => {
  await page.goto('/prototype?scenario=line-movement')
  const root = editorFor(page)
  await setCaretAtText(root, 'second line', 1)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Alt+ArrowUp')
  await expectSource(page, /second line\nfirst line/u)
  const snapshot = await selectionSnapshot(page)
  expect(snapshot.collapsed).toBe(true)
  expect(snapshot.caretTop).toBeGreaterThan(0)
})
