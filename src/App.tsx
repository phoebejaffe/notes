import { useEffect, useMemo, useRef, useState } from 'react'
import { CodeMirrorEditor } from './CodeMirrorEditor'
import { addTagToRange, lineRangeForSelection, parseMarkdown } from './markerEngine'
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

interface Selection { day: string; from: number; to: number }

function App() {
  const today = useMemo(() => logicalDayKey(new Date()), [])
  const [days, setDays] = useState(() => [today, shiftLogicalDay(today, -1)])
  const [documents, setDocuments] = useState<Record<string, string>>({})
  const [loaded, setLoaded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [sourceMode, setSourceMode] = useState(false)
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
      if (event.metaKey && event.key.toLowerCase() === 't' && selection.day && selection.from !== selection.to) {
        event.preventDefault()
        tagInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', focusTagInput)
    return () => window.removeEventListener('keydown', focusTagInput)
  }, [selection])

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
          <button type="button" onClick={() => { exportMarkdown(today); setMenuOpen(false) }}>Export today</button>
          <button type="button" onClick={() => { updateSource(today, SAMPLE); setMenuOpen(false) }}>Reset today</button>
        </nav>}
      </header>}

      {!captureMode && searchOpen && <section className="search-panel"><span className="search-symbol">⌕</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your notes" aria-label="Search your notes" />{query && <span className="search-count">{searchResults.length} matches</span>}</section>}

      <section className="day-stream" aria-label="Daily notes">
        {days.map((documentDay) => {
          const source = documents[documentDay] ?? ''
          const parsed = parseMarkdown(source)
          return <article className="day-card" data-day={documentDay} key={documentDay}>
            <div className="editor-card">
              <h1 className="day-title">{formatLogicalDay(documentDay)}</h1>
              <CodeMirrorEditor value={source} onChange={(markdown) => updateSource(documentDay, markdown)} onSelection={(from, to) => setSelection({ day: documentDay, from, to })} focusAtEnd={captureMode && documentDay === today} sourceMode={sourceMode} />

              {parsed.diagnostics.length > 0 && <div className="diagnostics">{parsed.diagnostics.map((diagnostic) => <div key={`${diagnostic.line}-${diagnostic.message}`}>Line {diagnostic.line + 1}: {diagnostic.message}</div>)}</div>}
            </div>
          </article>
        })}
        <div className="stream-sentinel" ref={streamEndRef} aria-hidden="true" />
      </section>

      {!sourceMode && selection.day && selection.from !== selection.to && <div className="tag-bar" role="dialog" aria-label="Add tag to selection">
        <span className="popover-label">Tag lines</span>
        <input ref={tagInputRef} value={tagInput} onChange={(event) => setTagInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submitTag() } }} placeholder="therapy, 🧠, or project" aria-label="New tag" />
        <button type="button" onClick={submitTag} disabled={!tagInput.trim() || tagAlreadyActive}>Add</button>
        {tagAlreadyActive && <span className="tag-warning">Already active here.</span>}
        <span className="tag-shortcut">⌘T</span>
      </div>}
    </main>
  )
}

export default App
