import { expect, test, type Locator } from '@playwright/test'
import { editorFor, setCaretAtText, sourceFor } from './support/editor'

async function dragGesture(button: Locator, dx: number, dy: number) {
  await button.dispatchEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, bubbles: true })
  const steps = 4
  for (let i = 1; i <= steps; i += 1) {
    await button.dispatchEvent('pointermove', { pointerId: 1, clientX: 100 + (dx * i) / steps, clientY: 100 + (dy * i) / steps, bubbles: true })
  }
  await button.dispatchEvent('pointerup', { pointerId: 1, clientX: 100 + dx, clientY: 100 + dy, bubbles: true })
}

test('gesture button is hidden on fine pointers and visible on touch', async ({ page, browser }) => {
  await page.goto('/prototype?scenario=list-movement')
  const editor = editorFor(page)
  await editor.click()
  await expect(page.locator('.notes-editor-gesture-button')).toBeHidden()

  const context = await browser.newContext({ hasTouch: true })
  const touchPage = await context.newPage()
  await touchPage.goto('/prototype?scenario=list-movement')
  await editorFor(touchPage).click()
  await expect(touchPage.locator('.notes-editor-gesture-button')).toBeVisible()
  await context.close()
})

test('dragging up and down moves the caret line', async ({ page }) => {
  await page.goto('/prototype?scenario=list-movement')
  const editor = editorFor(page)
  await editor.click()
  const button = page.locator('.notes-editor-gesture-button')
  await setCaretAtText(editor, 'third item', 2)

  // List items move one source line per gesture: 'third item' ends up above
  // 'second child two' (the line directly above it), then back below.
  await dragGesture(button, 0, -40)
  await expect.poll(async () => {
    const source = (await sourceFor(page).textContent()) ?? ''
    return source.indexOf('- third item') >= 0 && source.indexOf('- third item') < source.indexOf('second child two')
  }).toBe(true)

  await dragGesture(button, 0, 40)
  await expect.poll(async () => {
    const source = (await sourceFor(page).textContent()) ?? ''
    return source.indexOf('- third item') > source.indexOf('second child two')
  }).toBe(true)
})

test('dragging right indents and dragging left outdents list lines', async ({ page }) => {
  await page.goto('/prototype?scenario=list-movement')
  const editor = editorFor(page)
  await editor.click()
  const button = page.locator('.notes-editor-gesture-button')

  await setCaretAtText(editor, 'third item', 2)
  await dragGesture(button, 40, 0)
  await expect.poll(async () => (await sourceFor(page).textContent()) ?? '').toContain('  - third item')

  await dragGesture(button, -40, 0)
  await expect.poll(async () => (await sourceFor(page).textContent()) ?? '').toContain('- third item\n1. ordered one')
})

test('a tap without a drag does nothing', async ({ page }) => {
  await page.goto('/prototype?scenario=list-movement')
  const editor = editorFor(page)
  await editor.click()
  const before = await sourceFor(page).textContent()
  const button = page.locator('.notes-editor-gesture-button')
  await button.dispatchEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, bubbles: true })
  await button.dispatchEvent('pointerup', { pointerId: 1, clientX: 100, clientY: 100, bubbles: true })
  await page.waitForTimeout(200)
  expect(await sourceFor(page).textContent()).toBe(before)
})
