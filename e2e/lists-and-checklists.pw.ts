import { expect, test, type Page } from '@playwright/test'
import { BLOCK_SELECTOR, clickTextCaret, editorFor, expectSource, selectionSnapshot, setCaretAtText, sourceFor } from './support/editor'

// Commits restore the caret across two nested animation frames, so tests that
// move the caret right after a shortcut must wait for the restore to settle.
function waitForCaretRestore(page: Page) {
  return page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))))
}

function colorAlpha(value: string) {
  const mixed = value.match(/\/\s*([\d.]+)\s*\)/u)
  if (mixed) return Number(mixed[1])
  const rgba = value.match(/^rgba\(.*,\s*([\d.]+)\)$/u)
  return rgba ? Number(rgba[1]) : 1
}

test('checklist controls stay attached to their list item when content above changes and wraps', async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 800 })
  await page.goto('/prototype?scenario=checklist-position')

  const root = editorFor(page)
  const checklist = root.locator('li', { hasText: 'The checklist stays attached to this line' })
  const checkbox = checklist
  await expect(checkbox).toHaveAttribute('role', 'checkbox')
  await expect(checkbox).toHaveAttribute('aria-checked', 'false')

  const before = await checklist.boundingBox()
  const beforeStyle = await checkbox.evaluate((element) => {
    const pseudo = getComputedStyle(element, '::before')
    return { position: pseudo.position, top: pseudo.top, left: pseudo.left, width: pseudo.width, height: pseudo.height, inline: element.getAttribute('style') }
  })
  expect(before).not.toBeNull()
  expect(beforeStyle).toMatchObject({ position: 'absolute', top: '0px', left: '0px' })
  expect(beforeStyle.width).not.toBe('auto')
  expect(beforeStyle.height).not.toBe('auto')
  expect(beforeStyle.inline ?? '').not.toMatch(/(?:top|left):/u)

  const paragraphBox = await root.locator('p', { hasText: 'prefix alpha' }).boundingBox()
  expect(paragraphBox).not.toBeNull()
  expect(before!.x + parseFloat(beforeStyle.left)).toBeCloseTo(paragraphBox!.x, 0)

  const preceding = root.locator('li', { hasText: 'A deliberately long line above' })
  await preceding.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' Additional text above the checkbox makes this line wrap further.')
  await expectSource(page, /Additional text above the checkbox/u)

  const afterTyping = await checklist.boundingBox()
  expect(afterTyping).not.toBeNull()
  expect(afterTyping!.height).toBeGreaterThanOrEqual(before!.height)
  await expect(checkbox).toHaveAttribute('aria-checked', 'false')

  await page.setViewportSize({ width: 360, height: 800 })
  await expect.poll(async () => {
    const box = await checklist.boundingBox()
    const style = await checkbox.evaluate((element) => {
      const pseudo = getComputedStyle(element, '::before')
      return { position: pseudo.position, top: pseudo.top, left: pseudo.left, width: pseudo.width, height: pseudo.height }
    })
    return !!box && style.position === 'absolute' && style.top === '0px' && style.left === '0px' && style.width !== 'auto' && style.height !== 'auto'
  }).toBe(true)
})

test('checked checklist items use a subdued checkbox and translucent strikethrough', async ({ page }) => {
  await page.goto('/prototype?scenario=checklist')
  await page.locator('.markdown-prototype-page').evaluate((element) => element.classList.add('theme-dark'))

  const checked = editorFor(page).locator('li', { hasText: 'second task' })
  const styles = await checked.evaluate((element) => {
    const item = getComputedStyle(element)
    const checkbox = getComputedStyle(element, '::before')
    const checkmark = getComputedStyle(element, '::after')
    return {
      decorationLine: item.textDecorationLine,
      decorationColor: item.textDecorationColor,
      checkboxBackground: checkbox.backgroundColor,
      checkboxBorder: checkbox.borderColor,
      checkmarkOpacity: checkmark.opacity,
    }
  })

  expect(styles.decorationLine).toContain('line-through')
  expect(colorAlpha(styles.decorationColor)).toBeLessThan(1)
  expect(colorAlpha(styles.checkboxBackground)).toBeLessThan(0.2)
  expect(colorAlpha(styles.checkboxBorder)).toBeLessThan(0.5)
  expect(styles.checkmarkOpacity).toBe('0.6')
})

test('audio transcription links only render a checkbox for the actual task and keep it at the list level', async ({ page }) => {
  await page.goto('/prototype?scenario=audio-transcription-checklist')
  const root = editorFor(page)
  await expect(root.locator('[role="checkbox"]')).toHaveCount(1)
  const task = root.locator('li', { hasText: 'Find someone to go to the symphony with me.' })
  await expect(task).toHaveCount(1)
  await expect(task).toHaveAttribute('role', 'checkbox')
  await expect(root.locator('p', { hasText: 'Be able to talk to a few other people' }).locator('[role="checkbox"]')).toHaveCount(0)
  await expect(root.locator('p', { hasText: 'Kept finding blonde pubes' }).locator('[role="checkbox"]')).toHaveCount(0)
  await expect(task).toHaveJSProperty('tagName', 'LI')
})

test('checking a task changes only its marker and preserves editor selection and scroll', async ({ page }) => {
  await page.goto('/prototype?scenario=checklist')
  const root = editorFor(page)
  const target = root.locator('li', { hasText: 'first task' })
  const before = await selectionSnapshot(page)
  const checkboxBox = await target.boundingBox()
  expect(checkboxBox).not.toBeNull()
  await page.mouse.click(checkboxBox!.x + 5, checkboxBox!.y + 5)
  await expectSource(page, /[-*] \[x\] first task/u)
  await expect.poll(async () => (await selectionSnapshot(page)).scrollTop).toBe(before.scrollTop)

  await target.click({ force: true })
  await page.keyboard.press('End')
  const after = await selectionSnapshot(page)
  expect(after.collapsed).toBe(true)
  expect(after.blockText).toContain('first task')
})

test('meta-enter checks a task and turns plain lines into tasks', async ({ page }) => {
  await page.goto('/prototype?scenario=checklist')
  const root = editorFor(page)

  await setCaretAtText(root, 'first task', 2)
  await page.keyboard.press('Meta+Enter')
  await expectSource(page, /- \[x\] first task/u)
  await waitForCaretRestore(page)

  await setCaretAtText(root, 'suffix omega', 2)
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toContain('suffix omega')
  await page.keyboard.press('Meta+Enter')
  await expectSource(page, /- \[ \] suffix omega/u)
})

test('meta-shift-enter removes the checkbox and leaves a plain list item', async ({ page }) => {
  await page.goto('/prototype?scenario=checklist')
  const root = editorFor(page)

  await setCaretAtText(root, 'second task', 2)
  await page.keyboard.press('Meta+Shift+Enter')
  await expectSource(page, /- second task/u)
})

test('meta-shift-c converts a task to plain text', async ({ page }) => {
  await page.goto('/prototype?scenario=checklist')
  const root = editorFor(page)

  await setCaretAtText(root, 'second task', 2)
  await page.keyboard.press('Meta+Shift+C')
  await expectSource(page, /\nsecond task\n/u)
})

test('bulleting one line inside a tag keeps the tag and does not indent sibling lines', async ({ page }) => {
  await page.goto('/prototype?scenario=tagged-list-lines')
  const root = editorFor(page)
  await setCaretAtText(root, 'Line 2', 2)
  await page.getByRole('radio', { name: 'Bulleted list' }).click()
  await expectSource(page, /:::tag\{name="book club"\}[\s\S]*Line 1[\s\S]*[-*] Line 2[\s\S]*Line 3[\s\S]*:::/u)
  await expect(sourceFor(page)).not.toHaveText(/ {2,}Line [13]/u)
})

test('option arrows swap hard-break paragraphs and preserve their blank separators', async ({ page }) => {
  await page.goto('/prototype?scenario=line-movement-hard')
  const root = editorFor(page)
  await setCaretAtText(root, 'Line B', 2)
  await page.keyboard.press('Alt+ArrowUp')
  await expectSource(page, /Line B\s+Line A\s+Line C/u)

  await page.goto('/prototype?scenario=line-movement-hard')
  const freshRoot = editorFor(page)
  await setCaretAtText(freshRoot, 'Line B', 2)
  await page.keyboard.press('Alt+ArrowDown')
  await expectSource(page, /Line A\s+Line C\s+Line B/u)
})

test('an end-of-line caret moves that line rather than the following line', async ({ page }) => {
  await page.goto('/prototype?scenario=line-movement-hard')
  const root = editorFor(page)
  await clickTextCaret(page, root, 'Line B', 0)
  await page.keyboard.press('End')
  await page.keyboard.press('Alt+ArrowUp')
  await expectSource(page, /Line B\s+Line A\s+Line C/u)
})

test('an end-of-line caret after a Markdown link moves the link line', async ({ page }) => {
  await page.goto('/prototype?scenario=line-movement-link-end')
  const root = editorFor(page)
  await clickTextCaret(page, root, 'Line B link', 0)
  await page.keyboard.press('End')
  await page.keyboard.press('Alt+ArrowUp')
  await expectSource(page, /Line B \[link\]\(https:\/\/example\.com\)[\s\S]*Line A[\s\S]*Line C/u)

  await page.goto('/prototype?scenario=line-movement-link-end')
  const freshRoot = editorFor(page)
  await clickTextCaret(page, freshRoot, 'Line B link', 0)
  await page.keyboard.press('End')
  await page.keyboard.press('Alt+ArrowDown')
  await expectSource(page, /Line A[\s\S]*Line C[\s\S]*Line B \[link\]\(https:\/\/example\.com\)/u)
})

test('option arrows swap lines inside a tagged block without moving surrounding lines', async ({ page }) => {
  await page.goto('/prototype?scenario=tagged-line-movement')
  const root = editorFor(page)
  await setCaretAtText(root, 'Line B', 2)
  await page.keyboard.press('Alt+ArrowUp')
  await expectSource(page, /Line above[\s\S]*Line B\n[-*] Line A\n[-*] Line C[\s\S]*Line below/u)
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toContain('Line B')

  await page.goto('/prototype?scenario=tagged-line-movement')
  const freshRoot = editorFor(page)
  await setCaretAtText(freshRoot, 'Line B', 2)
  await page.keyboard.press('Alt+ArrowDown')
  await expectSource(page, /Line above[\s\S]*Line A\n[-*] Line C\n[-*] Line B[\s\S]*Line below/u)
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toContain('Line B')
})

test('moving a normal line first does not poison the next move inside a tag', async ({ page }) => {
  await page.goto('/prototype?scenario=normal-then-tag-movement')
  const root = editorFor(page)

  await setCaretAtText(root, 'Line 2', 2)
  await page.keyboard.press('Alt+ArrowUp')
  await expectSource(page, /Line 2\nLine 1\nLine 3/u)

  await clickTextCaret(page, root, 'Tag B', 2)
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toContain('Tag B')
  await page.keyboard.press('Alt+ArrowDown')
  await expectSource(page, /Tag A[\s\S]*[-*] Tag C[\s\S]*[-*] Tag B/u)
  await expectSource(page, /Line 2\nLine 1\nLine 3/u)
})

test('repeated moves keep tagged and later list lines mapped to their own source lines', async ({ page }) => {
  await page.goto('/prototype?scenario=repeated-line-movement')
  const root = editorFor(page)

  await clickTextCaret(page, root, 'Line B', 2)
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toContain('Line B')
  await page.keyboard.press('Alt+ArrowUp')
  await expectSource(page, /Line B\n[-*] Line A\n[-*] Line C/u)

  await clickTextCaret(page, root, 'Line E', 2)
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toContain('Line E')
  await page.keyboard.press('Alt+ArrowUp')
  await expectSource(page, /Line E\n[-*] Line D/u)
  await expectSource(page, /Line B[\s\S]*[-*] Line A[\s\S]*[-*] Line C/u)

  await clickTextCaret(page, root, 'Line F', 2)
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toContain('Line F')
  await page.keyboard.press('Alt+ArrowUp')
  await expectSource(page, /Line E\n[-*] Line F\n[-*] Line D/u)
  await expectSource(page, /Line B[\s\S]*[-*] Line A[\s\S]*[-*] Line C/u)
})

test('muting one tagged list line changes only that line and keeps the caret', async ({ page }) => {
  await page.goto('/prototype?scenario=tagged-line-movement')
  const root = editorFor(page)
  await setCaretAtText(root, 'Line B', 2)
  await page.keyboard.press('Control+/')
  await expectSource(page, /[-*] %% Line B/u)
  await expectSource(page, /[-*] Line A/u)
  await expectSource(page, /[-*] Line C/u)
  await expect.poll(async () => (await selectionSnapshot(page)).blockText).toContain('Line B')
})

test('option-arrow movement preserves nested list structure and neighboring text', async ({ page }) => {
  await page.goto('/prototype?scenario=list-movement')
  const root = editorFor(page)
  const target = root.locator('li', { hasText: 'third item' })
  await target.click()
  await page.keyboard.press('Alt+ArrowUp')
  await expectSource(page, /second child one\s+- third item\s+- second child two\s+1\. ordered one/s)
  await page.keyboard.press('Alt+ArrowDown')
  await expectSource(page, /third item[\s\S]*1\. ordered one/s)
  await expect(root.locator(BLOCK_SELECTOR).first()).toContainText('prefix alpha')
  await expect(root).toContainText('suffix omega')
})
