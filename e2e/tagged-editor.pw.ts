import { expect, test } from '@playwright/test'

const BLOCK_SELECTOR = '.notes-tag-directive, h1,h2,h3,h4,h5,h6,li,blockquote,pre,p:not(li p):not(blockquote p):not(.notes-tag-directive p)'

test('types inside tagged and untagged content in a single editor', async ({ page }) => {
  await page.goto('/prototype')

  const source = page.getByTestId('prototype-source')
  const root = page.locator('.mdxeditor-root-contenteditable').first()
  await expect(root).toContainText('Untagged before')
  await expect(root).toContainText('First tagged')
  await expect(root).toContainText('Untagged between')
  await expect(root).toContainText('Second tagged')

  // Type at end of "Untagged before" (untagged, before any tag)
  await root.locator('p', { hasText: 'Untagged before' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' one')
  await expect(root).toContainText('Untagged before one')

  // Type at end of "First tagged" (inside first tag block)
  await root.locator('p', { hasText: 'First tagged' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' two')
  await expect(root).toContainText('First tagged two')

  // Type at end of "Untagged between" (untagged, between tags)
  await root.locator('p', { hasText: 'Untagged between' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' three')
  await expect(root).toContainText('Untagged between three')

  // Type at end of "Second tagged" (inside second tag block)
  await root.locator('p', { hasText: 'Second tagged' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' four')
  await expect(root).toContainText('Second tagged four')

  // Verify the source markdown contains the edits in the correct regions
  const markdown = await source.textContent()
  expect(markdown).toContain('Untagged before one')
  expect(markdown).toContain('First tagged two')
  expect(markdown).toContain('Untagged between three')
  expect(markdown).toContain('Second tagged four')
})

test('arrow keys navigate across tag boundaries', async ({ page }) => {
  await page.goto('/prototype')

  const root = page.locator('.mdxeditor-root-contenteditable').first()
  await expect(root).toContainText('Untagged before')
  await expect(root).toContainText('First tagged')

  // Place caret at end of "Untagged before"
  await root.locator('p', { hasText: 'Untagged before' }).click()
  await page.keyboard.press('End')

  // ArrowDown should move into the tag block
  await page.keyboard.press('ArrowDown')
  await page.keyboard.type('!')
  // If the caret moved into "First tagged", the "!" should appear there
  await expect(root).toContainText('First tagged!')
})

test('arrow down crosses into a day that starts with a tag', async ({ page }) => {
  await page.goto('/prototype?multi')

  const cards = page.locator('.day-card')
  await expect(cards).toHaveCount(3)

  const day1Editor = cards.nth(0).locator('.mdxeditor-root-contenteditable')
  const day2Editor = cards.nth(1).locator('.mdxeditor-root-contenteditable')

  // Place caret at the very end of day1 (Cmd+End to skip past any trailing empty paragraph)
  await day1Editor.click()
  await page.keyboard.press('Meta+ArrowDown')
  await page.keyboard.press('ArrowDown')

  // Type to verify the caret landed at the start of the first editable line of day2
  await page.keyboard.type('!')
  await expect(day2Editor).toContainText('!This day starts with a tag')
})

test('arrow up moves below tag → into tag → above tag → previous day', async ({ page }) => {
  await page.goto('/prototype?multi')

  const cards = page.locator('.day-card')
  const day1Editor = cards.nth(0).locator('.mdxeditor-root-contenteditable')
  const day2Editor = cards.nth(1).locator('.mdxeditor-root-contenteditable')

  // Caret starts below the leading tag in day2
  await day2Editor.locator('p', { hasText: 'Untagged content after the leading tag' }).click()
  await page.keyboard.press('End')

  // Up 1: caret moves into the tag
  await page.keyboard.press('ArrowUp')
  const inTag = await page.evaluate(() => {
    const node = window.getSelection()?.anchorNode
    const el = node instanceof Element ? node : node?.parentElement
    return !!el?.closest('.notes-tag-directive')
  })
  expect(inTag).toBe(true)

  // Up 2: caret moves above the tag — a new paragraph at position 0
  await page.keyboard.press('ArrowUp')
  const aboveTag = await day2Editor.evaluate((el, blockSelector) => {
    const first = el.querySelector(blockSelector)
    const node = window.getSelection()?.anchorNode
    const anchorEl = node instanceof Element ? node : node?.parentElement
    return !!first && first.tagName === 'P' && !first.classList.contains('notes-tag-directive') && first.contains(anchorEl ?? null)
  }, BLOCK_SELECTOR)
  expect(aboveTag).toBe(true)

  // Up 3: caret crosses into the previous day's last line
  await page.keyboard.press('ArrowUp')
  await page.keyboard.type('!')
  await expect(day1Editor).toContainText('Tagged content in day one!')

  // The empty boundary paragraph should be cleaned up, not left in day2
  const day2FirstIsTag = await day2Editor.evaluate((el, blockSelector) => el.querySelector(blockSelector)?.classList.contains('notes-tag-directive'), BLOCK_SELECTOR)
  expect(day2FirstIsTag).toBe(true)
})

test('typing in the paragraph above a leading tag keeps it', async ({ page }) => {
  await page.goto('/prototype?multi')

  const cards = page.locator('.day-card')
  const day2Editor = cards.nth(1).locator('.mdxeditor-root-contenteditable')

  // Place caret at the start of the leading tag's first line in day2
  await day2Editor.locator('p', { hasText: 'This day starts with a tag' }).click()
  await page.keyboard.press('Home')

  // ArrowUp at the start of the leading tag should insert a paragraph before it
  await page.keyboard.press('ArrowUp')

  // Type to verify the caret is now in a new paragraph before the tag
  await page.keyboard.type('before tag')
  await expect(day2Editor).toContainText('before tag')
  await expect(day2Editor.locator('.notes-tag-directive')).toBeVisible()

  // The typed paragraph stays before the tag in the DOM
  const firstText = await day2Editor.evaluate((el, blockSelector) => el.querySelector(blockSelector)?.textContent, BLOCK_SELECTOR)
  expect(firstText).toBe('before tag')
})
