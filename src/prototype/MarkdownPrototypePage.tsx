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

const LINE_MOVEMENT_MARKDOWN = `prefix alpha
first line
second line
third line
suffix omega`

const HARD_LINE_MOVEMENT_MARKDOWN = `Line A

Line B

Line C`

const LINK_END_MOVEMENT_MARKDOWN = `Line A

Line B [link](https://example.com)

Line C`

const TAGGED_LINE_MOVEMENT_MARKDOWN = `Line above

:::tag{name="brainstorm"}
Questions for Lyle
- Line A
- Line B
- Line C
:::

Line below`

const NORMAL_THEN_TAG_MOVEMENT_MARKDOWN = `Line 1
Line 2
Line 3

:::tag{name="brainstorm"}
Questions for Lyle
- Tag A
- Tag B
- Tag C
:::

Line below`

const REPEATED_MOVEMENT_MARKDOWN = `Line above

:::tag{name="brainstorm"}
Questions for Lyle
- Line A
- Line B
- Line C
:::

Later list
- Line D
- Line E
- Line F

Line below`

const LIST_MOVEMENT_MARKDOWN = `prefix alpha
- first item
- second item
  - second child one
  - second child two
- third item
1. ordered one
  1. ordered nested
2. ordered two
suffix omega`

const CHECKLIST_MARKDOWN = `prefix alpha
- [ ] first task
- [x] second task
  - [ ] nested task
- regular item
suffix omega`

const CHECKLIST_POSITION_MARKDOWN = `prefix alpha
- A deliberately long line above the checklist that will wrap when the editor becomes narrow enough to exercise natural checkbox positioning.
- [ ] The checklist stays attached to this line
suffix omega`

const AUDIO_TRANSCRIPTION_MARKDOWN = `💡 Be able to talk to a few other people about that and get their feedback about the business.[ ](https://us-central1-pebble-ring-sync-20260911.cloudfunctions.net/recordingAudio?id=fcb9611553c62fab066af5a3d562601e&t=LKt6bG9IHz6faGOPCknYHtoajtzuKOm9qSa6ir3veqE)
- [ ] 💡 Find someone to go to the symphony with me.[ ](https://us-central1-pebble-ring-sync-20260911.cloudfunctions.net/recordingAudio?id=8b71347e6846691b4ca4e9598b6ab96f&t=Ovow199-bWVfT-k8WfCoiIQrgMcJa4P87caHuo8t7ck)
💡 Kept finding blonde pubes on their pants.[ ](https://us-central1-pebble-ring-sync-20260911.cloudfunctions.net/recordingAudio?id=879fc5d90c8afa9217f84bcb6b5cd338&t=Kcu93ypuxY7a_eU9Xziild5ZVq_kTaJQayvPXl4tm7E)`

const TAGGED_LIST_MARKDOWN = `:::tag{name="book club"}
Line 1

Line 2

Line 3
:::`

const TAGGED_MUTE_MARKDOWN = `:::tag{name="book club"}
Line 1
Line 2
Line 3
:::`

const TAGGING_MARKDOWN = `prefix alpha
first line
second line
third line
suffix omega`

const FORMATTING_MARKDOWN = `prefix alpha
plain target text
**already bold** and *already italic*
[link text](https://example.com) with trailing text
suffix omega`

const MUTED_MARKDOWN = `prefix alpha
plain target
%% already muted
- list target
## heading target
- [ ] task target
> quote target
suffix omega`

const PLAIN_TEXT_MARKDOWN = `prefix alpha
alpha target middle
formatted **bold target** and *italic target*
suffix omega`

const STRUCTURE_MARKDOWN = `prefix alpha
# Heading target
> quote target
- bullet target
:::tag{name="existing"}
tagged target
:::
suffix omega`

const LONG_SCROLL_MARKDOWN = `top marker
${Array.from({ length: 30 }, (_, index) => `scroll filler ${index + 1}`).join('\n')}
- [ ] scrolled task
scrolled target
${Array.from({ length: 30 }, (_, index) => `trailing filler ${index + 1}`).join('\n')}
bottom marker`

const SINGLE_EDITOR_SCENARIOS: Record<string, string> = {
  'line-movement': LINE_MOVEMENT_MARKDOWN,
  'line-movement-hard': HARD_LINE_MOVEMENT_MARKDOWN,
  'line-movement-link-end': LINK_END_MOVEMENT_MARKDOWN,
  'tagged-line-movement': TAGGED_LINE_MOVEMENT_MARKDOWN,
  'repeated-line-movement': REPEATED_MOVEMENT_MARKDOWN,
  'normal-then-tag-movement': NORMAL_THEN_TAG_MOVEMENT_MARKDOWN,
  'line-movement-soft': `prefix alpha
first line
second line
third line
suffix omega`,
  'list-movement': LIST_MOVEMENT_MARKDOWN,
  checklist: CHECKLIST_MARKDOWN,
  'checklist-position': CHECKLIST_POSITION_MARKDOWN,
  'audio-transcription-checklist': AUDIO_TRANSCRIPTION_MARKDOWN,
  'tagged-list-lines': TAGGED_LIST_MARKDOWN,
  'tagged-muted-lines': TAGGED_MUTE_MARKDOWN,
  tagging: TAGGING_MARKDOWN,
  'tagging-soft': `prefix alpha
first line
second line
third line
suffix omega`,
  formatting: FORMATTING_MARKDOWN,
  muted: MUTED_MARKDOWN,
  'plain-text': PLAIN_TEXT_MARKDOWN,
  structure: STRUCTURE_MARKDOWN,
  scroll: LONG_SCROLL_MARKDOWN,
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
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
  const scenario = params?.get('scenario') ?? ''
  const initialMarkdown = SINGLE_EDITOR_SCENARIOS[scenario] ?? SAMPLE_MARKDOWN
  const [markdown, setMarkdown] = useState(initialMarkdown)
  const [hideMuted, setHideMuted] = useState(false)
  const multiMode = params?.has('multi') ?? false

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
      <article className="prototype-panel" data-testid="prototype-editor" data-scenario={scenario || 'sample'}>
        <div className="prototype-panel-heading"><div><span className="prototype-eyebrow">Prototype</span><h2>MDXEditor</h2></div><span>Markdown-native rich text</span></div>
        <MdxNotesEditor value={markdown} onChange={setMarkdown} hideMutedLines={hideMuted} />
      </article>
    </section>
    <pre data-testid="prototype-source" hidden>{markdown}</pre>
    <aside className="prototype-notes"><strong>Prototype notes</strong><span>Try the formatting, list, checklist, mute, and tag controls, then edit the Markdown directly to evaluate how well the document model fits the existing notes editor.</span></aside>
  </main>
}
