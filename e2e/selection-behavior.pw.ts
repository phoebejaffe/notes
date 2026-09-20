import { expect, test } from '@playwright/test'
import { editorFor, expectSource, selectRenderedRange, selectionSnapshot } from './support/editor'

test('a multi-line selection maps to complete source lines for movement', async ({ page }) => {
  await page.goto('/prototype?scenario=line-movement')
  const root = editorFor(page)
  await selectRenderedRange(root, 'first line', 'second line')
  const before = await selectionSnapshot(page)
  await page.keyboard.press('Alt+ArrowDown')
  await expectSource(page, /third line\nfirst line\nsecond line\nsuffix omega/u)
  await expect.poll(async () => (await selectionSnapshot(page)).text).toBe(before.text)
})

test('selection across inline formatting is preserved by a tag operation', async ({ page }) => {
  await page.goto('/prototype?scenario=formatting')
  const root = editorFor(page)
  await selectRenderedRange(root, 'already bold', 'already italic')
  const before = await selectionSnapshot(page)
  await page.getByLabel('Tag name').fill('formatted')
  await page.keyboard.press('Enter')
  await expectSource(page, /:::tag\{name="formatted"\}/u)
  await expect.poll(async () => (await selectionSnapshot(page)).text).toBe(before.text)
})

test('selection at a line boundary does not modify neighboring lines', async ({ page }) => {
  await page.goto('/prototype?scenario=line-movement')
  const root = editorFor(page)
  await selectRenderedRange(root, 'second line', 'second line')
  await page.getByRole('button', { name: 'Mute selected lines' }).click()
  await expectSource(page, /first line\n%% second line\nthird line/u)
  await expectSource(page, /prefix alpha\n.*\nsuffix omega/s)
})
