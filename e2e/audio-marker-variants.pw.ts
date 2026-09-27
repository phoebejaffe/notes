import { expect, test, type Page } from '@playwright/test'

const SCENARIO_URL = '/prototype?scenario=audio-variants'

interface AudioGeometry {
  markers: Array<{ styleTop: string; cy: number }>
  links: Array<{ href: string; text: string; top: number; cy: number; relCy: number; rendered: boolean }>
}

// Markers carry no DOM reference to their anchor, so correspondence is
// positional: refreshAudioMarkers writes marker.style.top as the anchor's
// vertical center relative to the .notes-mdx-editor host (toFixed(1) px).
async function audioGeometry(page: Page): Promise<AudioGeometry> {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('.notes-mdx-editor')
    const hostTop = host?.getBoundingClientRect().top ?? 0
    const markers = [...(host?.querySelectorAll<HTMLElement>('.notes-audio-marker') ?? [])].map((marker) => {
      const rect = marker.getBoundingClientRect()
      return { styleTop: marker.style.top, cy: rect.top + rect.height / 2 }
    })
    const links = [...(host?.querySelectorAll<HTMLAnchorElement>('a') ?? [])].map((anchor) => {
      const rect = anchor.getBoundingClientRect()
      const cy = rect.top + rect.height / 2
      return {
        href: anchor.getAttribute('href') ?? '',
        text: anchor.textContent ?? '',
        top: rect.top,
        cy,
        relCy: cy - hostTop,
        rendered: rect.height > 0,
      }
    })
    return { markers, links }
  })
}

function markerFor(geometry: AudioGeometry, link: { relCy: number }) {
  return geometry.markers.find((marker) => Math.abs(parseFloat(marker.styleTop) - link.relCy) < 0.2)
}

function linkBySuffix(geometry: AudioGeometry, suffix: string) {
  const link = geometry.links.find((candidate) => candidate.href.endsWith(suffix))
  if (!link) throw new Error(`No rendered link ending ${suffix}`)
  return link
}

test('a marker on a wrapped line centers on the link\'s visual row', async ({ page }) => {
  // At the default 1280px viewport the panel is wide enough that the first
  // line fits on one row; a narrow viewport forces the wrap this scenario is
  // written for so the link lands on a later visual row.
  await page.setViewportSize({ width: 640, height: 800 })
  await page.goto(SCENARIO_URL)
  const markers = page.locator('.notes-audio-marker')
  await expect(markers).toHaveCount(6)

  const linkA = page.locator('.notes-mdx-editor a', { hasText: '__' }).and(page.locator('a[href*="/a"]'))
  const paragraph = page.locator('.notes-mdx-editor p:has(a[href$="/a"])').first()
  await expect(linkA).toHaveCount(1)
  const linkBox = await linkA.boundingBox()
  const paragraphBox = await paragraph.boundingBox()
  if (!linkBox || !paragraphBox) throw new Error('Missing layout boxes for the /a link or its paragraph')

  // The link wrapped: it renders below the paragraph's first visual row.
  expect(linkBox.y).toBeGreaterThan(paragraphBox.y + 10)

  const geometry = await audioGeometry(page)
  const a = linkBySuffix(geometry, '/a')
  const marker = markerFor(geometry, a)
  expect(marker, 'expected a marker aligned to the /a link\'s visual row').toBeTruthy()
  expect(Math.abs(marker!.cy - a.cy)).toBeLessThan(4)

  // One marker per visible `__`-text link.
  const visibleUnderscoreLinks = geometry.links.filter((link) => /^_+$/u.test(link.text) && link.rendered)
  expect(visibleUnderscoreLinks).toHaveLength(6)
})

test('the marker disappears when its line is muted and hidden', async ({ page }) => {
  await page.goto(SCENARIO_URL)
  const markers = page.locator('.notes-audio-marker')
  const linkB = page.locator('.notes-mdx-editor a', { hasText: '__' }).and(page.locator('a[href*="/b"]'))
  await expect(markers).toHaveCount(6)
  await expect(linkB).toBeVisible()

  // The /b line is a soft-break inside a partially muted paragraph — it ghosts
  // rather than collapsing, but its marker must still disappear.
  await page.getByRole('button', { name: 'Hide muted content' }).click()
  await expect(markers).toHaveCount(5)
  await expect.poll(async () => {
    const geometry = await audioGeometry(page)
    const b = linkBySuffix(geometry, '/b')
    return !markerFor(geometry, b)
  }).toBe(true)

  await page.getByRole('button', { name: 'Show muted content' }).click()
  await expect(linkB).toBeVisible()
  await expect(markers).toHaveCount(6)
  await expect
    .poll(async () => {
      const geometry = await audioGeometry(page)
      const b = linkBySuffix(geometry, '/b')
      const marker = markerFor(geometry, b)
      return !!marker && Math.abs(marker.cy - b.cy) < 4
    })
    .toBe(true)
})

test('two __ links on one line get stacked markers', async ({ page }) => {
  await page.goto(SCENARIO_URL)
  const markers = page.locator('.notes-audio-marker')
  await expect(markers).toHaveCount(6)

  const geometry = await audioGeometry(page)
  const c = linkBySuffix(geometry, '/c')
  const d = linkBySuffix(geometry, '/d')

  // Both anchors render on the same visual row of the 'Two recordings' line.
  expect(Math.abs(c.relCy - d.relCy)).toBeLessThan(2)

  // Markers are keyed per anchor, so the row should stack two markers with
  // identical style.top. A dedupe would leave only one.
  const rowMarkers = geometry.markers.filter((marker) => Math.abs(parseFloat(marker.styleTop) - c.relCy) < 0.2)
  expect(rowMarkers).toHaveLength(2)
  expect(rowMarkers[0].styleTop).toBe(rowMarkers[1].styleTop)
})

test('markers render inside tags and checklist items', async ({ page }) => {
  await page.goto(SCENARIO_URL)
  const markers = page.locator('.notes-audio-marker')
  await expect(markers).toHaveCount(6)

  const linkE = page.locator('.notes-mdx-editor .notes-tag-directive a', { hasText: '__' }).and(page.locator('a[href*="/e"]'))
  const linkF = page.locator('.notes-mdx-editor li a', { hasText: '__' }).and(page.locator('a[href*="/f"]'))
  await expect(linkE).toBeVisible()
  await expect(linkF).toBeVisible()

  const geometry = await audioGeometry(page)
  for (const suffix of ['/e', '/f']) {
    const link = linkBySuffix(geometry, suffix)
    const marker = markerFor(geometry, link)
    expect(marker, `expected a marker aligned to the ${suffix} link's visual row`).toBeTruthy()
    expect(Math.abs(marker!.cy - link.cy)).toBeLessThan(4)
  }
})

test('ordinary links get no marker', async ({ page }) => {
  await page.goto(SCENARIO_URL)
  const markers = page.locator('.notes-audio-marker')
  // Wait for the marker pass to settle so the negative assertion isn't vacuous.
  await expect(markers).toHaveCount(6)

  const geometry = await audioGeometry(page)
  const g = linkBySuffix(geometry, '/g')
  expect(g.text).toBe('link text')
  expect(markerFor(geometry, g), 'no marker should align with the ordinary link').toBeUndefined()

  const visibleUnderscoreLinks = geometry.links.filter((link) => /^_+$/u.test(link.text) && link.rendered)
  expect(visibleUnderscoreLinks).toHaveLength(6)
  await expect(markers).toHaveCount(visibleUnderscoreLinks.length)
})
