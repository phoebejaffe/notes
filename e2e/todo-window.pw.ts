import { expect, test, type Page } from '@playwright/test'

// The todo window (?mode=todo) renders the real TodoWindow shell, so these
// tests seed IndexedDB/localStorage before the app loads documents.

type SeedNote = { id: string; title: string; markdown: string; lane?: number; order?: number; collapsed?: boolean; deleted?: boolean; updatedAt?: number }

async function seedTodoApp(page: Page, notes: SeedNote[], preferences: Record<string, unknown> = {}) {
  await page.goto('/?mode=todo')
  await page.evaluate(({ records, prefs }) => {
    localStorage.setItem('notes-preferences', JSON.stringify({ onboardingDismissed: true, syncPromptDismissed: true, ...prefs }))
    return new Promise<void>((resolve) => {
      const request = indexedDB.open('notes-local', 2)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains('daily-documents')) db.createObjectStore('daily-documents', { keyPath: 'day' })
        if (!db.objectStoreNames.contains('named-documents')) db.createObjectStore('named-documents', { keyPath: 'id' })
      }
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction('named-documents', 'readwrite')
        const store = tx.objectStore('named-documents')
        for (const note of records) store.put({ lane: 1, order: 0, collapsed: false, updatedAt: Date.now(), ...note })
        tx.oncomplete = () => resolve()
      }
      request.onerror = () => resolve()
    })
  }, { records: notes, prefs: preferences })
  await page.reload()
  await page.locator('.todo-shell').waitFor()
}

async function readNamedDocument(page: Page, id: string) {
  return page.evaluate(async (noteId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('notes-local', 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return new Promise<{ title?: string; markdown?: string; collapsed?: boolean } | undefined>((resolve, reject) => {
      const request = db.transaction('named-documents').objectStore('named-documents').get(noteId)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }, id)
}

test('shows only todo-titled notes, stacked alphabetically', async ({ page }) => {
  await seedTodoApp(page, [
    { id: 'n1', title: 'todo work', markdown: 'work item' },
    { id: 'n2', title: 'Todo', markdown: 'main todo' },
    { id: 'n3', title: 'groceries', markdown: 'not a todo' },
    { id: 'n4', title: 'todo chores', markdown: 'chores item' },
    { id: 'n5', title: 'todo old', markdown: 'gone', deleted: true },
  ])

  const cards = page.locator('.todo-stream .note-card')
  await expect(cards).toHaveCount(3)
  const titles = (await cards.locator('.note-title').allTextContents()).map((text) => text.replace('▾', '').replace('▸', ''))
  expect(titles).toEqual(['Todo', 'todo chores', 'todo work'])

  // No lanes: the lane viewport/dots scaffolding is absent.
  await expect(page.locator('.lane, .lane-dots')).toHaveCount(0)
})

test('uses a tighter line height than the main editor', async ({ page }) => {
  await seedTodoApp(page, [{ id: 'n1', title: 'todo', markdown: 'line one\n\nline two' }])
  await expect.poll(() => page.evaluate(() => {
    const editor = document.querySelector('.todo-shell .notes-mdx-editor')
    return editor ? getComputedStyle(editor).lineHeight : ''
  })).toBe('18.9px') // 14px * 1.35
})

test('hides the formatting toolbar even while editing', async ({ page }) => {
  await seedTodoApp(page, [{ id: 'n1', title: 'todo', markdown: 'existing line' }])
  const editable = page.locator('.todo-stream .mdxeditor-root-contenteditable').first()
  await editable.click()
  await page.keyboard.type('x')
  const toolbar = page.locator('.todo-shell .mdxeditor-toolbar')
  await expect(toolbar).toHaveCount(1)
  await expect(toolbar).toBeHidden()
})

test('applies its own zoom level from preferences', async ({ page }) => {
  await seedTodoApp(page, [{ id: 'n1', title: 'todo', markdown: 'zoomed' }], { todoZoomLevel: 120 })
  await expect.poll(() => page.evaluate(() => {
    const stream = document.querySelector('.todo-stream')
    return stream ? getComputedStyle(stream).zoom : ''
  })).toBe('1.2')
})

test('edits persist to the shared named-documents store', async ({ page }) => {
  await seedTodoApp(page, [{ id: 'n1', title: 'todo', markdown: 'existing line' }])
  const editable = page.locator('.todo-stream .mdxeditor-root-contenteditable').first()
  await editable.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' plus more')
  await expect.poll(() => readNamedDocument(page, 'n1').then((doc) => doc?.markdown ?? '')).toContain('plus more')
})

test('collapsing a note persists the collapsed flag', async ({ page }) => {
  await seedTodoApp(page, [{ id: 'n1', title: 'todo', markdown: 'body text' }])
  await page.locator('.note-title').click()
  await expect(page.locator('.todo-stream .mdxeditor-root-contenteditable')).toHaveCount(0)
  await expect.poll(() => readNamedDocument(page, 'n1').then((doc) => doc?.collapsed)).toBe(true)
})

test('empty state can create a todo note', async ({ page }) => {
  await seedTodoApp(page, [{ id: 'n1', title: 'groceries', markdown: 'not a todo' }])
  await expect(page.locator('.todo-empty')).toBeVisible()
  await page.getByRole('button', { name: '+ New todo note' }).click()
  const cards = page.locator('.todo-stream .note-card')
  await expect(cards).toHaveCount(1)
  await expect.poll(() => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('notes-local', 2)
      request.onsuccess = () => resolve(request.result)
    })
    return new Promise<string[]>((resolve) => {
      const request = db.transaction('named-documents').objectStore('named-documents').getAll()
      request.onsuccess = () => resolve((request.result as { title: string }[]).map((note) => note.title))
    })
  })).toContain('todo')
})
