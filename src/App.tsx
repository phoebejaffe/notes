import { useEffect, useMemo, useRef, useState } from 'react'
import { CodeMirrorEditor } from './CodeMirrorEditor'
import { addTagToRange, lineRangeForSelection, parseMarkdown, removeTagAtPosition } from './markerEngine'
import { formatLogicalDay, logicalDayKey, shiftLogicalDay } from './logicalDay'
import { listDailyDocuments, saveDailyDocument } from './storage'
import './App.css'

const SAMPLE = `<!-- therapy 🧠 -->
## Therapy session

I noticed I am more comfortable setting boundaries.

- Practice **bold**, *italic*, and <u>underlined</u> text.
<!-- /therapy -->
<!-- project "spring launch" -->
## Project notes

Draft the onboarding flow and ask Sam for feedback.
<!-- /"spring launch" -->
<!-- therapy -->
A follow-up thought from later in the day.
<!-- /therapy -->`

const DEFAULT_TAG_COLORS = ['#6d9b91', '#8975aa', '#c88968', '#7190b0', '#b28a55']

function defaultTagColor(tag: string) {
  const hash = [...tag].reduce((sum, character) => sum + character.codePointAt(0)!, 0) % DEFAULT_TAG_COLORS.length
  return DEFAULT_TAG_COLORS[hash]
}

function loadTagColors() {
  try {
    return JSON.parse(localStorage.getItem('notes-tag-colors') ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

interface Selection { day: string; from: number; to: number }

function App() {
  const today = useMemo(() => logicalDayKey(new Date()), [])
  const [days, setDays] = useState(() => [today, shiftLogicalDay(today, -1)])
  const [documents, setDocuments] = useState<Record<string, string>>({})
  const [loaded, setLoaded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [tagsOpen, setTagsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [sourceMode, setSourceMode] = useState(false)
  const [tagColors, setTagColors] = useState<Record<string, string>>(loadTagColors)
  const [query, setQuery] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [selection, setSelection] = useState<Selection>({ day: '', from: 0, to: 0 })
  const [saveState, setSaveState] = useState<'saved' | 'saving'>('saved')
  const [zoomLevel, setZoomLevel] = useState(100)
  const tagInputRef = useRef<HTMLInputElement>(null)
  const captureMode = useMemo(() => new URLSearchParams(window.location.search).get('mode') === 'capture', [])
  const streamEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listDailyDocuments().then((stored) => {
      const savedDocuments = Object.fromEntries(stored.map((document) => [document.day, document.markdown]))
      if (!stored.length) savedDocuments[today] = SAMPLE
      setDocuments(savedDocuments)
      setLoaded(true)
    }).catch(() => setLoaded(true))
  }, [today])

  useEffect(() => {
    localStorage.setItem('notes-tag-colors', JSON.stringify(tagColors))
  }, [tagColors])

  const allTags = useMemo(() => [...new Set(Object.values(documents).flatMap((markdown) => parseMarkdown(markdown).ranges.map((range) => range.tag)))].sort((left, right) => left.localeCompare(right)), [documents])

  useEffect(() => {
    if (!loaded) return
    const observer = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) return
      setDays((current) => [...current, shiftLogicalDay(current[current.length - 1], -1)])
    }, { rootMargin: '0px 0px 800px 0px' })
    if (streamEndRef.current) observer.observe(streamEndRef.current)
    return () => observer.disconnect()
  }, [loaded])

  useEffect(() => {
    function focusTagInput(event: KeyboardEvent) {
      const activeDocument = selection.day ? documents[selection.day] ?? '' : ''
      const insideTag = selection.day && parseMarkdown(activeDocument).ranges.some((range) => range.start < selection.from && selection.from < range.end)
      if (event.metaKey && event.key.toLowerCase() === 't' && selection.day && (selection.from !== selection.to || insideTag)) {
        event.preventDefault()
        tagInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', focusTagInput)
    return () => window.removeEventListener('keydown', focusTagInput)
  }, [documents, selection])

  useEffect(() => {
    function handleInterfaceShortcuts(event: KeyboardEvent) {
      if (!event.metaKey) return
      if (event.key === '=' || event.key === '+') {
        event.preventDefault()
        setZoomLevel((current) => Math.min(150, current + 10))
        return
      }
      if (event.key === '-') {
        event.preventDefault()
        setZoomLevel((current) => Math.max(70, current - 10))
        return
      }
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      const cards = [...document.querySelectorAll<HTMLElement>('.day-card')]
      const activeCard = document.activeElement?.closest('.day-card') as HTMLElement | null
      const currentIndex = activeCard ? cards.indexOf(activeCard) : 0
      const nextIndex = currentIndex + (event.key === 'ArrowDown' ? 1 : -1)
      const nextEditor = cards[nextIndex]?.querySelector<HTMLElement>('.cm-content')
      if (nextEditor) {
        event.preventDefault()
        nextEditor.focus()
        nextEditor.scrollIntoView({ block: 'center' })
      }
    }
    window.addEventListener('keydown', handleInterfaceShortcuts)
    return () => window.removeEventListener('keydown', handleInterfaceShortcuts)
  }, [])

  useEffect(() => {
    if (!loaded) return
    const timer = window.setTimeout(() => {
      setSaveState('saving')
      Promise.all(Object.entries(documents).filter(([, markdown]) => markdown).map(([day, markdown]) => saveDailyDocument({ day, markdown, updatedAt: Date.now() }))).then(() => setSaveState('saved')).catch(() => setSaveState('saved'))
    }, 350)
    return () => window.clearTimeout(timer)
  }, [documents, loaded])

  const selectedSource = selection.day ? documents[selection.day] ?? '' : ''
  const selectedParsed = useMemo(() => parseMarkdown(selectedSource), [selectedSource])
  const tagAlreadyActive = useMemo(() => {
    if (!tagInput.trim() || selection.from === selection.to) return false
    const { startLine, endLine } = lineRangeForSelection(selectedSource, selection.from, selection.to)
    return selectedParsed.ranges.some((range) => range.tag === tagInput.trim().normalize('NFC') && range.startLine <= startLine && range.endLine >= endLine)
  }, [selectedParsed, selectedSource, selection, tagInput])
  const currentTags = useMemo(() => [...new Set(selectedParsed.ranges.filter((range) => selection.from === selection.to ? range.start < selection.from && selection.from < range.end : range.start < selection.to && range.end > selection.from).map((range) => range.tag))], [selectedParsed, selection])
  const searchResults = useMemo(() => {
    if (!query.trim()) return []
    const needle = query.toLocaleLowerCase()
    return Object.entries(documents).flatMap(([day, markdown]) => parseMarkdown(markdown).lines.flatMap((line, index) => line.toLocaleLowerCase().includes(needle) ? [{ day, line: index + 1, text: line }] : []))
  }, [documents, query])

  function updateSource(day: string, markdown: string) {
    setDocuments((current) => ({ ...current, [day]: markdown }))
  }

  function applyTag() {
    const tag = tagInput.trim()
    if (!tag || selection.from === selection.to || tagAlreadyActive) return
    const { startLine, endLine } = lineRangeForSelection(selectedSource, selection.from, selection.to)
    const result = addTagToRange(selectedSource, startLine, endLine, tag)
    if (!result.error) {
      updateSource(selection.day, result.source)
      setTagInput('')
      setSelection({ day: '', from: 0, to: 0 })
    }
  }

  function removeSelectedTag(tag: string) {
    if (!selection.day) return
    const { startLine } = lineRangeForSelection(selectedSource, selection.from, selection.to)
    const result = removeTagAtPosition(selectedSource, startLine, tag)
    if (!result.error) updateSource(selection.day, result.source)
  }

  function submitTag() {
    const previousDay = selection.day
    applyTag()
    if (previousDay) {
      window.setTimeout(() => {
        const editor = document.querySelector(`[data-day="${previousDay}"] .cm-content`) as HTMLElement | null
        editor?.focus()
      }, 0)
    }
  }

  function exportMarkdown(day: string) {
    const blob = new Blob([documents[day] ?? ''], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${day}.md`
    link.click()
    URL.revokeObjectURL(url)
  }

  if (!loaded) return <main className="loading-screen">Opening your notes…</main>

  return (
    <main className={captureMode ? 'capture-shell' : 'app-shell'} style={{ zoom: zoomLevel / 100 }}>
      {!captureMode && <header className="topbar">
        <div className="topbar-left">
          <button className="icon-button" type="button" aria-label="Open menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>☰</button>
        </div>
        <div className="topbar-right">
          <button className="search-button" type="button" aria-label="Search" aria-expanded={searchOpen} onClick={() => setSearchOpen((open) => !open)}>⌕</button>
          {saveState === 'saving' && <span className="save-spinner" role="status" aria-label="Saving" />}
        </div>
        {menuOpen && <nav className="menu-panel" aria-label="Notes menu">
          <button type="button" onClick={() => { setSourceMode((visible) => !visible); setMenuOpen(false) }}>{sourceMode ? 'Normal editor' : 'Edit source'}</button>
          <button type="button" onClick={() => { setSearchOpen(true); setMenuOpen(false) }}>Search</button>
          <button type="button" onClick={() => { setSettingsOpen(true); setMenuOpen(false) }}>Settings</button>
          <button type="button" onClick={() => { setTagsOpen(true); setMenuOpen(false) }}>Tags</button>
          <button type="button" onClick={() => { exportMarkdown(today); setMenuOpen(false) }}>Export today</button>
          <button type="button" disabled>Export all</button>
          <button type="button" disabled>Jump to today</button>
          <button type="button" onClick={() => { updateSource(today, SAMPLE); setMenuOpen(false) }}>Reset today</button>
        </nav>}
      </header>}
      {captureMode && <div className="capture-menu">
        <button className="icon-button" type="button" aria-label="Open quick entry menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>☰</button>
        {menuOpen && <nav className="menu-panel" aria-label="Quick entry menu">
          <button type="button" onClick={() => { setSearchOpen((open) => !open); setMenuOpen(false) }}>Search</button>
          <button type="button" onClick={() => { setSourceMode((visible) => !visible); setMenuOpen(false) }}>{sourceMode ? 'Normal editor' : 'Edit source'}</button>
          <span className="shortcut-hint">Ctrl⌥N to show or hide</span>
        </nav>}
      </div>}

      {searchOpen && <section className="search-panel"><span className="search-symbol">⌕</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your notes" aria-label="Search your notes" />{query && <span className="search-count">{searchResults.length} matches</span>}</section>}

      <section className="day-stream" aria-label="Daily notes">
        {days.map((documentDay) => {
          const source = documents[documentDay] ?? ''
          const parsed = parseMarkdown(source)
          return <article className="day-card" data-day={documentDay} key={documentDay}>
            <div className="editor-card">
              <h1 className="day-title">{formatLogicalDay(documentDay)}</h1>
              <CodeMirrorEditor value={source} onChange={(markdown) => updateSource(documentDay, markdown)} onSelection={(from, to) => setSelection({ day: documentDay, from, to })} focusAtEnd={captureMode && documentDay === today} sourceMode={sourceMode} tagColors={tagColors} />

              {parsed.diagnostics.length > 0 && <div className="diagnostics">{parsed.diagnostics.map((diagnostic) => <div key={`${diagnostic.line}-${diagnostic.message}`}>Line {diagnostic.line + 1}: {diagnostic.message}</div>)}</div>}
            </div>
          </article>
        })}
        <div className="stream-sentinel" ref={streamEndRef} aria-hidden="true" />
      </section>

      {!sourceMode && selection.day && (selection.from !== selection.to || currentTags.length > 0) && <div className="tag-bar" role="dialog" aria-label="Tags at cursor or selection">
        <div className="active-tag-chips">{currentTags.map((tag) => <span className="active-tag-chip" key={tag}>{tag}<button type="button" aria-label={`Remove ${tag}`} onClick={() => removeSelectedTag(tag)}>×</button></span>)}</div>
        <span className="popover-label">Tag lines</span>
        <input ref={tagInputRef} value={tagInput} onChange={(event) => setTagInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submitTag() } }} placeholder="therapy, 🧠, or project" aria-label="New tag" />
        <button type="button" onClick={submitTag} disabled={!tagInput.trim() || tagAlreadyActive}>Add</button>
        {tagAlreadyActive && <span className="tag-warning">Already active here.</span>}
        <span className="tag-shortcut">⌘T</span>
      </div>}

      {!captureMode && settingsOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setSettingsOpen(false) }}>
        <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title" aria-describedby="settings-modal-description">
          <div className="modal-heading"><div><span className="eyebrow">Preferences</span><h2 id="settings-modal-title">Settings</h2></div><button className="modal-close" type="button" aria-label="Close settings" onClick={() => setSettingsOpen(false)}>×</button></div>
          <p className="settings-description" id="settings-modal-description"><span className="settings-asterisk">*</span> These settings are planned and are not active yet.</p>

          <fieldset className="settings-group"><legend>Editor</legend>
            <label className="settings-row"><span className="settings-label">Editor mode <span className="settings-asterisk">*</span></span><select value="Normal editor" onChange={(event) => event.preventDefault()}><option>Normal editor</option><option>Edit source</option></select></label>
            <label className="settings-row"><span className="settings-label">Zoom <span className="settings-asterisk">*</span></span><select value="100%" onChange={(event) => event.preventDefault()}><option>90%</option><option>100%</option><option>110%</option><option>125%</option></select></label>
            <label className="settings-row"><span className="settings-label">Font choice <span className="settings-asterisk">*</span></span><select value="System sans-serif" onChange={(event) => event.preventDefault()}><option>System sans-serif</option><option>Serif</option><option>Monospace</option></select></label>
          </fieldset>

          <fieldset className="settings-group"><legend>Daily notes</legend>
            <label className="settings-row"><span className="settings-label">Day rollover time <span className="settings-asterisk">*</span></span><input type="time" value="04:00" onChange={(event) => event.preventDefault()} /></label>
            <label className="settings-row"><span className="settings-label">Show empty days <span className="settings-asterisk">*</span></span><input type="checkbox" checked={false} onChange={(event) => event.preventDefault()} /></label>
            <label className="settings-row"><span className="settings-label">Date display format <span className="settings-asterisk">*</span></span><select value="Monday, September 2, 2026" onChange={(event) => event.preventDefault()}><option>Monday, September 2, 2026</option><option>Sep 2, 2026</option><option>2026-09-02</option></select></label>
          </fieldset>

          <fieldset className="settings-group"><legend>Appearance</legend>
            <label className="settings-row"><span className="settings-label">Dark/light mode <span className="settings-asterisk">*</span></span><select value="Light" onChange={(event) => event.preventDefault()}><option>Light</option><option>Dark</option><option>System</option></select></label>
            <label className="settings-row"><span className="settings-label">Compact spacing <span className="settings-asterisk">*</span></span><input type="checkbox" checked={false} onChange={(event) => event.preventDefault()} /></label>
          </fieldset>

          <fieldset className="settings-group"><legend>Data &amp; backups</legend>
            <label className="settings-row"><span className="settings-label">Automatic backup <span className="settings-asterisk">*</span></span><select value="Off" onChange={(event) => event.preventDefault()}><option>Off</option><option>Daily</option><option>Weekly</option></select></label>
          </fieldset>

          <fieldset className="settings-group"><legend>Capture mode</legend>
            <label className="settings-row"><span className="settings-label">Global capture shortcut <span className="settings-asterisk">*</span></span><input className="shortcut-input" value="Ctrl⌥N" readOnly /></label>
            <label className="settings-row"><span className="settings-label">Capture window always on top <span className="settings-asterisk">*</span></span><input type="checkbox" checked onChange={(event) => event.preventDefault()} /></label>
            <label className="settings-row"><span className="settings-label">Launch at login <span className="settings-asterisk">*</span></span><input type="checkbox" checked={false} onChange={(event) => event.preventDefault()} /></label>
            <label className="settings-row"><span className="settings-label">Show in menu bar <span className="settings-asterisk">*</span></span><input type="checkbox" checked onChange={(event) => event.preventDefault()} /></label>
            <label className="settings-row"><span className="settings-label">Show dock icon <span className="settings-asterisk">*</span></span><input type="checkbox" checked={false} onChange={(event) => event.preventDefault()} /></label>
            <p className="settings-help">At least one of “Show in menu bar” and “Show dock icon” must be selected.</p>
          </fieldset>

          <fieldset className="settings-group"><legend>Keyboard shortcuts</legend>
            <label className="settings-row"><span className="settings-label">Customize shortcuts <span className="settings-asterisk">*</span></span><button className="settings-action" type="button" onClick={(event) => event.preventDefault()}>Configure</button></label>
          </fieldset>

          <fieldset className="settings-group"><legend>Tags</legend>
            <label className="settings-row"><span className="settings-label">Manage known tags <span className="settings-asterisk">*</span></span><button className="settings-action" type="button" onClick={(event) => event.preventDefault()}>Manage</button></label>
            <label className="settings-row"><span className="settings-label">Rename a tag everywhere <span className="settings-asterisk">*</span></span><button className="settings-action" type="button" onClick={(event) => event.preventDefault()}>Rename</button></label>
            <label className="settings-row"><span className="settings-label">Choose tag colors <span className="settings-asterisk">*</span></span><button className="settings-action" type="button" onClick={(event) => event.preventDefault()}>Choose</button></label>
            <label className="settings-row"><span className="settings-label">Hide tag syntax <span className="settings-asterisk">*</span></span><input type="checkbox" checked={false} onChange={(event) => event.preventDefault()} /></label>
          </fieldset>
        </section>
      </div>}

      {!captureMode && tagsOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setTagsOpen(false) }}>
        <section className="tag-modal" role="dialog" aria-modal="true" aria-labelledby="tag-modal-title">
          <div className="modal-heading"><div><span className="eyebrow">Organization</span><h2 id="tag-modal-title">Tag colors</h2></div><button className="modal-close" type="button" aria-label="Close tag colors" onClick={() => setTagsOpen(false)}>×</button></div>
          {allTags.length ? allTags.map((tag) => <label className="color-row" key={tag}><span>{tag}</span><input type="color" value={tagColors[tag] ?? defaultTagColor(tag)} onChange={(event) => setTagColors((current) => ({ ...current, [tag]: event.target.value }))} /></label>) : <p className="empty-modal">Add a tag to see it here.</p>}
        </section>
      </div>}
    </main>
  )
}

export default App
