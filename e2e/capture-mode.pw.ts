import { expect, test, type Page } from '@playwright/test'

// The capture window (?mode=capture) renders the real App, so these tests seed
// IndexedDB/localStorage before the app loads documents.

function dayKey(offset: number) {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  return date.toLocaleDateString('en-CA')
}

async function seedCaptureApp(page: Page, docs: Record<string, string>) {
  await page.goto('/?mode=capture')
  await page.evaluate((records) => {
    localStorage.setItem('notes-preferences', JSON.stringify({ onboardingDismissed: true, syncPromptDismissed: true }))
    return new Promise<void>((resolve) => {
      const request = indexedDB.open('notes-local', 2)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains('daily-documents')) db.createObjectStore('daily-documents', { keyPath: 'day' })
        if (!db.objectStoreNames.contains('named-documents')) db.createObjectStore('named-documents', { keyPath: 'id' })
      }
      request.onsuccess = () => {
        const tx = request.result.transaction('daily-documents', 'readwrite')
        const store = tx.objectStore('daily-documents')
        for (const [day, markdown] of Object.entries(records)) store.put({ day, markdown, updatedAt: Date.now() })
        tx.oncomplete = () => resolve()
      }
      request.onerror = () => resolve()
    })
  }, docs)
  await page.reload()
  await page.locator('.day-card').first().waitFor()
}

test('the capture toolbar acts on the focused editor, not a stacked sibling', async ({ page }) => {
  await seedCaptureApp(page, {
    [dayKey(0)]: 'first line\n\nmiddle target line\n\nlast line',
    [dayKey(-1)]: 'yesterday note',
  })

  // Caret on today's middle line.
  const todayCard = page.locator('.day-card').first()
  const todayEditable = todayCard.locator('.mdxeditor-root-contenteditable')
  await todayEditable.getByText('middle target line').click()
  await expect.poll(async () => (await page.evaluate(() => window.getSelection()?.anchorNode?.textContent ?? ''))).toBe('middle target line')

  // Exactly one toolbar renders in the capture shell — before the fix every
  // card's toolbar was display:flex stacked at the same fixed position, and
  // clicks landed on the topmost (a different day's) toolbar.
  await expect.poll(async () => page.evaluate(() =>
    [...document.querySelectorAll('.mdxeditor-toolbar')]
      .filter((t) => getComputedStyle(t).display !== 'none').length)).toBe(1)

  // Click the tag input — the focused (today's) input must receive focus.
  const input = todayCard.locator('input[aria-label="Tag name"]')
  await input.click()
  await expect.poll(async () => page.evaluate(() =>
    [...document.querySelectorAll('input[aria-label="Tag name"]')].indexOf(document.activeElement))).toBe(0)

  await input.fill('capture-tag')
  await todayCard.locator('button', { hasText: '+ Tag' }).click()

  // The tag wraps the caret line in today's editor.
  await expect(todayCard.locator('.notes-tag-directive')).toContainText('middle target line')
  await expect(todayCard.locator('.notes-editor-active-tag')).toHaveText(/capture-tag/u)
})
