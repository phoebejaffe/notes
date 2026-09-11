import { expect, test } from '@playwright/test'

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
