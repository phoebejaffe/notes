import { expect, test, devices, type Page } from '@playwright/test'

// Phone-sized touch viewport. Lanes live in a horizontal snap-scrolling track;
// on touch devices navigation is a native pan, so emulate real touch events.
test.use({
  ...devices['iPhone 13'],
  defaultBrowserType: 'chromium',
})

async function seedApp(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('notes-preferences', JSON.stringify({ onboardingDismissed: true, syncPromptDismissed: true }))
  })
  await page.goto('/')
  await expect(page.locator('.day-card').first()).toBeVisible()
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('notes-local', 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction('named-documents', 'readwrite')
    const records = [
      { id: 'note-a', title: 'Alpha', markdown: 'first note', lane: 1, order: 0, collapsed: false, deleted: false },
      { id: 'note-b', title: 'Beta', markdown: 'second note', lane: 2, order: 0, collapsed: false, deleted: false },
    ]
    records.forEach((record) => transaction.objectStore('named-documents').put(record))
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  })
  await page.reload()
  await expect(page.locator('.day-card').first()).toBeVisible()
}

test('named-note lanes render and swipe pans the track on a phone viewport', async ({ page }) => {
  await seedApp(page)
  const viewport = page.locator('.notes-layout')

  // daily + 2 named lanes + ghost "New lane"
  await expect(page.locator('.lane')).toHaveCount(4)
  await expect(page.locator('.lane-dot')).toHaveCount(4)

  // Each lane fills the track width and tiles horizontally.
  const metrics = await viewport.evaluate((el) => ({
    clientWidth: el.clientWidth,
    scrollWidth: el.scrollWidth,
    lanes: [...el.querySelectorAll<HTMLElement>('.lane')].map((lane) => lane.offsetWidth),
  }))
  expect(metrics.scrollWidth).toBe(metrics.clientWidth * 4)
  for (const width of metrics.lanes) expect(width).toBe(metrics.clientWidth)

  const cdp = await page.context().newCDPSession(page)
  const cy = 400
  const swipe = async (fromX: number, toX: number) => {
    const point = (x: number) => ({ x, y: cy, id: 1 })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(fromX)] })
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(fromX + ((toX - fromX) * i) / 10)] })
      await page.waitForTimeout(16)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await page.waitForTimeout(500)
  }

  await swipe(340, 40)
  await expect.poll(() => viewport.evaluate((el) => el.scrollLeft)).toBe(366)
  await expect(page.locator('.lane-dot').nth(1)).toHaveClass(/lane-dot-active/)

  await swipe(340, 40)
  await expect.poll(() => viewport.evaluate((el) => el.scrollLeft)).toBe(732)

  // Tapping a lane dot is the non-swipe navigation path.
  await page.locator('.lane-dot').first().tap()
  await expect.poll(() => viewport.evaluate((el) => el.scrollLeft)).toBe(0)
  await expect(page.locator('.lane-dot').first()).toHaveClass(/lane-dot-active/)
})
