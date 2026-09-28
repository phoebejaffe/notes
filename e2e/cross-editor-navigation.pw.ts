import { expect, test } from '@playwright/test'
import { selectionSnapshot, setCaretAtText } from './support/editor'

test('plain ArrowDown crosses from the last line to the next editor', async ({ page }) => {
  await page.goto('/prototype?multi')
  const cards = page.locator('.day-card')
  const day1 = cards.nth(0).locator('.mdxeditor-root-contenteditable')
  const day2 = cards.nth(1).locator('.mdxeditor-root-contenteditable')
  await setCaretAtText(day1, 'Tagged content in day one', 0)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.type('!')
  await expect(day2).toContainText('!This day starts with a tag')
})

test('plain ArrowUp from the first line crosses to the previous editor', async ({ page }) => {
  await page.goto('/prototype?multi')
  const cards = page.locator('.day-card')
  const day1 = cards.nth(0).locator('.mdxeditor-root-contenteditable')
  const day2 = cards.nth(1).locator('.mdxeditor-root-contenteditable')
  await setCaretAtText(day2, 'Untagged content after the leading tag', 0)
  // Up moves into the leading tag, up again lands in the boundary paragraph
  // above it, and the third up crosses into the previous day's last line —
  // at the caret's x position (the line start here).
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.type('!')
  await expect(day1).toContainText('!Tagged content in day one')
  await expect.poll(async () => (await selectionSnapshot(page)).collapsed).toBe(true)
})

test('crossing editors preserves the caret x position', async ({ page }) => {
  await page.goto('/prototype?multi')
  const cards = page.locator('.day-card')
  const day3 = cards.nth(2).locator('.mdxeditor-root-contenteditable')

  // Mid-line caret on day3's first line crosses up into day2's last line at
  // roughly the same x — like arrowing up within a paragraph, not jumping to
  // the line's start or end.
  await setCaretAtText(day3, 'Plain day with only untagged content.', 15)
  const before = await selectionSnapshot(page)
  await page.keyboard.press('ArrowUp')
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toBe('Untagged content after the leading tag')
  const after = await selectionSnapshot(page)
  expect(Math.abs(after.caretLeft - before.caretLeft)).toBeLessThan(16)
  expect(after.anchorOffset).toBeGreaterThan(5)

  // Symmetric on the way back down: same x, same day3 line.
  await page.keyboard.press('ArrowDown')
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toBe('Plain day with only untagged content.')
  const back = await selectionSnapshot(page)
  expect(Math.abs(back.caretLeft - before.caretLeft)).toBeLessThan(16)
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

  // Up from day3's top re-enters day2 at the caret's x (line start here),
  // and up once more reaches day1.
  await setCaretAtText(day3, '@Plain day', 0)
  await page.keyboard.press('ArrowUp')
  await page.keyboard.type('#')
  await expect(day2).toContainText('#!')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.type('%')
  await expect(day1).toContainText('%')
})

test('Cmd-Opt-Arrow jumps to the editor below or above from anywhere', async ({ page }) => {
  await page.goto('/prototype?multi')
  const cards = page.locator('.day-card')
  const day1 = cards.nth(0).locator('.mdxeditor-root-contenteditable')
  const day2 = cards.nth(1).locator('.mdxeditor-root-contenteditable')
  const day3 = cards.nth(2).locator('.mdxeditor-root-contenteditable')

  // From mid-line in the middle of day2, Cmd-Opt-Down lands on day3's first
  // line — no need to reach the editor's bottom edge first.
  await setCaretAtText(day2, 'Untagged content after the leading tag', 10)
  await page.keyboard.press('Meta+Alt+ArrowDown')
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toBe('Plain day with only untagged content.')
  await page.keyboard.type('!')
  await expect(day3).toContainText('!')

  // And back up: Cmd-Opt-Up lands on day2's first line — jumps always land
  // at the top of the destination editor.
  await page.keyboard.press('Meta+Alt+ArrowUp')
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toBe('This day starts with a tag')
  await page.keyboard.type('@')
  await expect(day2).toContainText('@')
  await expect(day1).not.toContainText('@')
})

test('Cmd-Arrow moves the caret to the top or bottom of the editor', async ({ page }) => {
  await page.goto('/prototype?multi')
  const day2 = page.locator('.day-card').nth(1).locator('.mdxeditor-root-contenteditable')

  await setCaretAtText(day2, 'Untagged content after the leading tag', 5)
  await page.keyboard.press('Meta+ArrowDown')
  await expect.poll(async () => (await selectionSnapshot(page)).anchorOffset).toBe('Untagged content after the leading tag'.length)
  const end = await selectionSnapshot(page)
  expect(end.blockText).toBe('Untagged content after the leading tag')

  await page.keyboard.press('Meta+ArrowUp')
  await expect.poll(async () => (await selectionSnapshot(page)).anchorOffset).toBe(0)
  const start = await selectionSnapshot(page)
  expect(start.blockText).toBe('This day starts with a tag')
})

test('modified arrows do not invoke cross-editor navigation', async ({ page }) => {
  await page.goto('/prototype?multi')
  const day2 = page.locator('.day-card').nth(1).locator('.mdxeditor-root-contenteditable')
  await day2.locator('p', { hasText: 'This day starts with a tag' }).click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Alt+ArrowUp')
  await expect(day2).toContainText('This day starts with a tag')
})
