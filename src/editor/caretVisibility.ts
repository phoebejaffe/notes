// Keeps the collapsed caret inside the visible band — the viewport minus
// fixed chrome (the top bar / capture menu up top, and the formatting
// toolbar, which is top-fixed in the day stream and bottom-fixed in the
// capture window). Browsers scroll a caret into view on their own but only
// respect scroll-padding, not overlays that sit outside the scroller, and
// they never scroll for programmatic selection moves — this covers both.

function caretViewportRect(): DOMRect | null {
  const selection = window.getSelection()
  if (!selection?.isCollapsed || !selection.rangeCount || !selection.anchorNode) return null
  const rect = selection.getRangeAt(0).getBoundingClientRect()
  if (rect.width || rect.height || rect.top || rect.bottom) return rect
  // A caret in an empty block reports a zero rect — use the element's box.
  const anchorElement = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode.parentElement
  return anchorElement?.getBoundingClientRect() ?? null
}

function visibleBand() {
  let top = 0
  let bottom = window.innerHeight
  for (const selector of ['.topbar', '.capture-menu']) {
    const rect = document.querySelector(selector)?.getBoundingClientRect()
    if (rect) top = Math.max(top, rect.bottom)
  }
  const toolbar = [...document.querySelectorAll<HTMLElement>('.mdxeditor-toolbar')]
    .find((element) => getComputedStyle(element).display !== 'none')
  if (toolbar) {
    const rect = toolbar.getBoundingClientRect()
    if (rect.top < bottom / 2) top = Math.max(top, rect.bottom)
    else bottom = Math.min(bottom, rect.top)
  }
  return { top, bottom }
}

// Scrollable ancestors of the caret, nearest first, then the document. Some
// ancestors can carry overflow:auto without ever scrolling (unconstrained
// height), so callers should fall through the list until a scrollTop change
// actually moves the caret.
function caretScrollContainers(): HTMLElement[] {
  const selection = window.getSelection()
  let element = selection?.anchorNode instanceof Element ? selection.anchorNode : selection?.anchorNode?.parentElement
  const containers: HTMLElement[] = []
  while (element && element !== document.body) {
    const overflow = getComputedStyle(element).overflowY
    if (overflow === 'auto' || overflow === 'scroll') containers.push(element as HTMLElement)
    element = element.parentElement
  }
  const documentScroller = document.scrollingElement as HTMLElement | null
  if (documentScroller && !containers.includes(documentScroller)) containers.push(documentScroller)
  return containers
}

export function ensureCaretVisible(options?: { preferTop?: boolean }) {
  const selection = window.getSelection()
  if (!selection?.anchorNode) return
  const band = visibleBand()
  const inBand = () => {
    const rect = caretViewportRect()
    return !!rect && rect.top >= band.top && rect.bottom <= band.bottom
  }
  if (inBand()) return
  const scrollers = caretScrollContainers()
  if (options?.preferTop) {
    // When the caret is within the first screenful, scrolling to the very
    // top keeps it visible while showing the start of the stream.
    for (const scroller of scrollers) scroller.scrollTo({ top: 0, behavior: 'instant' })
    if (inBand()) return
  }
  // Scroll the caret to the band's center, re-measuring between steps so the
  // scroll converges even when `zoom` scaling makes scrollTop units differ
  // from rect pixels.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rect = caretViewportRect()
    if (!rect || (rect.top >= band.top && rect.bottom <= band.bottom)) return
    const delta = (rect.top + rect.bottom) / 2 - (band.top + band.bottom) / 2
    for (const scroller of scrollers) {
      const zoom = parseFloat(getComputedStyle(scroller).zoom) || 1
      const before = scroller.scrollTop
      scroller.scrollTop += delta / zoom
      if (scroller.scrollTop !== before) break
    }
  }
}
