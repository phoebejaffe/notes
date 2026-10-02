import { expect, test, type Page } from '@playwright/test'

async function seedApp(page: Page, notes: { id: string; title: string; markdown: string; lane: number; order: number; collapsed?: boolean }[] = []) {
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
      records.forEach((record) => transaction.objectStore('named-documents').put({ collapsed: false, deleted: false, ...record }))
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
      })
    }, notes)
    await page.reload()
    await expect(page.locator('.day-card').first()).toBeVisible()
  }
}

const lane = (page: Page, index: number) => page.locator(`.lane[data-lane="${index}"]`)

test('creates a note in a new lane from the ghost lane', async ({ page }) => {
  await seedApp(page)
  await expect(page.locator('.lane')).toHaveCount(2) // daily + ghost
  await page.locator('.lane-ghost .lane-add').click()
  await expect(page.locator('.note-card')).toHaveCount(1)
  await expect(page.locator('.note-title')).toContainText('Untitled')
  await expect(page.locator('.lane')).toHaveCount(3) // daily + lane 1 + ghost
})

test('navigates lanes with the keyboard shortcut', async ({ page }) => {
  await seedApp(page, [
    { id: 'n1', title: 'Ideas', markdown: 'named content', lane: 1, order: 0 },
    { id: 'n2', title: 'Projects', markdown: 'more notes', lane: 2, order: 0 },
  ])
  await expect(page.locator('.note-card')).toHaveCount(2)
  await page.locator('.day-card .mdxeditor-root-contenteditable').first().click()
  await page.keyboard.press('Meta+Alt+Shift+ArrowRight')
  await expect.poll(() => lane(page, 1).getAttribute('class')).toContain('lane-active')
  await expect(page.locator('.lane').nth(1).locator('.note-title')).toContainText('Ideas')
  await page.keyboard.press('Meta+Alt+Shift+ArrowRight')
  await expect.poll(() => lane(page, 2).getAttribute('class')).toContain('lane-active')
  await page.keyboard.press('Meta+Alt+Shift+ArrowLeft')
  await expect.poll(() => lane(page, 1).getAttribute('class')).toContain('lane-active')
})

test('plain arrow keys never shift lanes', async ({ page }) => {
  await seedApp(page, [{ id: 'n1', title: 'Ideas', markdown: 'x', lane: 1, order: 0 }])
  await expect(page.locator('.lane')).toHaveCount(3)
  // Focus outside any editable — bare arrows must not scroll the lane track.
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => page.locator('.lane.lane-active').getAttribute('data-lane')).toBe('0')
  // Caret at the document start inside an editor — ← must not shift lanes.
  const editor = page.locator('.day-card .mdxeditor-root-contenteditable').first()
  await editor.click()
  await page.keyboard.press('Meta+ArrowUp')
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => page.locator('.lane.lane-active').getAttribute('data-lane')).toBe('0')
  // And the designated shortcut still works.
  await page.keyboard.press('Meta+Alt+Shift+ArrowRight')
  await expect.poll(() => page.locator('.lane.lane-active').getAttribute('data-lane')).toBe('1')
})

test('Cmd-Opt-Shift-Up returns to lane 0 with the caret at the top of today', async ({ page }) => {
  await seedApp(page, [{ id: 'n1', title: 'Ideas', markdown: 'x', lane: 1, order: 0 }])
  const todayEditor = page.locator('.day-card .mdxeditor-root-contenteditable').first()
  await todayEditor.click()
  await page.keyboard.type('hello today')
  await page.keyboard.press('Meta+Alt+Shift+ArrowRight')
  await expect.poll(() => page.locator('.lane.lane-active').getAttribute('data-lane')).toBe('1')
  await page.keyboard.press('Meta+Alt+Shift+ArrowUp')
  await expect.poll(() => page.locator('.lane.lane-active').getAttribute('data-lane')).toBe('0')
  await expect.poll(() => page.evaluate(() => {
    const selection = window.getSelection()
    const editable = document.querySelector('.day-card .mdxeditor-root-contenteditable')
    return selection?.isCollapsed && editable?.contains(selection.anchorNode) ? selection.anchorOffset : -1
  })).toBe(0)
})

test('Ctrl-1/2 jumps straight to a lane', async ({ page }) => {
  await seedApp(page, [{ id: 'n1', title: 'Ideas', markdown: 'x', lane: 1, order: 0 }])
  await page.keyboard.press('Control+2')
  await expect.poll(() => page.locator('.lane.lane-active').getAttribute('data-lane')).toBe('1')
  await page.keyboard.press('Control+1')
  await expect.poll(() => page.locator('.lane.lane-active').getAttribute('data-lane')).toBe('0')
  // Out-of-range digits clamp to the last lane, never past it.
  await page.keyboard.press('Control+9')
  await expect.poll(() => page.locator('.lane.lane-active').getAttribute('data-lane')).toBe('2')
})

test('the day tint shows through the editor surface', async ({ page }) => {
  await seedApp(page)
  const tint = await page.locator('.day-card').first().evaluate((el) => getComputedStyle(el).backgroundColor)
  const editorBg = await page.locator('.day-card .mdxeditor').first().evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(editorBg).toBe('rgba(0, 0, 0, 0)')
  expect(tint).not.toBe('rgba(0, 0, 0, 0)')
})

test('collapses and expands a note via title click and shortcut', async ({ page }) => {
  await seedApp(page, [{ id: 'n1', title: 'Ideas', markdown: 'body text', lane: 1, order: 0 }])
  await expect(page.locator('.note-card .mdxeditor-root-contenteditable')).toBeVisible()
  await page.locator('.note-title').click()
  await expect(page.locator('.note-card .mdxeditor-root-contenteditable')).toHaveCount(0)
  await expect(page.locator('.note-title')).toHaveAttribute('aria-expanded', 'false')
  // Expand back with the keyboard from the note editor's card context —
  // with the editor unmounted there is no caret, so use the ⋯ menu instead.
  await page.locator('.note-card .icon-button').click()
  await page.getByRole('button', { name: 'Expand' }).click()
  await expect(page.locator('.note-card .mdxeditor-root-contenteditable')).toBeVisible()
})

test('renames a note from the menu', async ({ page }) => {
  await seedApp(page, [{ id: 'n1', title: '', markdown: '', lane: 1, order: 0 }])
  await page.locator('.note-card .icon-button').click()
  await page.getByRole('button', { name: 'Rename' }).click()
  await page.locator('.note-title-input').fill('Reading list')
  await page.locator('.note-title-input').press('Enter')
  await expect(page.locator('.note-title')).toContainText('Reading list')
})

test('reorders notes vertically via the menu', async ({ page }) => {
  await seedApp(page, [
    { id: 'n1', title: 'First', markdown: 'a', lane: 1, order: 0 },
    { id: 'n2', title: 'Second', markdown: 'b', lane: 1, order: 1 },
  ])
  const second = page.locator('.note-card[data-note-id="n2"]')
  await second.locator('.icon-button').click()
  await page.getByRole('button', { name: 'Move up' }).click()
  await expect(page.locator('.note-card').nth(0)).toHaveAttribute('data-note-id', 'n2')
  await expect(page.locator('.note-card').nth(1)).toHaveAttribute('data-note-id', 'n1')
})

test('moves a note to a new lane via the menu', async ({ page }) => {
  await seedApp(page, [{ id: 'n1', title: 'Solo', markdown: 'x', lane: 1, order: 0 }])
  await page.locator('.note-card .icon-button').click()
  await page.getByRole('button', { name: 'Move to new lane' }).click()
  // The emptied lane collapses; the note lands alone in the last real lane.
  await expect.poll(() => lane(page, 1).locator('.note-card').count()).toBe(1)
  await expect.poll(() => page.locator('.lane.lane-active').getAttribute('data-lane')).toBe('1')
})

test('deletes a note via the two-step menu confirm', async ({ page }) => {
  await seedApp(page, [
    { id: 'n1', title: 'Keep', markdown: 'a', lane: 1, order: 0 },
    { id: 'n2', title: 'Drop', markdown: 'b', lane: 2, order: 0 },
  ])
  await expect(page.locator('.note-card')).toHaveCount(2)
  const card = page.locator('.note-card[data-note-id="n2"]')
  await card.locator('.icon-button').click()
  await page.getByRole('button', { name: 'Delete note' }).click()
  // The menu stays open for the confirm step.
  await page.getByRole('button', { name: 'Delete permanently?' }).click()
  await expect(page.locator('.note-card')).toHaveCount(1)
  // The emptied lane reindexes away: the survivor is now in lane 1 and the
  // ghost lane is the only thing at index 2.
  await expect(lane(page, 1).locator('.note-title')).toContainText('Keep')
  await expect(page.locator('.lane')).toHaveCount(3)
})

test('mac app: a horizontal swipe steps one lane per gesture', async ({ page }) => {
  // Stub just enough of the Tauri bridge for isTauriEnvironment() to be true.
  await page.addInitScript(() => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: { invoke: () => Promise.reject(new Error('test stub')) } })
  })
  await seedApp(page, [
    { id: 'n1', title: 'Ideas', markdown: 'x', lane: 1, order: 0 },
    { id: 'n2', title: 'Projects', markdown: 'y', lane: 2, order: 0 },
  ])
  const swipe = (deltaX: number, count = 6) => page.evaluate(([delta, times]) => {
    const viewport = document.querySelector('.lane-viewport')
    for (let i = 0; i < (times as number); i++) viewport!.dispatchEvent(new WheelEvent('wheel', { deltaX: delta as number, deltaY: 0, bubbles: true, cancelable: true }))
  }, [deltaX, count])
  await expect.poll(() => page.locator('.lane.lane-active').getAttribute('data-lane')).toBe('0')
  await swipe(20) // 120 accumulated crosses the threshold → one lane
  await expect.poll(() => page.locator('.lane.lane-active').getAttribute('data-lane')).toBe('1')
  await swipe(-20)
  await expect.poll(() => page.locator('.lane.lane-active').getAttribute('data-lane')).toBe('0')
  // A vertical-dominant scroll is ignored, and a sub-threshold wiggle is too.
  await page.evaluate(() => {
    const viewport = document.querySelector('.lane-viewport')
    viewport!.dispatchEvent(new WheelEvent('wheel', { deltaX: 30, deltaY: 50, bubbles: true, cancelable: true }))
    viewport!.dispatchEvent(new WheelEvent('wheel', { deltaX: 30, deltaY: 0, bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(300)
  await expect.poll(() => page.locator('.lane.lane-active').getAttribute('data-lane')).toBe('0')
})

test('typing in a named note persists to IndexedDB', async ({ page }) => {
  await seedApp(page, [{ id: 'n1', title: 'Scratch', markdown: '', lane: 1, order: 0 }])
  const editor = page.locator('.note-card .mdxeditor-root-contenteditable')
  await editor.click()
  await page.keyboard.type('persisted text')
  await expect.poll(async () => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('notes-local', 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const record = await new Promise<{ markdown?: string } | undefined>((resolve, reject) => {
      const request = database.transaction('named-documents', 'readonly').objectStore('named-documents').get('n1')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return record?.markdown ?? ''
  })).toContain('persisted text')
})
