import { expect, test } from '@playwright/test'

const SCENARIO_URL = '/prototype?scenario=audio-variants'

test('clicking a __ link opens the recording popover; ordinary links open externally', async ({ page }) => {
  const opened: string[] = []
  await page.exposeFunction('__noteOpenedUrl', (url: string) => { opened.push(url) })
  await page.addInitScript(() => {
    window.open = (url) => { void (window as { __noteOpenedUrl?: (u: string) => void }).__noteOpenedUrl?.(String(url)); return null }
  })
  await page.goto(SCENARIO_URL)

  await page.locator('.notes-mdx-editor a[href$="/a"]').click()
  const popover = page.locator('.notes-audio-popover')
  await expect(popover).toBeVisible()
  await expect(popover.locator('.notes-audio-play')).toHaveAttribute('aria-label', 'Play recording')
  await expect(popover.locator('.notes-audio-seek')).toBeVisible()
  await expect(popover.locator('.notes-audio-time')).toBeVisible()

  // Escape dismisses it.
  await page.keyboard.press('Escape')
  await expect(popover).toHaveCount(0)

  // A different recording link opens a fresh popover.
  await page.locator('.notes-mdx-editor a[href$="/c"]').click()
  await expect(popover).toBeVisible()

  // Clicking outside dismisses it.
  await page.mouse.click(10, 10)
  await expect(popover).toHaveCount(0)

  // An ordinary link goes through window.open, never the player.
  await page.locator('.notes-mdx-editor a[href$="/g"]').click()
  await expect(popover).toHaveCount(0)
  expect.poll(() => opened).toContain('https://example.com/g')
})

test('__ links render no left-edge markers', async ({ page }) => {
  await page.goto(SCENARIO_URL)
  // Wait for the editor to render its links so the negative count isn't vacuous.
  await expect(page.locator('.notes-mdx-editor a').filter({ hasText: /^_+$/ })).toHaveCount(6)
  await expect(page.locator('.notes-audio-marker')).toHaveCount(0)
})
