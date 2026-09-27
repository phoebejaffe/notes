import { expect, test } from '@playwright/test'
import { editorFor, expectSource, selectionSnapshot, setCaretAtText, sourceFor } from './support/editor'

test('muting inside blockquotes and nested list items preserves prefixes', async ({ page }) => {
  await page.goto('/prototype?scenario=muted')
  const root = editorFor(page)
  await setCaretAtText(root, 'quote target', 0)
  await page.keyboard.press('Control+/')
  await expectSource(page, /> quote target %%/u)

  await page.goto('/prototype?scenario=list-movement')
  const listRoot = editorFor(page)
  await setCaretAtText(listRoot, 'second child one', 0)
  await page.keyboard.press('Control+/')
  await expectSource(page, / {2}- second child one %%/u)
})

test('unmuting clamps the caret when the line shortens', async ({ page }) => {
  await page.goto('/prototype?scenario=muted')
  const root = editorFor(page)
  const renderedLength = 'already muted'.length

  // The `%% ` marker is hidden, so a caret at rendered offset 5 must stay at
  // offset 5 when unmuting strips the marker and the line keeps its length.
  await setCaretAtText(root, 'already muted', 5)
  await page.keyboard.press('Control+/')
  await expectSource(page, /\nalready muted\n/u)
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toBe('already muted')
  await expect.poll(async () => (await selectionSnapshot(page)).anchorOffset).toBe(5)

  // Re-mute, park the caret at the very end of the rendered text, then unmute:
  // the caret must clamp to the new (shorter) rendered length.
  await page.keyboard.press('Control+/')
  await expectSource(page, /already muted %%/u)
  await setCaretAtText(root, 'already muted', renderedLength)
  await page.keyboard.press('Control+/')
  await expectSource(page, /\nalready muted\n/u)
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toBe('already muted')
  await expect.poll(async () => (await selectionSnapshot(page)).anchorOffset).toBe(renderedLength)
})

test('editing a muted line keeps its %% marker', async ({ page }) => {
  await page.goto('/prototype?scenario=muted')
  const root = editorFor(page)
  await setCaretAtText(root, 'already muted', 'already muted'.length)
  await expect.poll(async () => (await selectionSnapshot(page)).anchorOffset).toBe('already muted'.length)
  await page.keyboard.type(' extra')
  await expectSource(page, /already muted extra %%/u)
  await expect.poll(async () => (await sourceFor(page).textContent())?.match(/%%/gu)?.length).toBe(1)
})

test('a selection ending mid-line expands to whole lines for muting', async ({ page }) => {
  await page.goto('/prototype?scenario=muted')
  const root = editorFor(page)

  // Build a DOM selection from the middle of 'list target' to the middle of
  // 'task target' — it ends mid-line, so muting must expand to whole lines.
  await root.evaluate((element) => {
    ;(element.closest('[contenteditable="true"]') as HTMLElement | null)?.focus()
    const nodes: Text[] = []
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
    const locate = (text: string) => {
      const node = nodes.find((candidate) => (candidate.textContent ?? '').includes(text))
      if (!node) throw new Error(`Could not find rendered text node: ${text}`)
      return { node, index: (node.textContent ?? '').indexOf(text) }
    }
    const start = locate('list target')
    const end = locate('task target')
    const range = document.createRange()
    range.setStart(start.node, start.index + 4)
    range.setEnd(end.node, end.index + 4)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  // The selection text deliberately starts and ends mid-word.
  await expect.poll(async () => (await selectionSnapshot(page)).text).toContain('heading target')

  await page.keyboard.press('Control+/')
  await expectSource(page, /[-*] list target %%/u)
  await expectSource(page, /## heading target %%/u)
  await expectSource(page, /[-*] \[ \] task target %%/u)
  await expect.poll(async () => (await sourceFor(page).textContent())?.match(/%%/gu)?.length).toBe(4)
})
