import { expect, test, type Page } from '@playwright/test'
import { editorFor, expectSource, selectRenderedText, selectionSnapshot, setCaretAtText, sourceFor } from './support/editor'

const sourceText = async (page: Page) => (await sourceFor(page).textContent()) ?? ''

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

test('the formatting bar is always rendered and enabled only for the focused editor', async ({ page }) => {
  await page.goto('/prototype?multi')
  const cards = page.locator('.day-card')
  await expect(cards).toHaveCount(3)

  // Nothing focused: exactly one bar shows — the first card's, disabled.
  const visibleBar = page.locator('.mdxeditor-toolbar:visible')
  await expect(visibleBar).toHaveCount(1)
  await expect.poll(() => visibleBar.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none')

  // Focusing another editor enables its bar and hides the placeholder.
  await cards.nth(1).locator('.mdxeditor-root-contenteditable').click()
  const focusedBar = cards.nth(1).locator('.mdxeditor-toolbar')
  await expect(focusedBar).toBeVisible()
  await expect(cards.nth(0).locator('.mdxeditor-toolbar')).toBeHidden()
  await expect.poll(() => focusedBar.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('auto')
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

test.describe('the link toolbar control', () => {
  test('applies a URL to the selected text', async ({ page }) => {
    await page.goto('/prototype?scenario=plain-text')
    const root = editorFor(page)

    await selectRenderedText(root, 'alpha target middle')
    await page.getByRole('button', { name: 'Edit link' }).click()
    const input = page.getByLabel('Link URL')
    await expect(input).toBeVisible()
    await input.fill('example.com/docs')
    await page.getByRole('button', { name: 'Save' }).click()

    // formatUrl adds the missing scheme before the link is stored.
    await expectSource(page, /\[alpha target middle\]\(https:\/\/example\.com\/docs\)/u)
    const anchor = root.locator('a', { hasText: 'alpha target middle' })
    await expect(anchor).toHaveAttribute('href', 'https://example.com/docs')
  })

  test('prefills the link under the caret and removes it', async ({ page }) => {
    await page.goto('/prototype?scenario=formatting')
    const root = editorFor(page)

    await selectRenderedText(root, 'link text')
    await page.getByRole('button', { name: 'Edit link' }).click()
    const input = page.getByLabel('Link URL')
    await expect(input).toHaveValue('https://example.com')
    await page.getByRole('button', { name: 'Remove' }).click()

    await expect.poll(async () => sourceText(page)).toMatch(/^link text with trailing text$/mu)
    const source = await sourceText(page)
    expect(source).not.toContain('https://example.com')
    await expect(root.locator('a', { hasText: 'link text' })).toHaveCount(0)
  })

  test('edits the URL of the link under the caret', async ({ page }) => {
    await page.goto('/prototype?scenario=formatting')
    const root = editorFor(page)

    await selectRenderedText(root, 'link text')
    await page.getByRole('button', { name: 'Edit link' }).click()
    const input = page.getByLabel('Link URL')
    await input.fill('https://new.example.org')
    await page.getByRole('button', { name: 'Save' }).click()

    await expectSource(page, /\[link text\]\(https:\/\/new\.example\.org\)/u)
  })
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
