import { expect, test, type Page } from '@playwright/test'

function todayKey() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

interface SeedNote {
  id: string
  title: string
  markdown: string
  lane: number
  order: number
  collapsed?: boolean
}

async function seedApp(page: Page, data: { days?: Record<string, string>; notes?: SeedNote[] } = {}) {
  await page.addInitScript(() => {
    localStorage.setItem('notes-preferences', JSON.stringify({ onboardingDismissed: true, syncPromptDismissed: true, rolloverHour: 0 }))
  })
  await page.goto('/')
  await expect(page.locator('.day-card').first()).toBeVisible()
  if (!Object.keys(data.days ?? {}).length && !data.notes?.length) return
  await page.evaluate(async (seed) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('notes-local', 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const daily = database.transaction('daily-documents', 'readwrite')
    Object.entries(seed.days ?? {}).forEach(([day, markdown]) =>
      daily.objectStore('daily-documents').put({ day, markdown, updatedAt: Date.now() }))
    const named = database.transaction('named-documents', 'readwrite')
    ;(seed.notes ?? []).forEach((note) =>
      named.objectStore('named-documents').put({ collapsed: false, deleted: false, ...note }))
    await Promise.all([daily, named].map((transaction) => new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })))
  }, data)
  await page.reload()
  await expect(page.locator('.day-card').first()).toBeVisible()
}

const findHighlights = (page: Page, name = 'notes-find-match') =>
  page.evaluate((highlight) => [...(CSS.highlights.get(highlight) ?? [])].map((range) => range.toString()), name)

const searchInput = (page: Page) => page.locator('.search-panel input')

test('highlights matches, shows the position, and steps with Mod-G', async ({ page }) => {
  await seedApp(page, { days: { [todayKey()]: 'alpha first\n\nbeta alpha second\n\ngamma' } })
  await page.keyboard.press('Meta+f')
  const input = searchInput(page)
  await expect(input).toBeVisible()
  await input.fill('alpha')

  await expect(page.locator('.search-count')).toHaveText('1 of 2')
  // The current match lives in notes-find-match-current; the base registry
  // holds the rest.
  await expect.poll(() => findHighlights(page)).toEqual(['alpha'])
  await expect.poll(() => findHighlights(page, 'notes-find-match-current')).toEqual(['alpha'])

  await page.keyboard.press('Meta+g')
  await expect(page.locator('.search-count')).toHaveText('2 of 2')
  await page.keyboard.press('Meta+g')
  await expect(page.locator('.search-count')).toHaveText('1 of 2')
  await page.keyboard.press('Meta+Shift+g')
  await expect(page.locator('.search-count')).toHaveText('2 of 2')

  await input.press('Enter')
  await expect(page.locator('.search-count')).toHaveText('1 of 2')
  await input.press('Shift+Enter')
  await expect(page.locator('.search-count')).toHaveText('2 of 2')
})

test('requires two characters and clears stale highlights when the query narrows', async ({ page }) => {
  await seedApp(page, { days: { [todayKey()]: 'alpha eta\n\nepsilon\n\nemerald target\n\nlast em' } })
  await page.keyboard.press('Meta+f')
  const input = searchInput(page)
  await input.pressSequentially('e')
  // A single character is not a search yet — no count, no highlights.
  await expect(page.locator('.search-count')).toHaveCount(0)
  await expect.poll(() => findHighlights(page)).toEqual([])
  await expect.poll(() => findHighlights(page, 'notes-find-match-current')).toEqual([])

  await input.pressSequentially('m')
  await expect(page.locator('.search-count')).toHaveText('1 of 2')
  // Only "em" ranges may remain — the earlier "e" ranges must be gone from
  // both registries, not just visually.
  await expect.poll(() => findHighlights(page)).toEqual(['em'])
  await expect.poll(() => findHighlights(page, 'notes-find-match-current')).toEqual(['em'])

  // Deleting back to one character deactivates find again.
  await input.press('Backspace')
  await expect(page.locator('.search-count')).toHaveCount(0)
  await expect.poll(() => findHighlights(page)).toEqual([])
  await expect.poll(() => findHighlights(page, 'notes-find-match-current')).toEqual([])
})

test('the search input keeps focus while navigating matches', async ({ page }) => {
  await seedApp(page, { days: { [todayKey()]: 'one needle\n\ntwo needle\n\nthree needle' } })
  await page.keyboard.press('Meta+f')
  await searchInput(page).fill('needle')
  await page.keyboard.press('Meta+g')
  await page.keyboard.press('Meta+g')
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Search your notes')
})

test('switches lanes to reach a match in a named note', async ({ page }) => {
  await seedApp(page, {
    days: { [todayKey()]: 'target in today\n\nanother target today' },
    notes: [{ id: 'n1', title: 'Lane note', markdown: 'target inside a note', lane: 1, order: 0 }],
  })
  await page.keyboard.press('Meta+f')
  await searchInput(page).fill('target')
  await expect(page.locator('.search-count')).toHaveText('1 of 3')

  await page.keyboard.press('Meta+g')
  await page.keyboard.press('Meta+g')
  await expect(page.locator('.search-count')).toHaveText('3 of 3')
  await expect.poll(() => page.locator('.lane[data-lane="1"]').getAttribute('class')).toContain('lane-active')
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Search your notes')
})

test('scrolls an off-screen match into view', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 500 })
  const markdown = ['top line', ...Array.from({ length: 40 }, (_, index) => `filler ${index}`), 'needle at the bottom'].join('\n\n')
  await seedApp(page, { days: { [todayKey()]: markdown } })
  await page.keyboard.press('Meta+f')
  await searchInput(page).fill('needle')
  await expect(page.locator('.search-count')).toHaveText('1 of 1')
  await expect.poll(() => page.evaluate(() => {
    const highlight = CSS.highlights.get('notes-find-match-current')
    const range = highlight && [...highlight][0]
    const rect = range?.getBoundingClientRect()
    return !!rect && rect.top > 0 && rect.bottom < window.innerHeight
  })).toBe(true)
})

test('reveals muted lines while a find query is active', async ({ page }) => {
  await seedApp(page, { days: { [todayKey()]: 'visible line\n\n%% secret muted line' } })
  await page.locator('.filter-button').first().click()
  await page.getByLabel('Hide muted lines').check()

  const mutedBlockHidden = () => page.evaluate(() => {
    const block = [...document.querySelectorAll<HTMLElement>('.day-card .mdxeditor-root-contenteditable p')]
      .find((element) => element.textContent?.includes('secret'))
    return block?.hidden ?? null
  })
  await expect.poll(mutedBlockHidden).toBe(true)

  // Drop focus out of the filter checkbox so Mod-F reaches the shortcut handler.
  await page.keyboard.press('Escape')
  await page.keyboard.press('Meta+f')
  await searchInput(page).fill('secret')
  await expect(page.locator('.search-count')).toHaveText('1 of 1')
  await expect.poll(mutedBlockHidden).toBe(false)
  await expect.poll(() => findHighlights(page, 'notes-find-match-current')).toEqual(['secret'])

  await page.keyboard.press('Escape')
  await expect(page.locator('.search-panel')).toHaveCount(0)
  await expect.poll(() => findHighlights(page)).toEqual([])
  await expect.poll(mutedBlockHidden).toBe(true)
})

test('reveals collapsed tag sections while a find query is active', async ({ page }) => {
  await seedApp(page, { days: { [todayKey()]: ':::tag{name="folded" collapsed="true"}\nsecret alpha line\n:::\nvisible tail' } })
  const secret = page.locator('.day-card .mdxeditor-root-contenteditable').getByText('secret alpha line')
  await expect(secret).toBeHidden()

  await page.keyboard.press('Meta+f')
  await searchInput(page).fill('alpha')
  await expect(page.locator('.search-count')).toHaveText('1 of 1')
  await expect(secret).toBeVisible()
  await expect.poll(() => findHighlights(page, 'notes-find-match-current')).toEqual(['alpha'])

  await page.keyboard.press('Escape')
  await expect(secret).toBeHidden()
})

test('expands a collapsed note when navigation reaches its match', async ({ page }) => {
  await seedApp(page, {
    days: { [todayKey()]: 'nothing here' },
    notes: [{ id: 'n1', title: 'Folded', markdown: 'a hidden needle inside', lane: 1, order: 0, collapsed: true }],
  })
  await expect(page.locator('.note-card .notes-mdx-editor')).toHaveCount(0)
  await page.keyboard.press('Meta+f')
  await searchInput(page).fill('needle')
  await expect(page.locator('.search-count')).toHaveText('1 of 1')

  await page.keyboard.press('Meta+g')
  await expect(page.locator('.note-card .notes-mdx-editor')).toHaveCount(1)
  await expect.poll(() => findHighlights(page, 'notes-find-match-current')).toEqual(['needle'])
})
