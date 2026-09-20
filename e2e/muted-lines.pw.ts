import { expect, test } from '@playwright/test'
import { editorFor, expectSource, selectRenderedRange, selectRenderedText, selectionSnapshot, setCaretAtText } from './support/editor'

test('mixed muted selection mutes every line without double-muting existing lines', async ({ page }) => {
  await page.goto('/prototype?scenario=muted')
  const root = editorFor(page)
  await selectRenderedRange(root, 'plain target', 'heading target')
  const before = await selectionSnapshot(page)
  await page.getByRole('button', { name: 'Mute selected lines' }).click()

  await expectSource(page, /%% plain target[\s\S]*%% already muted[\s\S]*[-*] %% list target[\s\S]*## %% heading target/u)
  await expectSource(page, /(?<!%)%%(?!%)/u)
  const normalizeMutedSelection = (text: string) => text.replace(/(^|\n)\s*%%\s?/gu, '$1').replace(/\n+/gu, '\n')
  await expect.poll(async () => normalizeMutedSelection((await selectionSnapshot(page)).text)).toBe(normalizeMutedSelection(before.text))
})

test('all-muted selection toggles back to the original source', async ({ page }) => {
  await page.goto('/prototype?scenario=muted')
  const root = editorFor(page)
  await selectRenderedRange(root, 'already muted', 'list target')
  await page.getByRole('button', { name: 'Mute selected lines' }).click()
  await expectSource(page, /%% already muted[\s\S]*[-*] %% list target/u)
  await page.getByRole('button', { name: 'Mute selected lines' }).click()
  await expectSource(page, /already muted[\s\S]*[-*] list target/u)
})

test('muting a collapsed caret line preserves the caret offset after adding %%', async ({ page }) => {
  await page.goto('/prototype?scenario=muted')
  const root = editorFor(page)
  await setCaretAtText(root, 'plain target', 0)
  await page.keyboard.press('Control+/')
  await expectSource(page, /%% plain target/u)
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toContain('plain target')
})

test('muting lines inside a tag stays muted and leaves sibling lines unchanged', async ({ page }) => {
  for (const target of ['Line 1', 'Line 2', 'Line 3']) {
    await page.goto('/prototype?scenario=tagged-muted-lines')
    const root = editorFor(page)
    await selectRenderedText(root, target)
    await page.getByRole('button', { name: 'Mute selected lines' }).click()

    await page.waitForTimeout(300)
    const source = await page.getByTestId('prototype-source').textContent()
    expect(source).toContain(`%% ${target}`)
    expect(source?.match(/%% Line [123]/gu)).toHaveLength(1)
    expect(source).toContain(':::tag{name="book club"}')
    expect(source).toContain(':::')
    await expect.poll(async () => page.evaluate(() => [...(CSS.highlights.get('notes-muted-line') ?? [])].map((range) => range.toString()))).toEqual([`%% ${target}`])
    await expect.poll(async () => (await selectionSnapshot(page)).blockText).toContain(target)
  }
})
