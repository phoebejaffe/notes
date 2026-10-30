import { expect, test, type Page } from '@playwright/test'

async function seedApp(page: Page, notes: { id: string; title: string; markdown: string; lane: number; order: number }[] = []) {
  await page.addInitScript(() => {
    localStorage.setItem('notes-preferences', JSON.stringify({ onboardingDismissed: true, syncPromptDismissed: true }))
  })
  await page.goto('/')
  await expect(page.locator('.day-card').first()).toBeVisible()
  if (notes.length) {
    await page.evaluate(async (records) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('notes-local', 2)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const transaction = database.transaction('named-documents', 'readwrite')
      records.forEach((record) => transaction.objectStore('named-documents').put({ collapsed: false, deleted: false, updatedAt: Date.now(), ...record }))
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
      })
    }, notes)
    await page.reload()
    await expect(page.locator('.day-card').first()).toBeVisible()
  }
}

async function openManageLanes(page: Page) {
  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.getByRole('button', { name: 'Manage lanes' }).click()
  await expect(page.locator('.settings-modal')).toBeVisible()
}

test('adds an empty lane that persists across reloads', async ({ page }) => {
  await seedApp(page)
  await expect(page.locator('.lane')).toHaveCount(1)

  await openManageLanes(page)
  await page.getByRole('button', { name: '+ Add lane' }).click()
  await page.locator('.modal-close').click()

  await expect(page.locator('.lane')).toHaveCount(2)
  // The empty lane is config-covered, so it survives a reload.
  await page.reload()
  await expect(page.locator('.lane')).toHaveCount(2)
})

test('reorders lanes and moves their notes with them', async ({ page }) => {
  await seedApp(page, [
    { id: 'n1', title: 'Alpha', markdown: 'a', lane: 1, order: 0 },
    { id: 'n2', title: 'Beta', markdown: 'b', lane: 2, order: 0 },
  ])
  await expect(page.locator('.lane')).toHaveCount(3)

  await openManageLanes(page)
  await page.getByRole('button', { name: 'Move lane 2 earlier' }).click()
  await page.locator('.modal-close').click()

  // Beta's lane moved first; Alpha shifted to the second lane.
  await expect(page.locator('.lane[data-lane="1"] .note-title')).toContainText('Beta')
  await expect(page.locator('.lane[data-lane="2"] .note-title')).toContainText('Alpha')
})

test('disabling a lane hides it and dims its notes in the move picker', async ({ page }) => {
  await seedApp(page, [
    { id: 'n1', title: 'Hidden lane note', markdown: 'body', lane: 1, order: 0 },
    { id: 'n2', title: 'Visible lane note', markdown: 'body', lane: 2, order: 0 },
  ])
  await expect(page.locator('.lane')).toHaveCount(3)

  await openManageLanes(page)
  await page.getByRole('button', { name: 'Disable' }).first().click()
  await page.locator('.modal-close').click()

  // Only the enabled lane remains in the track.
  await expect(page.locator('.lane')).toHaveCount(2)
  await expect(page.locator('.note-title')).toContainText('Visible lane note')
  await expect(page.locator('.note-title', { hasText: 'Hidden lane note' })).toHaveCount(0)

  // The note still exists — it appears dimmed under its own section in the
  // move-lines target picker.
  const todayEditor = page.locator('.day-card .mdxeditor-root-contenteditable').first()
  await todayEditor.click()
  await page.keyboard.type('a line')
  await page.keyboard.press('Control+M')
  const dialog = page.locator('.move-lines-dialog')
  await expect(dialog.locator('.move-lines-section', { hasText: 'Disabled lanes' })).toBeVisible()
  const target = dialog.getByRole('button', { name: 'Hidden lane note' })
  await expect(target).toHaveClass(/move-target-dimmed/)
  await expect(dialog.getByRole('button', { name: 'Visible lane note' })).not.toHaveClass(/move-target-dimmed/)
  await page.keyboard.press('Escape')
})

test('deleting a lane tombstones its notes', async ({ page }) => {
  await seedApp(page, [
    { id: 'n1', title: 'Keep', markdown: 'a', lane: 1, order: 0 },
    { id: 'n2', title: 'Drop', markdown: 'b', lane: 2, order: 0 },
  ])
  await expect(page.locator('.lane')).toHaveCount(3)

  await openManageLanes(page)
  const row = page.locator('.lane-row', { hasText: 'Lane 2' })
  await row.getByRole('button', { name: 'Delete' }).click()
  await page.getByRole('button', { name: /Delete \+ 1 note\?/ }).click()
  await page.locator('.modal-close').click()

  await expect(page.locator('.lane')).toHaveCount(2)
  await expect(page.locator('.note-card')).toHaveCount(1)
  await expect(page.locator('.note-title')).toContainText('Keep')
})

test('moving a note left or right skips disabled lanes', async ({ page }) => {
  await seedApp(page, [
    { id: 'n1', title: 'First', markdown: 'a', lane: 1, order: 0 },
    { id: 'n2', title: 'Middle', markdown: 'b', lane: 2, order: 0 },
    { id: 'n3', title: 'Last', markdown: 'c', lane: 3, order: 0 },
  ])
  await openManageLanes(page)
  await page.locator('.lane-row').nth(1).getByRole('button', { name: 'Disable' }).click()
  await page.locator('.modal-close').click()

  // Lane 2 is hidden; moving Last left jumps straight to lane 1.
  const card = page.locator('.note-card[data-note-id="n3"]')
  await card.locator('.icon-button').click()
  await page.getByRole('button', { name: 'Move left' }).click()
  await expect(page.locator('.lane[data-lane="1"] .note-card[data-note-id="n3"]')).toBeVisible()
})
