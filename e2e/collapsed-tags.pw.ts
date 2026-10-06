import { expect, test } from '@playwright/test'
import { editorFor, expectSource, selectionSnapshot, setCaretAtText } from './support/editor'

// The chip is a CSS ::before — clicks land on the directive div's top band.
const CHIP = { position: { x: 8, y: 18 } }

test('a collapsed attribute in the source renders folded on load', async ({ page }) => {
  await page.goto('/prototype?scenario=collapsed-tags')
  const root = editorFor(page)
  const seeded = root.locator('.notes-tag-directive[data-tag-collapsed]')
  await expect(seeded).toHaveCount(1)
  await expect(root.getByText('seeded hidden')).toBeHidden()
  await expect(root.getByText('suffix omega')).toBeVisible()
})

test('clicking a tag chip collapses the section and writes the attribute', async ({ page }) => {
  await page.goto('/prototype?scenario=collapsed-tags')
  const root = editorFor(page)
  const work = root.locator('.notes-tag-directive').first()
  await expect(root.getByText('work inner one')).toBeVisible()
  await work.click(CHIP)
  await expect(work).toHaveAttribute('data-tag-collapsed', '')
  await expect(root.getByText('work inner one')).toBeHidden()
  await expect(root.getByText('work inner two')).toBeHidden()
  await expect(root.getByText('middle line')).toBeVisible()
  await expectSource(page, /:::tag\{name="work" collapsed="true"\}/u)
})

test('clicking a collapsed chip expands the section', async ({ page }) => {
  await page.goto('/prototype?scenario=collapsed-tags')
  const root = editorFor(page)
  const seeded = root.locator('.notes-tag-directive', { hasText: 'seeded hidden' })
  await seeded.click(CHIP)
  await expect(root.getByText('seeded hidden')).toBeVisible()
  await expect(root.locator('.notes-tag-directive[data-tag-collapsed]')).toHaveCount(0)
  await expectSource(page, /:::tag\{name="seeded"\}\nseeded hidden/u)
})

test('collapsing the section containing the caret moves it outside', async ({ page }) => {
  await page.goto('/prototype?scenario=collapsed-tags')
  const root = editorFor(page)
  await setCaretAtText(root, 'work inner one', 0)
  await root.locator('.notes-tag-directive').first().click(CHIP)
  // The nearest visible line wins — 'prefix alpha' (2 lines back) beats
  // 'middle line' (3 lines forward).
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toBe('prefix alpha')
})

test('nested tags collapse independently', async ({ page }) => {
  await page.goto('/prototype?scenario=collapsed-tags')
  const root = editorFor(page)
  const tags = root.locator('.notes-tag-directive')
  // Preorder: work, outer, inner, seeded.
  const outer = tags.nth(1)
  const inner = tags.nth(2)
  await inner.click(CHIP)
  await expect(inner).toHaveAttribute('data-tag-collapsed', '')
  await expect(root.getByText('inner line')).toBeHidden()
  await expect(root.getByText('outer line')).toBeVisible()
  await outer.click(CHIP)
  await expect(outer).toHaveAttribute('data-tag-collapsed', '')
  await expect(root.getByText('outer line')).toBeHidden()
})

test('a section can be re-collapsed after expanding', async ({ page }) => {
  await page.goto('/prototype?scenario=collapsed-tags')
  const root = editorFor(page)
  const seeded = root.locator('.notes-tag-directive', { hasText: 'seeded hidden' })
  await seeded.click(CHIP) // expands
  await expect(root.getByText('seeded hidden')).toBeVisible()
  await seeded.click(CHIP) // collapses again
  await expect(root.getByText('seeded hidden')).toBeHidden()
  await expectSource(page, /:::tag\{name="seeded" collapsed="true"\}/u)
})
