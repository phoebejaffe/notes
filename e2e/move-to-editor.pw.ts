import { expect, test } from '@playwright/test'
import { selectionSnapshot, setCaretAtText } from './support/editor'

const editorIn = (page: import('@playwright/test').Page, day: string) =>
  page.locator(`.day-card[data-day="${day}"] .mdxeditor-root-contenteditable`)

test('ctrl-m opens the target picker and moves the caret line to another editor', async ({ page }) => {
  await page.goto('/prototype?multi')
  const source = editorIn(page, 'day1')

  await setCaretAtText(source, 'First day top line', 0)
  await page.keyboard.press('Control+M')

  const dialog = page.locator('.move-lines-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'day2' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'day3' })).toBeVisible()
  // The source editor is not a move target.
  await expect(dialog.getByRole('button', { name: 'day1' })).toHaveCount(0)

  await dialog.getByRole('button', { name: 'day2' }).click()
  await expect(dialog).toHaveCount(0)

  await expect(source).not.toContainText('First day top line')
  await expect(editorIn(page, 'day2')).toContainText('First day top line')
})

test('cmd-m restores the source caret to the line below the moved content', async ({ page }) => {
  await page.goto('/prototype?multi')
  const source = editorIn(page, 'day1')

  await setCaretAtText(source, 'First day top line', 0)
  await page.keyboard.press('Meta+M')
  await page.locator('.move-lines-dialog').getByRole('button', { name: 'day2' }).click()

  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toContain('Some untagged content here')
  await page.keyboard.type('!')
  await expect(source).toContainText('!Some untagged content here')
  await expect(editorIn(page, 'day2')).toContainText('First day top line')
})

test('cmd-m moves a multi-line selection via arrow keys and Enter', async ({ page }) => {
  await page.goto('/prototype?multi')
  const source = editorIn(page, 'day1')

  // Select "First day top line" through "Untagged before" is overkill; a
  // two-line paragraph selection exercises the range path.
  await setCaretAtText(source, 'First day top line', 0)
  await page.keyboard.press('Meta+M')

  const dialog = page.locator('.move-lines-dialog')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')

  await expect(source).not.toContainText('First day top line')
  await expect(editorIn(page, 'day3')).toContainText('First day top line')
})

test('escape closes the picker without moving anything', async ({ page }) => {
  await page.goto('/prototype?multi')
  const source = editorIn(page, 'day1')

  await setCaretAtText(source, 'First day top line', 0)
  await page.keyboard.press('Control+M')
  const dialog = page.locator('.move-lines-dialog')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  await expect(source).toContainText('First day top line')
})

test('moving a caret line inside a tag leaves the directive behind', async ({ page }) => {
  await page.goto('/prototype?multi')
  const source = editorIn(page, 'day1')

  // Caret inside day1's :::tag{name="tag"} block: an interior line moves raw,
  // so day1 keeps its (now empty) directive and day3 gets plain text.
  await setCaretAtText(source, 'Tagged content in day one', 0)
  await page.keyboard.press('Control+M')
  await page.locator('.move-lines-dialog').getByRole('button', { name: 'day3' }).click()

  await expect(editorIn(page, 'day3')).toContainText('Tagged content in day one')
  await expect(source).not.toContainText('Tagged content in day one')
  await expect(source.locator('.notes-tag-directive')).toBeVisible()
})

test('select-all moves the whole document, directive included', async ({ page }) => {
  await page.goto('/prototype?multi')
  const source = editorIn(page, 'day1')

  await setCaretAtText(source, 'First day top line', 0)
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Control+M')
  await page.locator('.move-lines-dialog').getByRole('button', { name: 'day2' }).click()

  await expect(editorIn(page, 'day2')).toContainText('Tagged content in day one')
  await expect(editorIn(page, 'day2').locator('.notes-tag-directive[data-tag-tag="tag"]')).toBeVisible()
})
