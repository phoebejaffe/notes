import { expect, test } from '@playwright/test'
import { moveLinesDetailed } from '../src/markerEngine'
import { editorFor, selectionSnapshot, setCaretAtText, sourceFor } from './support/editor'

// Caret placement per canonical source line of the `movement-sweep` scenario.
// Blank lines can't hold a caret and are skipped; every other line is moved in
// both directions and the result is compared against markerEngine.moveLines,
// which is independently unit-tested.
const LINES: { caret: string; line: number }[] = [
  { caret: 'alpha one', line: 0 },
  { caret: 'alpha two', line: 1 },
  { caret: 'bravo para', line: 3 },
  { caret: 'heading here', line: 5 },
  { caret: 'bullet one', line: 7 },
  { caret: 'bullet two', line: 8 },
  { caret: 'nested one', line: 9 },
  { caret: 'nested two', line: 10 },
  { caret: 'bullet three', line: 11 },
  { caret: 'quote one', line: 13 },
  { caret: 'quote two', line: 14 },
  { caret: 'ordered one', line: 16 },
  { caret: 'ordered two', line: 17 },
  { caret: 'tail one', line: 19 },
  { caret: 'tail two', line: 20 },
]

for (const { caret, line } of LINES) {
  for (const direction of ['up', 'down'] as const) {
    test(`opt-${direction} on "${caret}" (source line ${line})`, async ({ page }) => {
      await page.goto('/prototype?scenario=movement-sweep')
      const root = editorFor(page)
      const source = (await sourceFor(page).textContent()) ?? ''
      const expected = moveLinesDetailed(source, line, line, direction)

      await setCaretAtText(root, caret, 0)
      await page.keyboard.press(direction === 'up' ? 'Alt+ArrowUp' : 'Alt+ArrowDown')
      await expect.poll(async () => sourceFor(page).textContent()).toBe(expected?.source ?? source)

      if (expected) {
        await expect.poll(async () => (await selectionSnapshot(page)).blockText).toContain(caret)
      }

      await page.keyboard.press('Meta+z')
      await expect.poll(async () => sourceFor(page).textContent()).toBe(source)
    })
  }
}

test('opt-up on a paragraph below a list jumps above the whole list', async ({ page }) => {
  await page.goto('/prototype?scenario=movement-sweep')
  const root = editorFor(page)

  await setCaretAtText(root, 'tail one', 0)
  await page.keyboard.press('Alt+ArrowUp')
  await expect.poll(async () => sourceFor(page).textContent()).toBe(`alpha one
alpha two

bravo para

## heading here

- bullet one
- bullet two
  - nested one
  - nested two
- bullet three

> quote one
> quote two

tail one

1. ordered one
2. ordered two

tail two`)
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toContain('tail one')
})

test('opt-down on a heading above a list jumps below the whole list', async ({ page }) => {
  await page.goto('/prototype?scenario=movement-sweep')
  const root = editorFor(page)

  await setCaretAtText(root, 'heading here', 0)
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(async () => sourceFor(page).textContent()).toBe(`alpha one
alpha two

bravo para


- bullet one
- bullet two
  - nested one
  - nested two
- bullet three

## heading here

> quote one
> quote two

1. ordered one
2. ordered two

tail one
tail two`)
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toContain('heading here')
})
