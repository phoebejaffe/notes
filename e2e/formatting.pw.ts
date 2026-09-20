import { expect, test } from '@playwright/test'
import { editorFor, expectSource, selectRenderedText, selectionSnapshot, setCaretAtText } from './support/editor'

test('bold and italic shortcuts preserve the selected text', async ({ page }) => {
  await page.goto('/prototype?scenario=formatting')
  const root = editorFor(page)
  await selectRenderedText(root, 'plain target text')
  const beforeBold = await selectionSnapshot(page)
  await page.keyboard.press('Meta+b')
  await expectSource(page, /\*\*plain target text\*\*/u)
  await expect.poll(async () => (await selectionSnapshot(page)).text).toBe(beforeBold.text)

  await selectRenderedText(root, 'link text')
  const beforeItalic = await selectionSnapshot(page)
  await page.keyboard.press('Meta+i')
  await expectSource(page, /\*link text\*/u)
  await expect.poll(async () => (await selectionSnapshot(page)).text).toBe(beforeItalic.text)
})

test('the formatting toolbar follows selections and stays legible in dark mode', async ({ page }) => {
  await page.goto('/prototype?scenario=formatting')
  const root = editorFor(page)
  await selectRenderedText(root, 'plain target text')
  const toolbar = page.locator('.mdxeditor-toolbar')
  await expect(toolbar).toBeVisible()

  await page.locator('.markdown-prototype-page').evaluate((element) => element.classList.add('theme-dark'))
  const styles = await page.getByRole('radio', { name: 'Bulleted list' }).evaluate((button) => ({
    buttonColor: getComputedStyle(button).color,
    iconColor: getComputedStyle(button.querySelector('svg')!).color,
    background: getComputedStyle(button).backgroundColor,
  }))
  expect(styles.buttonColor).toBe('rgb(232, 226, 220)')
  expect(styles.iconColor).toBe('rgb(245, 241, 237)')
  expect(styles.background).toBe('rgb(47, 44, 49)')

  const tagInput = page.getByLabel('Tag name')
  await tagInput.click()
  await expect(tagInput).toBeFocused()
  await expect(toolbar).toBeVisible()
})

test('the capture shell keeps the formatting toolbar visible without DOM focus', async ({ page }) => {
  await page.goto('/prototype?scenario=formatting')
  await page.locator('.markdown-prototype-page').evaluate((element) => element.classList.add('capture-shell'))

  const tagInput = page.getByLabel('Tag name')
  await tagInput.click()
  await expect(tagInput).toBeFocused()
  await tagInput.evaluate((input) => input.blur())
  await expect.poll(async () => page.evaluate(() => document.activeElement === document.body)).toBe(true)

  await expect(page.locator('.mdxeditor-toolbar')).toBeVisible()
})

test('typing after a collapsed formatted caret stays in the active block', async ({ page }) => {
  await page.goto('/prototype?scenario=formatting')
  const root = editorFor(page)
  await setCaretAtText(root, 'plain target text', 0)
  await page.keyboard.press('Meta+b')
  await page.keyboard.type('new ')
  await expect(root).toContainText('new plain target text')
  await expectSource(page, /\*\*new\*\* plain target text/u)
})
