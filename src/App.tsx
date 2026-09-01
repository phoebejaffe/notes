import { useEffect, useMemo, useState } from 'react'
import { CodeMirrorEditor } from './CodeMirrorEditor'
import { addTagToRange, lineRangeForSelection, parseMarkdown } from './markerEngine'
import { formatLogicalDay, logicalDayKey, shiftLogicalDay } from './logicalDay'
import { listDailyDocuments, saveDailyDocument } from './storage'
import './App.css'

const SAMPLE = `<!-- therapy 🧠 -->
## Therapy session

I noticed I am more comfortable setting boundaries.
<!-- /therapy -->
<!-- project "spring launch" -->
## Project notes

Draft the onboarding flow and ask Sam for feedback.
<!-- /"spring launch" -->
<!-- therapy -->
A follow-up thought from later in the day.
<!-- /therapy -->`

interface Selection { from: number; to: number }

function App() {
  const [day, setDay] = useState(() => logicalDayKey(new Date()))
  const [documents, setDocuments] = useState<Record<string, string>>({})
  const [loaded, setLoaded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [sourceMode, setSourceMode] = useState(false)
  const [query, setQuery] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [selection, setSelection] = useState<Selection>({ from: 0, to: 0 })
  const [saveState, setSaveState] = useState<'saved' | 'saving'>('saved')

  useEffect(() => {
    listDailyDocuments().then((stored) => {
      const savedDocuments = Object.fromEntries(stored.map((document) => [document.day, document.markdown]))
      if (!stored.length) savedDocuments[logicalDayKey(new Date())] = SAMPLE
      setDocuments(savedDocuments)
      setLoaded(true)
    }).catch(() => setLoaded(true))
  }, [])

  const source = loaded ? documents[day] ?? '' : ''
  const parsed = useMemo(() => parseMarkdown(source), [source])
  const matchingLines = useMemo(() => {
    if (!query.trim()) return []
    const needle = query.toLocaleLowerCase()
    return parsed.lines.flatMap((line, index) => line.toLocaleLowerCase().includes(needle) ? [index + 1] : [])
  }, [parsed, query])
  const tagAlreadyActive = useMemo(() => {
    if (!tagInput.trim() || selection.from === selection.to) return false
    const { startLine, endLine } = lineRangeForSelection(source, selection.from, selection.to)
    return parsed.ranges.some((range) => range.tag === tagInput.trim().normalize('NFC') && range.startLine <= startLine && range.endLine >= endLine)
  }, [parsed, selection, source, tagInput])

  useEffect(() => {
    if (!loaded) return
    const timer = window.setTimeout(() => {
      setSaveState('saving')
      saveDailyDocument({ day, markdown: source, updatedAt: Date.now() }).then(() => setSaveState('saved')).catch(() => setSaveState('saved'))
    }, 350)
    return () => window.clearTimeout(timer)
  }, [day, loaded, source])

  function updateSource(markdown: string) {
    setDocuments((current) => ({ ...current, [day]: markdown }))
  }

  function applyTag() {
    const tag = tagInput.trim()
    if (!tag || selection.from === selection.to || tagAlreadyActive) return
    const { startLine, endLine } = lineRangeForSelection(source, selection.from, selection.to)
    const result = addTagToRange(source, startLine, endLine, tag)
    if (!result.error) {
      updateSource(result.source)
      setTagInput('')
      setSelection({ from: 0, to: 0 })
    }
  }

  function exportMarkdown() {
    const blob = new Blob([source], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${day}.md`
    link.click()
    URL.revokeObjectURL(url)
  }

  if (!loaded) return <main className="loading-screen">Opening your notes…</main>

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <button className="icon-button" type="button" aria-label="Open menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>☰</button>
          <button className="icon-button" type="button" aria-label="Search" aria-expanded={searchOpen} onClick={() => setSearchOpen((open) => !open)}>⌕</button>
          <span className="top-date">{formatLogicalDay(day)}</span>
        </div>
        <span className={`save-state ${saveState}`}>{saveState === 'saving' ? 'Saving…' : 'Saved'}</span>
        {menuOpen && <nav className="menu-panel" aria-label="Notes menu">
          <button type="button" onClick={() => { setSourceMode((visible) => !visible); setMenuOpen(false) }}>{sourceMode ? 'Normal editor' : 'Edit source'}</button>
          <button type="button" onClick={() => { exportMarkdown(); setMenuOpen(false) }}>Export Markdown</button>
          <button type="button" onClick={() => { updateSource(SAMPLE); setMenuOpen(false) }}>Reset sample</button>
        </nav>}
      </header>

      {searchOpen && <section className="search-panel"><span className="search-symbol">⌕</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search this day" aria-label="Search this day" />{query && <span className="search-count">{matchingLines.length} matching lines</span>}</section>}

      <section className="day-toolbar">
        <button className="day-arrow" type="button" aria-label="Previous day" onClick={() => setDay((current) => shiftLogicalDay(current, -1))}>←</button>
        <h1>{day}</h1>
        <button className="day-arrow" type="button" aria-label="Next day" onClick={() => setDay((current) => shiftLogicalDay(current, 1))}>→</button>
      </section>

      <section className="editor-card selected-editor">
        <div className="editor-heading"><span className="eyebrow">{sourceMode ? 'Edit source' : 'Notes'}</span><span className="line-note">{parsed.lines.length} lines</span></div>
        <CodeMirrorEditor value={source} onChange={updateSource} onSelection={(from, to) => setSelection({ from, to })} sourceMode={sourceMode} />
        {!sourceMode && selection.from !== selection.to && <div className="tag-popover" role="dialog" aria-label="Add tag to selection">
          <span className="popover-label">Tag selected lines</span>
          <input autoFocus value={tagInput} onChange={(event) => setTagInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') applyTag() }} placeholder="therapy, 🧠, or project" aria-label="New tag" />
          <button type="button" onClick={applyTag} disabled={!tagInput.trim() || tagAlreadyActive}>Add</button>
          {tagAlreadyActive && <span className="tag-warning">This tag is already active here.</span>}
        </div>}
        {parsed.diagnostics.length > 0 && <div className="diagnostics">{parsed.diagnostics.map((diagnostic) => <div key={`${diagnostic.line}-${diagnostic.message}`}>Line {diagnostic.line + 1}: {diagnostic.message}</div>)}</div>}
      </section>

      <footer className="app-footer"><span>Local notes · {sourceMode ? 'raw Markdown' : 'source-first editor'}</span><span>Markers stay editable lines</span></footer>
    </main>
  )
}

export default App
