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

test('a caret moved off-screen scrolls back into the visible band', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 500 })
  await page.goto('/prototype?scenario=scroll')
  const root = editorFor(page)

  // Jump to the bottom of the document with Cmd-Down — the caret lands on
  // 'bottom marker', which is far below the fold, so the scroll must follow
  // and center it in the visible band (below the fixed toolbar).
  await setCaretAtText(root, 'top marker', 0)
  await page.keyboard.press('Meta+ArrowDown')
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toContain('bottom marker')
  await expect.poll(async () => {
    const snapshot = await selectionSnapshot(page)
    const bandTop = await page.evaluate(() => {
      const toolbar = [...document.querySelectorAll<HTMLElement>('.mdxeditor-toolbar')]
        .find((element) => getComputedStyle(element).display !== 'none')
      return toolbar ? toolbar.getBoundingClientRect().bottom : 0
    })
    const bandCenter = (bandTop + 500) / 2
    return snapshot.caretTop > bandTop && snapshot.caretTop < 500 && Math.abs(snapshot.caretTop - bandCenter) < 40
  }).toBe(true)

  // And back: Cmd-Up returns to the top — the caret is re-centered rather
  // than left above the viewport.
  await page.keyboard.press('Meta+ArrowUp')
  await expect.poll(async () => (await selectionSnapshot(page)).anchorOffset).toBe(0)
  await expect.poll(async () => (await selectionSnapshot(page)).caretTop).toBeGreaterThan(100)
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
