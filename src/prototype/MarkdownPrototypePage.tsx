import { useState } from 'react'
import { MdxNotesEditor } from '../editor/MdxNotesEditor'
import './markdownPrototype.css'

const SAMPLE_MARKDOWN = `# Markdown editor prototype

This document includes **bold**, *italic*, and <u>underlined</u> text.

<span data-prototype-tag="therapy">This sentence is rendered as tagged content.</span>

<div data-prototype-callout="warning">Custom rendered content can be represented by an HTML attribute or a Markdown extension.</div>

Untagged before

<!-- first -->
First tagged
<!-- /first -->

Untagged between

<!-- second -->
Second tagged
<!-- /second -->

- [ ] A checklist item
- [x] A completed item`

const MULTI_DAY_MARKDOWN: Record<string, string> = {
  day1: `First day top line

Some untagged content here that wraps across multiple lines when the editor is narrow enough to test visual line boundary detection for cross-editor navigation.

<!-- tag -->
Tagged content in day one
<!-- /tag -->`,
  day2: `<!-- leading -->
This day starts with a tag
<!-- /leading -->

Untagged content after the leading tag`,
  day3: `Plain day with only untagged content.

Second paragraph here.`,
}

function MultiEditorPrototype() {
  const [day1, setDay1] = useState(MULTI_DAY_MARKDOWN.day1)
  const [day2, setDay2] = useState(MULTI_DAY_MARKDOWN.day2)
  const [day3, setDay3] = useState(MULTI_DAY_MARKDOWN.day3)
  const docs: Record<string, [string, (markdown: string) => void]> = {
    day1: [day1, setDay1],
    day2: [day2, setDay2],
    day3: [day3, setDay3],
  }
  return <section className="day-stream" aria-label="Multi-editor prototype">
    {Object.entries(docs).map(([day, [source, setSource]]) => (
      <article className="day-card" data-day={day} key={day}>
        <div className="editor-card">
          <h1 className="day-title">{day}</h1>
          <MdxNotesEditor value={source} onChange={setSource} />
        </div>
      </article>
    ))}
  </section>
}

export function MarkdownPrototypePage() {
  const [markdown, setMarkdown] = useState(SAMPLE_MARKDOWN)
  const [hideMuted, setHideMuted] = useState(false)
  const multiMode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('multi')

  if (multiMode) {
    return <main className="markdown-prototype-page">
      <header className="prototype-header"><div><span className="prototype-eyebrow">Editor lab</span><h1>Multi-editor</h1></div></header>
      <MultiEditorPrototype />
    </main>
  }

  return <main className="markdown-prototype-page">
    <header className="prototype-header">
      <div>
        <span className="prototype-eyebrow">Editor lab</span>
        <h1>MDXEditor</h1>
        <p>This isolated editor is now the same modular component used by the application.</p>
      </div>
      <div className="prototype-actions">
        <button type="button" onClick={() => setHideMuted((hidden) => !hidden)} aria-pressed={hideMuted}>{hideMuted ? 'Show muted content' : 'Hide muted content'}</button>
        <button type="button" onClick={() => setMarkdown(SAMPLE_MARKDOWN)}>Reset sample</button>
      </div>
    </header>
    <p className="prototype-status">Formatting, lists, checklists, muted blocks, tags, and custom Markdown are handled by the MDXEditor wrapper.</p>
    <section className="prototype-editor-stack" aria-label="MDXEditor prototype">
      <article className="prototype-panel">
        <div className="prototype-panel-heading"><div><span className="prototype-eyebrow">Prototype</span><h2>MDXEditor</h2></div><span>Markdown-native rich text</span></div>
        <MdxNotesEditor value={markdown} onChange={setMarkdown} hideMutedLines={hideMuted} />
      </article>
    </section>
    <pre data-testid="prototype-source" hidden>{markdown}</pre>
    <aside className="prototype-notes"><strong>Prototype notes</strong><span>Try the formatting, list, checklist, mute, and tag controls, then edit the Markdown directly to evaluate how well the document model fits the existing notes editor.</span></aside>
  </main>
}
