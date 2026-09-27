import { expect, test, type Page } from '@playwright/test'
import { selectionSnapshot, setCaretAtText } from './support/editor'

// Element context around the collapsed caret: which day-card holds it and what
// kind of block it sits in (li, blockquote, h2, …). blockText in
// selectionSnapshot resolves the nearest block; this adds the wrapper checks.
async function caretContext(page: Page) {
  return page.evaluate(() => {
    const anchor = window.getSelection()?.anchorNode
    const element = anchor instanceof Element ? anchor : anchor?.parentElement
    const block = element?.closest('h1,h2,h3,h4,h5,h6,li,blockquote,pre,p')
    return {
      blockTag: block?.tagName.toLowerCase() ?? '',
      insideLi: !!element?.closest('li'),
      insideBlockquote: !!element?.closest('blockquote'),
      cardDay: element?.closest('.day-card')?.getAttribute('data-day') ?? '',
      activeCardDay: document.activeElement?.closest('.day-card')?.getAttribute('data-day') ?? '',
    }
  })
}

// Reads selection snapshots until two consecutive reads agree, so a keypress's
// async Lexical reconciliation has settled before we decide where the caret is.
async function settledSnapshot(page: Page) {
  let previous = ''
  for (let i = 0; i < 20; i += 1) {
    const snapshot = await selectionSnapshot(page)
    const key = JSON.stringify([snapshot.blockText, snapshot.anchorOffset, snapshot.caretTop])
    if (key === previous) return snapshot
    previous = key
    await page.waitForTimeout(30)
  }
  return selectionSnapshot(page)
}

test('crossing into a day whose edge lines are muted and hidden lands on the first visible line', async ({ page }) => {
  await page.goto('/prototype?multi&variant=muted-edges&hide-muted')
  const cards = page.locator('.day-card')
  const day1 = cards.nth(0).locator('.mdxeditor-root-contenteditable')
  const day2 = cards.nth(1).locator('.mdxeditor-root-contenteditable')
  const day3 = cards.nth(2).locator('.mdxeditor-root-contenteditable')

  // hide-muted collapses the fully-muted edge paragraphs of day2.
  await expect(day2.locator('p', { hasText: 'hidden top' })).toBeHidden()
  await expect(day2.locator('p', { hasText: 'hidden bottom' })).toBeHidden()
  await expect(day2.locator('p', { hasText: 'visible middle' })).toBeVisible()

  // Down from the bottom of day1 must skip the hidden top edge line.
  await setCaretAtText(day1, 'day one text', 'day one text'.length)
  await page.keyboard.press('ArrowDown')
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toBe('visible middle')
  await expect.poll(async () => (await caretContext(page)).cardDay).toBe('day2')
  await expect.poll(async () => (await selectionSnapshot(page)).anchorOffset).toBe(0)

  // Up from the top of day3 must skip the hidden bottom edge line.
  await setCaretAtText(day3, 'day three text', 0)
  await page.keyboard.press('ArrowUp')
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toBe('visible middle')
  await expect.poll(async () => (await caretContext(page)).cardDay).toBe('day2')
})

test('crossing onto non-paragraph edge blocks', async ({ page }) => {
  await page.goto('/prototype?multi&variant=edges')
  const cards = page.locator('.day-card')
  const day1 = cards.nth(0).locator('.mdxeditor-root-contenteditable')
  const day2 = cards.nth(1).locator('.mdxeditor-root-contenteditable')

  // Down from day1's trailing blockquote lands inside day2's checklist item.
  await setCaretAtText(day1, 'trailing quote', 0)
  await page.keyboard.press('ArrowDown')
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toContain('leading task')
  await expect.poll(async () => (await caretContext(page)).insideLi).toBe(true)
  await expect.poll(async () => (await caretContext(page)).cardDay).toBe('day2')

  // Up from day2's checklist item lands at the end of day1's trailing quote.
  await setCaretAtText(day2, 'leading task', 0)
  await page.keyboard.press('ArrowUp')
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toBe('trailing quote')
  await expect.poll(async () => (await caretContext(page)).insideBlockquote).toBe(true)
  await expect.poll(async () => (await selectionSnapshot(page)).anchorOffset).toBe('trailing quote'.length)

  // Down from day2's last paragraph lands on day3's leading heading.
  await setCaretAtText(day2, 'middle text', 'middle text'.length)
  await page.keyboard.press('ArrowDown')
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toBe('Leading heading')
  await expect.poll(async () => (await caretContext(page)).blockTag).toBe('h2')
  await expect.poll(async () => (await caretContext(page)).cardDay).toBe('day3')
})

test('rapid sequential crossings walk through multiple editors', async ({ page }) => {
  await page.goto('/prototype?multi')
  const cards = page.locator('.day-card')
  const day1 = cards.nth(0).locator('.mdxeditor-root-contenteditable')
  await setCaretAtText(day1, 'First day top line', 0)

  // Walk down: each ArrowDown moves one rendered line or crosses an editor
  // boundary — the caret must keep making progress into day3, never stick.
  let snapshot = await settledSnapshot(page)
  for (let i = 0; i < 12 && !/Plain day|Second paragraph/.test(snapshot.blockText); i += 1) {
    await page.keyboard.press('ArrowDown')
    snapshot = await settledSnapshot(page)
  }
  expect(snapshot.blockText).toMatch(/Plain day|Second paragraph/u)
  expect((await caretContext(page)).cardDay).toBe('day3')

  // Walk back up the same way until the caret reaches day1's first line.
  for (let i = 0; i < 20 && snapshot.blockText !== 'First day top line'; i += 1) {
    await page.keyboard.press('ArrowUp')
    snapshot = await settledSnapshot(page)
  }
  expect((await caretContext(page)).cardDay).toBe('day1')
  expect(snapshot.blockText).toBe('First day top line')
})

test('crossing into an empty editor then back out', async ({ page }) => {
  await page.goto('/prototype?multi&empty')
  const cards = page.locator('.day-card')
  const day1 = cards.nth(0).locator('.mdxeditor-root-contenteditable')
  const day2 = cards.nth(1).locator('.mdxeditor-root-contenteditable')
  await expect(day2).toHaveText('')

  // Down from the bottom of day1 lands inside the empty day2 editor: the caret
  // sits on the editable root (no rendered line to anchor in a block).
  await setCaretAtText(day1, 'Tagged content in day one', 'Tagged content in day one'.length)
  await page.keyboard.press('ArrowDown')
  await expect.poll(async () => (await caretContext(page)).cardDay).toBe('day2')
  await expect.poll(async () => (await caretContext(page)).activeCardDay).toBe('day2')
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toBe('')

  // Down once more crosses straight out of the empty editor into day3.
  await page.keyboard.press('ArrowDown')
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toBe('Plain day with only untagged content.')
  await expect.poll(async () => (await selectionSnapshot(page)).anchorOffset).toBe(0)
  await expect.poll(async () => (await caretContext(page)).cardDay).toBe('day3')
})
