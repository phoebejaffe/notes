import { expect, test } from '@playwright/test'

test('lines with a linked __ get a ≈ marker centered on the editor border', async ({ page }) => {
  await page.goto('/prototype?scenario=audio-transcription-checklist')
  const markers = page.locator('.notes-audio-marker')
  await expect(markers).toHaveCount(3)

  const positions = await page.evaluate(() => ({
    editorLeft: document.querySelector('.notes-mdx-editor')!.getBoundingClientRect().left,
    markers: [...document.querySelectorAll('.notes-audio-marker')].map((marker) => {
      const rect = marker.getBoundingClientRect()
      return { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2, text: marker.textContent }
    }),
    linkCenters: [...document.querySelectorAll<HTMLElement>('.notes-mdx-editor a')]
      .filter((anchor) => anchor.textContent === '__')
      .map((anchor) => {
        const rect = anchor.getBoundingClientRect()
        return rect.top + rect.height / 2
      }),
  }))

  // Each marker straddles the editor's left border and centers on its link's row.
  for (const marker of positions.markers) {
    expect(marker.text).toBe('≈')
    expect(Math.abs(marker.cx - (positions.editorLeft + 0.5))).toBeLessThan(3)
  }
  expect(positions.markers).toHaveLength(positions.linkCenters.length)
  for (const marker of positions.markers) {
    expect(Math.min(...positions.linkCenters.map((cy) => Math.abs(cy - marker.cy)))).toBeLessThan(3)
  }
})
