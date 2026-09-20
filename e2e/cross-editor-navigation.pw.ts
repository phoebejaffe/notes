import { expect, test } from '@playwright/test'
import { selectionSnapshot } from './support/editor'

test('plain ArrowDown crosses from the last line to the next editor', async ({ page }) => {
  await page.goto('/prototype?multi')
  const cards = page.locator('.day-card')
  const day1 = cards.nth(0).locator('.mdxeditor-root-contenteditable')
  const day2 = cards.nth(1).locator('.mdxeditor-root-contenteditable')
  await day1.click()
  await page.keyboard.press('Meta+ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.type('!')
  await expect(day2).toContainText('!This day starts with a tag')
})

test('plain ArrowUp from the first line crosses to the previous editor', async ({ page }) => {
  await page.goto('/prototype?multi')
  const cards = page.locator('.day-card')
  const day1 = cards.nth(0).locator('.mdxeditor-root-contenteditable')
  const day2 = cards.nth(1).locator('.mdxeditor-root-contenteditable')
  await day2.locator('p', { hasText: 'Untagged content after the leading tag' }).click()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.type('!')
  await expect(day1).toContainText('Tagged content in day one!')
  await expect.poll(async () => (await selectionSnapshot(page)).collapsed).toBe(true)
})

test('modified arrows do not invoke cross-editor navigation', async ({ page }) => {
  await page.goto('/prototype?multi')
  const day2 = page.locator('.day-card').nth(1).locator('.mdxeditor-root-contenteditable')
  await day2.locator('p', { hasText: 'This day starts with a tag' }).click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Alt+ArrowUp')
  await expect(day2).toContainText('This day starts with a tag')
})
