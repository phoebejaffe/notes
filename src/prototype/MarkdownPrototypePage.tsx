import { useState } from 'react'
import { MdxNotesEditor } from '../editor/MdxNotesEditor'
import './markdownPrototype.css'

const SAMPLE_MARKDOWN = `# Markdown editor prototype

This document includes **bold**, *italic*, and <u>underlined</u> text.

<span data-prototype-tag="therapy">This sentence is rendered as tagged content.</span>

<div data-prototype-callout="warning">Custom rendered content can be represented by an HTML attribute or a Markdown extension.</div>

%% This is muted content. Use the filter button above to hide or show it.

<!-- therapy -->
The existing application uses HTML comments for tag ranges, so this syntax must remain safe.
<!-- /therapy -->

## Arbitrary syntax

Unknown constructs should remain visible and editable rather than silently disappearing:

:::custom-block{kind="diagram"}
This is an application-specific directive.
:::

- [ ] A checklist item
- [x] A completed item`

export function MarkdownPrototypePage() {
  const [markdown, setMarkdown] = useState(SAMPLE_MARKDOWN)
  const [hideMuted, setHideMuted] = useState(false)

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
    <aside className="prototype-notes"><strong>Prototype notes</strong><span>Try the formatting, list, checklist, mute, and tag controls, then edit the Markdown directly to evaluate how well the document model fits the existing notes editor.</span></aside>
  </main>
}
