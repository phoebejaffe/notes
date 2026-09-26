import { expect, test } from '@playwright/test'
import { editorFor, expectSource, selectRenderedRange, selectRenderedText, selectionSnapshot, setCaretAtText, sourceFor } from './support/editor'

const mutedHighlights = async (page: import('@playwright/test').Page, name = 'notes-muted-line') =>
  page.evaluate((highlightName) => [...(CSS.highlights.get(highlightName) ?? [])].map((range) => range.toString()), name)

test('mixed muted selection mutes every line without double-muting existing lines', async ({ page }) => {
  await page.goto('/prototype?scenario=muted')
  const root = editorFor(page)
  await selectRenderedRange(root, 'plain target', 'heading target')
  const before = await selectionSnapshot(page)
  await page.getByRole('button', { name: 'Mute selected lines' }).click()

  await expectSource(page, /plain target %%[\s\S]*%% already muted[\s\S]*[-*] list target %%[\s\S]*## heading target %%/u)
  await expect.poll(async () => (await sourceFor(page).textContent())?.match(/%%/gu)?.length).toBe(4)
  const normalizeMutedSelection = (text: string) => text.replace(/ ?%% ?/gu, ' ').replace(/\s+/gu, ' ').trim()
  await expect.poll(async () => normalizeMutedSelection((await selectionSnapshot(page)).text)).toBe(normalizeMutedSelection(before.text))
})

test('all-muted selection toggles back to the original source', async ({ page }) => {
  await page.goto('/prototype?scenario=muted')
  const root = editorFor(page)
  await selectRenderedRange(root, 'already muted', 'list target')
  await page.getByRole('button', { name: 'Mute selected lines' }).click()
  await expectSource(page, /%% already muted[\s\S]*[-*] list target %%/u)
  await page.getByRole('button', { name: 'Mute selected lines' }).click()
  await expectSource(page, /already muted[\s\S]*[-*] list target/u)
  await expect.poll(async () => (await sourceFor(page).textContent())?.match(/%%/gu)?.length ?? 0).toBe(0)
})

test('muting a collapsed caret line preserves the caret offset after adding %%', async ({ page }) => {
  await page.goto('/prototype?scenario=muted')
  const root = editorFor(page)
  await setCaretAtText(root, 'plain target', 0)
  await page.keyboard.press('Control+/')
  await expectSource(page, /plain target %%/u)
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toContain('plain target')
})

test('the %% marker is hidden in the editor and muted lines are dimmed', async ({ page }) => {
  await page.goto('/prototype?scenario=muted')
  const root = editorFor(page)
  await expect.poll(async () => (await root.textContent())?.includes('%%')).toBe(false)
  await expect.poll(() => mutedHighlights(page)).toEqual(['already muted'])
})

test('soft-break lines inside one paragraph are individually mutable', async ({ page }) => {
  await page.goto('/prototype?scenario=softbreak-muted')
  const root = editorFor(page)

  await setCaretAtText(root, 'second half', 0)
  await page.keyboard.press('Control+/')
  await expectSource(page, /first half\nsecond half %%/u)
  await expect.poll(() => mutedHighlights(page)).toEqual(['second half'])

  // And the first line can be muted independently.
  await setCaretAtText(root, 'first half', 0)
  await page.keyboard.press('Control+/')
  await expectSource(page, /first half %%\nsecond half %%/u)
  await expect.poll(async () => (await mutedHighlights(page)).sort()).toEqual(['first half', 'second half'])
})

test('arrow-left into a muted line lands before the hidden marker and typing keeps the line muted', async ({ page }) => {
  await page.goto('/prototype?scenario=softbreak-muted')
  const root = editorFor(page)

  await setCaretAtText(root, 'first half', 0)
  await page.keyboard.press('Control+/')
  await expectSource(page, /first half %%/u)

  await setCaretAtText(root, 'second half', 0)
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.type('!')
  await expectSource(page, /first half! %%\nsecond half/u)
  await expect.poll(() => mutedHighlights(page)).toEqual(['first half!'])
})

test('hide muted lines makes muted blocks invisible and restores them on show', async ({ page }) => {
  await page.goto('/prototype?scenario=muted')
  const root = editorFor(page)

  const mutedLine = root.locator('p', { hasText: 'already muted' })
  await expect(mutedLine).toBeVisible()
  await page.getByRole('button', { name: 'Hide muted content' }).click()
  await expect(mutedLine).toBeHidden()
  await expect.poll(() => mutedHighlights(page, 'notes-muted-line')).toEqual([])

  await page.getByRole('button', { name: 'Show muted content' }).click()
  await expect(mutedLine).toBeVisible()
  await expect.poll(() => mutedHighlights(page)).toEqual(['already muted'])
})

test('hide muted lines keeps the caret on its line or moves it to the nearest visible line', async ({ page }) => {
  await page.goto('/prototype?scenario=muted')
  const root = editorFor(page)

  // A caret on a visible line keeps its position through the toggle.
  await setCaretAtText(root, 'suffix omega', 4)
  const before = await selectionSnapshot(page)
  await page.getByRole('button', { name: 'Hide muted content' }).click()
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toContain('suffix omega')
  await expect.poll(async () => (await selectionSnapshot(page)).anchorOffset).toBe(before.anchorOffset)
  await page.getByRole('button', { name: 'Show muted content' }).click()
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toContain('suffix omega')
  await expect.poll(async () => (await selectionSnapshot(page)).anchorOffset).toBe(before.anchorOffset)

  // A caret on a muted line moves to the nearest visible line when hidden.
  await setCaretAtText(root, 'already muted', 4)
  await page.getByRole('button', { name: 'Hide muted content' }).click()
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toContain('list target')
  await page.getByRole('button', { name: 'Show muted content' }).click()
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toContain('list target')
})

test('a hidden muted soft-break line renders as a ghost without collapsing its paragraph', async ({ page }) => {
  await page.goto('/prototype?scenario=softbreak-muted')
  const root = editorFor(page)

  await setCaretAtText(root, 'second half', 0)
  await page.keyboard.press('Control+/')
  await page.getByRole('button', { name: 'Hide muted content' }).click()
  await expect.poll(() => mutedHighlights(page, 'notes-muted-line-hidden')).toEqual(['second half'])
  await expect.poll(() => mutedHighlights(page)).toEqual([])
  // The paragraph itself stays: the muted line renders faintly at low opacity.
  await expect(root.locator('p', { hasText: 'first half' })).toBeVisible()
})

test('muting lines inside a tag stays muted and leaves sibling lines unchanged', async ({ page }) => {
  for (const target of ['Line 1', 'Line 2', 'Line 3']) {
    await page.goto('/prototype?scenario=tagged-muted-lines')
    const root = editorFor(page)
    await selectRenderedText(root, target)
    await page.getByRole('button', { name: 'Mute selected lines' }).click()

    await expect.poll(async () => sourceFor(page).textContent()).toContain(`${target} %%`)
    await expect.poll(async () => (await sourceFor(page).textContent())?.match(/Line [123] %%/gu)).toHaveLength(1)
    await expect.poll(async () => sourceFor(page).textContent()).toContain(':::tag{name="book club"}')
    await expect.poll(() => mutedHighlights(page)).toEqual([target])
    await expect.poll(async () => (await selectionSnapshot(page)).blockText).toContain(target)
  }
})
