import { expect, test } from '@playwright/test'
import { editorFor, selectRenderedRange, selectionSnapshot, setCaretAtText, sourceFor } from './support/editor'

const sourceText = async (page: import('@playwright/test').Page) => sourceFor(page).textContent()

const expectCaretBlock = (page: import('@playwright/test').Page, text: string) =>
  expect.poll(async () => (await selectionSnapshot(page)).blockText).toBe(text)

test('a line outside a tag jumps the whole tag block', async ({ page }) => {
  await page.goto('/prototype?scenario=tagged-line-movement')
  const root = editorFor(page)
  await expect(root).toContainText('Line above')

  // Caret above the tag: Alt+ArrowDown lands the line below the whole block.
  await setCaretAtText(root, 'Line above', 0)
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(() => sourceText(page)).toMatch(
    /:::tag\{name="brainstorm"\}\nQuestions for Lyle\n- Line A\n- Line B\n- Line C\n:::\n\nLine above\n\nLine below$/,
  )
  await expectCaretBlock(page, 'Line above')

  // Caret below the tag: Alt+ArrowUp lands the line above the whole block.
  await page.goto('/prototype?scenario=tagged-line-movement')
  await expect(root).toContainText('Line below')
  await setCaretAtText(root, 'Line below', 0)
  await page.keyboard.press('Alt+ArrowUp')
  await expect.poll(() => sourceText(page)).toMatch(
    /^Line above\n\nLine below\n\n:::tag\{name="brainstorm"\}\nQuestions for Lyle\n- Line A\n- Line B\n- Line C\n:::\n?$/,
  )
  await expectCaretBlock(page, 'Line below')
})

test('a line inside a tag escapes across its boundary', async ({ page }) => {
  await page.goto('/prototype?scenario=tagged-line-movement')
  const root = editorFor(page)
  await expect(root).toContainText('Questions for Lyle')

  // First line inside the tag escapes above it.
  await setCaretAtText(root, 'Questions for Lyle', 0)
  await page.keyboard.press('Alt+ArrowUp')
  await expect.poll(() => sourceText(page)).toMatch(
    /^Line above\n\nQuestions for Lyle\n\n:::tag\{name="brainstorm"\}\n- Line A\n- Line B\n- Line C\n:::\n\nLine below$/,
  )
  await expectCaretBlock(page, 'Questions for Lyle')

  // Last line inside the tag escapes below it.
  await page.goto('/prototype?scenario=tagged-line-movement')
  await expect(root).toContainText('Line C')
  await setCaretAtText(root, 'Line C', 0)
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(() => sourceText(page)).toMatch(
    /^Line above\n\n:::tag\{name="brainstorm"\}\nQuestions for Lyle\n- Line A\n- Line B\n:::\n\n- Line C\n\nLine below$/,
  )
  await expectCaretBlock(page, 'Line C')
})

test('moving a muted line keeps %%', async ({ page }) => {
  await page.goto('/prototype?scenario=muted')
  const root = editorFor(page)
  await expect(root).toContainText('already muted')

  await setCaretAtText(root, 'already muted', 0)
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(() => sourceText(page)).toMatch(
    /^prefix alpha\nplain target\n\n+- list target\n\n%% already muted\n\n## heading target\n- \[ \] task target\n> quote target\nsuffix omega$/,
  )
  await expectCaretBlock(page, 'already muted')
})

test('a visible line can move past a hidden muted line', async ({ page }) => {
  await page.goto('/prototype?scenario=muted')
  const root = editorFor(page)
  await expect(root).toContainText('plain target')

  const mutedLine = root.locator('p', { hasText: 'already muted' })
  await page.getByRole('button', { name: 'Hide muted content' }).click()
  await expect(mutedLine).toBeHidden()

  await setCaretAtText(root, 'plain target', 0)
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(() => sourceText(page)).toMatch(
    /^prefix alpha\n%% already muted\n\nplain target\n\n- list target\n## heading target\n- \[ \] task target\n> quote target\nsuffix omega$/,
  )
  await expectCaretBlock(page, 'plain target')
})

test('moving a non-collapsed selection moves all its lines as a block', async ({ page }) => {
  await page.goto('/prototype?scenario=line-movement')
  const root = editorFor(page)
  await expect(root).toContainText('first line')

  await selectRenderedRange(root, 'first line', 'third line')
  await expect.poll(async () => (await selectionSnapshot(page)).collapsed).toBe(false)
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(() => sourceText(page)).toMatch(/^prefix alpha\nsuffix omega\n\n?first line\nsecond line\nthird line$/)

  // The restored selection covers exactly the moved block.
  await expect.poll(async () => (await selectionSnapshot(page)).collapsed).toBe(false)
  await expect.poll(async () => (await selectionSnapshot(page)).text.replace(/\s+/gu, '')).toBe('firstlinesecondlinethirdline')
})

test('repeated moves at document edges are stable', async ({ page }) => {
  const source = 'Line A\n\nLine B\n\nLine C'
  await page.goto('/prototype?scenario=line-movement-hard')
  const root = editorFor(page)
  await expect(root).toContainText('Line A')

  // Alt+ArrowUp at the document top is a no-op.
  await setCaretAtText(root, 'Line A', 0)
  for (let press = 0; press < 2; press += 1) {
    await page.keyboard.press('Alt+ArrowUp')
    await expect.poll(() => sourceText(page)).toBe(source)
    await expectCaretBlock(page, 'Line A')
  }

  // Alt+ArrowDown at the document bottom is a no-op.
  await setCaretAtText(root, 'Line C', 0)
  for (let press = 0; press < 2; press += 1) {
    await page.keyboard.press('Alt+ArrowDown')
    await expect.poll(() => sourceText(page)).toBe(source)
    await expectCaretBlock(page, 'Line C')
  }

  // 'Line A' walks to the bottom; extra presses then do nothing.
  await setCaretAtText(root, 'Line A', 0)
  const expected = [
    'Line B\n\nLine A\n\nLine C',
    'Line B\n\nLine C\n\nLine A',
    'Line B\n\nLine C\n\nLine A',
    'Line B\n\nLine C\n\nLine A',
  ]
  for (const next of expected) {
    await page.keyboard.press('Alt+ArrowDown')
    await expect.poll(() => sourceText(page)).toBe(next)
    await expectCaretBlock(page, 'Line A')
  }
})
