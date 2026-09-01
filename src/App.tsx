import { useEffect, useMemo, useState } from 'react'
import { CodeMirrorEditor } from './CodeMirrorEditor'
import { addTagToRange, lineRangeForSelection, parseMarkdown, type ParsedMarkdown } from './markerEngine'
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

function MarkerLegend({ parsed, selectedTag, onSelect }: { parsed: ParsedMarkdown; selectedTag: string | null; onSelect: (tag: string | null) => void }) {
  const tags = useMemo(() => [...new Set(parsed.ranges.map((range) => range.tag))], [parsed])
  return (
    <aside className="legend" aria-label="Tags in this day">
      <div className="legend-title">Tags in this day</div>
      <div className="tag-list">
        {tags.map((tag) => <button className={`tag-pill ${selectedTag === tag ? 'selected' : ''}`} type="button" key={tag} onClick={() => onSelect(selectedTag === tag ? null : tag)}>{tag}</button>)}
      </div>
      <div className="diagnostic-count">{parsed.diagnostics.length ? `${parsed.diagnostics.length} diagnostic${parsed.diagnostics.length === 1 ? '' : 's'}` : 'Markers healthy'}</div>
    </aside>
  )
}

function App() {
  const [day, setDay] = useState(() => logicalDayKey(new Date()))
  const [documents, setDocuments] = useState<Record<string, string>>({})
  const [loaded, setLoaded] = useState(false)
  const [mode, setMode] = useState<'full' | 'capture'>(() => new URLSearchParams(window.location.search).get('mode') === 'capture' ? 'capture' : 'full')
  const [sourceMode, setSourceMode] = useState(false)
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
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
  const categoryExcerpts = useMemo(() => Object.entries(documents).flatMap(([documentDay, markdown]) => {
    const document = parseMarkdown(markdown)
    return document.ranges.filter((range) => range.tag === selectedTag).map((range) => ({
      day: documentDay,
      range,
      text: document.lines.slice(range.startLine + 1, range.endLine).filter(Boolean).join(' '),
    }))
  }), [documents, selectedTag])

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
    if (!tag || selection.from === selection.to) return
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
      <header className="app-header">
        <div>
          <p className="kicker">CodeMirror / local-first notes</p>
          <h1>{mode === 'capture' ? 'Capture a thought.' : 'A calmer place for notes.'}</h1>
          <p className="intro">One continuous Markdown document per day. Add lightweight, overlapping tags without leaving the text editor.</p>
        </div>
        <div className="header-actions">
          <button className="ghost-button" type="button" onClick={() => setMode(mode === 'capture' ? 'full' : 'capture')}>{mode === 'capture' ? 'Full mode' : 'Capture mode'}</button>
          <button className="ghost-button" type="button" onClick={exportMarkdown}>Export .md</button>
          <button className="primary-button" type="button" onClick={() => setSourceMode((visible) => !visible)}>{sourceMode ? 'Normal mode' : 'Edit source'}</button>
        </div>
      </header>

      <section className="day-toolbar">
        <button className="day-arrow" type="button" aria-label="Previous day" onClick={() => setDay((current) => shiftLogicalDay(current, -1))}>←</button>
        <div><span className="eyebrow">Logical day · rollover 4:00 AM</span><h2>{formatLogicalDay(day)}</h2></div>
        <button className="day-arrow" type="button" aria-label="Next day" onClick={() => setDay((current) => shiftLogicalDay(current, 1))}>→</button>
        <span className={`save-state ${saveState}`}>{saveState === 'saving' ? 'Saving…' : 'Saved locally'}</span>
      </section>

      {mode === 'full' && <section className="tools-row">
        <div className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search this day" aria-label="Search this day" />{query && <span className="search-count">{matchingLines.length} lines</span>}</div>
        <div className="tag-tool"><input value={tagInput} onChange={(event) => setTagInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') applyTag() }} placeholder="Tag selected lines…" aria-label="Tag selected lines" /><button type="button" onClick={applyTag} disabled={!tagInput.trim() || selection.from === selection.to}>Add tag</button></div>
      </section>}

      <section className="fixture-bar">
        <div><span className="fixture-label">{sourceMode ? 'Source mode' : mode === 'capture' ? 'Quick capture' : 'Full mode'}</span><strong>{sourceMode ? 'Every marker is plain editable Markdown' : 'Select text in the editor to tag complete lines'}</strong></div>
        <MarkerLegend parsed={parsed} selectedTag={selectedTag} onSelect={setSelectedTag} />
      </section>

      <section className="editor-card selected-editor">
        <div className="editor-heading"><div><span className="eyebrow">{sourceMode ? 'Literal Markdown' : 'Today’s stream'}</span><h2>{day}</h2></div><span className="line-note">{parsed.lines.length} source lines · {parsed.ranges.length} tagged ranges</span></div>
        <CodeMirrorEditor value={source} onChange={updateSource} onSelection={(from, to) => setSelection({ from, to })} focusAtEnd={mode === 'capture'} sourceMode={sourceMode} />
        {selection.from !== selection.to && <div className="selection-hint">Selection ready · expands to complete lines when tagged</div>}
        {parsed.diagnostics.length > 0 && <div className="diagnostics">{parsed.diagnostics.map((diagnostic) => <div key={`${diagnostic.line}-${diagnostic.message}`}>Line {diagnostic.line + 1}: {diagnostic.message}</div>)}</div>}
      </section>

      {mode === 'full' && selectedTag && <section className="category-panel"><div className="source-heading"><div><span className="eyebrow">Category view</span><h2>All “{selectedTag}” notes</h2></div><button className="ghost-button" type="button" onClick={() => setSelectedTag(null)}>Clear</button></div><p>Tagged ranges are projected from the canonical daily document. Click the day above to keep editing its source.</p>{categoryExcerpts.map(({ day: excerptDay, range, text }) => <button className="excerpt" type="button" key={`${excerptDay}-${range.start}-${range.end}`} onClick={() => setDay(excerptDay)}><span>{excerptDay} · lines {range.startLine + 1}–{range.endLine + 1}</span><strong>{text || 'Empty tagged range'}</strong></button>)}</section>}

      <section className="principles"><div><span className="principle-number">01</span><strong>Source-first</strong><span>Markers stay real editor lines.</span></div><div><span className="principle-number">02</span><strong>Autosaved</strong><span>Stored locally as you type.</span></div><div><span className="principle-number">03</span><strong>Portable</strong><span>Export a self-contained Markdown day.</span></div></section>
      <footer className="app-footer"><span>IndexedDB local storage · no account required</span><span>Next: PWA install and offline shell</span></footer>
    </main>
  )
}

export default App
