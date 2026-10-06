export function matchesShortcut(event: KeyboardEvent, shortcut: string) {
  const parts = shortcut.toLowerCase().split('-')
  let key = parts.pop() ?? ''
  if (!key && shortcut.endsWith('--')) key = '-'
  const wantsMod = parts.includes('mod')
  const wantsCtrl = parts.includes('ctrl')
  const wantsAlt = parts.includes('alt') || parts.includes('option')
  const wantsShift = parts.includes('shift')
  const isMac = /mac/i.test(navigator.platform) || /macintosh|mac os/i.test(navigator.userAgent)
  const modifierMatches = wantsMod ? (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) : wantsCtrl ? event.ctrlKey && !event.metaKey : !event.ctrlKey && !event.metaKey
  const keyMatches = event.key.toLowerCase() === key || ((key === '/' || key === '?') && event.code === 'Slash')
  return keyMatches && modifierMatches && (wantsAlt ? event.altKey : !event.altKey) && (wantsShift ? event.shiftKey : !event.shiftKey)
}
