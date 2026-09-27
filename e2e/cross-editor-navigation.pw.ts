import { expect, test } from '@playwright/test'
import { selectionSnapshot, setCaretAtText } from './support/editor'

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
  // Up moves into the leading tag, up again lands in the boundary paragraph
  // above it, and the third up crosses into the previous day's last line.
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.type('!')
  await expect(day1).toContainText('Tagged content in day one!')
  await expect.poll(async () => (await selectionSnapshot(page)).collapsed).toBe(true)
})

test('ArrowUp from the start of the second line lands on the first line, not the editor above', async ({ page }) => {
  await page.goto('/prototype?multi&empty')
  const cards = page.locator('.day-card')
  const day2 = cards.nth(1).locator('.mdxeditor-root-contenteditable')
  const day3 = cards.nth(2).locator('.mdxeditor-root-contenteditable')
  await setCaretAtText(day3, 'Second paragraph here.', 0)
  await page.keyboard.press('ArrowUp')
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toBe('Plain day with only untagged content.')
  await expect.poll(async () => (await selectionSnapshot(page)).anchorOffset).toBe(0)
  await page.keyboard.type('!')
  await expect(day3).toContainText('!Plain day with only untagged content.')
  await expect(day2).not.toContainText('!')
})

test('arrows cross into and out of an empty editor', async ({ page }) => {
  await page.goto('/prototype?multi&empty')
  const cards = page.locator('.day-card')
  const day1 = cards.nth(0).locator('.mdxeditor-root-contenteditable')
  const day2 = cards.nth(1).locator('.mdxeditor-root-contenteditable')
  const day3 = cards.nth(2).locator('.mdxeditor-root-contenteditable')

  // Down from day1's bottom lands inside the empty day2, which accepts typing.
  await day1.click()
  await page.keyboard.press('Meta+ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.type('!')
  await expect(day2).toContainText('!')
  await expect(day3).not.toContainText('!')

  // Down again crosses straight out of the (single-line) editor into day3.
  await page.keyboard.press('ArrowDown')
  await page.keyboard.type('@')
  await expect(day3).toContainText('@Plain day with only untagged content.')

  // Up from day3's top re-enters day2, and up once more reaches day1.
  await day3.locator('p', { hasText: 'Plain day' }).click()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.type('#')
  await expect(day2).toContainText('!#')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.type('%')
  await expect(day1).toContainText('Tagged content in day one%')
})

test('modified arrows do not invoke cross-editor navigation', async ({ page }) => {
  await page.goto('/prototype?multi')
  const day2 = page.locator('.day-card').nth(1).locator('.mdxeditor-root-contenteditable')
  await day2.locator('p', { hasText: 'This day starts with a tag' }).click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Alt+ArrowUp')
  await expect(day2).toContainText('This day starts with a tag')
})
