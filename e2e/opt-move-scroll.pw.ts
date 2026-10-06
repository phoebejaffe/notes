import { expect, test, type Page } from '@playwright/test'
import { setCaretAtText } from './support/editor'

// Opt-Up/Down re-imports the document and re-places the caret. Nothing in
// that path should move the scroll position unless the caret actually leaves
// the visible band — Lexical's own update-driven scroll-into-view targets the
// transient reconciled selection, not the restored caret, and must be undone.

async function seedApp(page: Page, markdown: string) {
  await page.addInitScript(() => {
    localStorage.setItem('notes-preferences', JSON.stringify({ onboardingDismissed: true, syncPromptDismissed: true }))
  })
  await page.goto('/')
  await expect(page.locator('.day-card').first()).toBeVisible()
  await page.evaluate(async (source) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('notes-local', 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction('named-documents', 'readwrite')
    transaction.objectStore('named-documents').put({ id: 'n1', title: 'Scratch', markdown: source, lane: 1, order: 0, collapsed: false, deleted: false, updatedAt: Date.now() })
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  }, markdown)
  await page.reload()
  await expect(page.locator('.day-card').first()).toBeVisible()
}

const TALL_DOC = Array.from({ length: 80 }, (_, index) => `line ${index}`).join('\n\n')

for (const direction of ['down', 'up'] as const) {
  test(`opt-${direction} does not scroll while the caret stays in view`, async ({ page }) => {
    await seedApp(page, TALL_DOC)
    const editor = page.locator('.lane[data-lane="1"] .note-card .mdxeditor-root-contenteditable')
    const scroller = page.locator('.lane[data-lane="1"] .note-stream')

    await setCaretAtText(editor, 'line 40', 0)
    // Park the caret near the top of the visible band — in view, but far from
    // centered, so any "scroll to center" would register as a jump.
    await scroller.evaluate((element) => { element.scrollTop += 160 })
    await page.waitForTimeout(50)
    const before = await scroller.evaluate((element) => element.scrollTop)

    await page.keyboard.press(direction === 'down' ? 'Alt+ArrowDown' : 'Alt+ArrowUp')
    await expect.poll(async () => page.locator('.note-card .mdxeditor-root-contenteditable').textContent()).toContain(direction === 'down' ? 'line 41' : 'line 39')
    await page.waitForTimeout(100)

    const after = await scroller.evaluate((element) => element.scrollTop)
    expect(Math.abs(after - before)).toBeLessThan(30)
  })
}
