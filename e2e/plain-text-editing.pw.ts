import { expect, test } from '@playwright/test'
import { editorFor, expectSource, selectionSnapshot, setCaretAtText } from './support/editor'

test('typing in the middle of a paragraph keeps the caret after inserted text', async ({ page }) => {
  await page.goto('/prototype?scenario=plain-text')
  const root = editorFor(page)
  await setCaretAtText(root, 'alpha target middle', 1)
  await page.keyboard.type('X')
  await expect(root).toContainText('aXlpha target middle')
  await expectSource(page, /aXlpha target middle/u)
  const snapshot = await selectionSnapshot(page)
  expect(snapshot.collapsed).toBe(true)
})

test('enter and shift-enter preserve surrounding source text', async ({ page }) => {
  await page.goto('/prototype?scenario=structure')
  const root = editorFor(page)
  const target = root.locator('h1', { hasText: 'Heading target' })
  await target.click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('new paragraph')
  await expect(root).toContainText('Heading target')
  await expect(root).toContainText('new paragraph')
  await expectSource(page, /# Heading target\s+new paragraph/u)
})

test('typing immediately after tagged content does not lose the keystroke', async ({ page }) => {
  await page.goto('/prototype?scenario=structure')
  const root = editorFor(page)
  const tagged = root.locator('p', { hasText: 'tagged target' })
  await tagged.click()
  await page.keyboard.press('End')
  await page.keyboard.type('!')
  await expect(root).toContainText('tagged target!')
})
