import { useEffect, useMemo, useRef, useState } from 'react'
import { BoldItalicUnderlineToggles, GenericDirectiveEditor, MDXEditor, ListsToggle, UndoRedo, directivesPlugin, headingsPlugin, insertDirective$, linkPlugin, listsPlugin, markdownShortcutPlugin, quotePlugin, tablePlugin, thematicBreakPlugin, toolbarPlugin, type DirectiveDescriptor } from '@mdxeditor/editor'
import { usePublisher } from '@mdxeditor/editor'
import '@mdxeditor/editor/style.css'
import './markdownPrototype.css'

const SAMPLE_MARKDOWN = `# Markdown editor prototype

This document is shared by both editors. It includes **bold**, *italic*, and <u>underlined</u> text.

<span data-prototype-tag="therapy">This sentence is rendered as a tagged inline element.</span>

<div data-prototype-callout="warning">Custom rendered content can be represented by an HTML attribute or a Markdown extension.</div>

<p data-prototype-muted="true">%% This is muted content. Use the button above to hide or show it.</p>

<!-- therapy -->
The existing application uses HTML comments for tag ranges, so this syntax must remain safe.
<!-- /therapy -->

## Arbitrary syntax

Unknown constructs should remain visible and editable rather than silently disappearing:

:::custom-block{kind="diagram"}
This is an application-specific directive.
:::


after the custom block.`

const TAG_DIRECTIVE: DirectiveDescriptor = {
  name: 'tag',
  testNode: (node) => node.name === 'tag',
  attributes: ['name'],
  hasChildren: true,
  Editor: GenericDirectiveEditor,
}

const CUSTOM_DIRECTIVE: DirectiveDescriptor = {
  name: 'custom-block',
  testNode: (node) => node.name === 'custom-block',
  attributes: ['kind'],
  hasChildren: true,
  Editor: GenericDirectiveEditor,
}

const MUTED_DIRECTIVE: DirectiveDescriptor = {
  name: 'muted',
  testNode: (node) => node.name === 'muted',
  attributes: [],
  hasChildren: true,
  Editor: GenericDirectiveEditor,
}

function AddTagControl() {
  const insertDirective = usePublisher(insertDirective$)
  const [tag, setTag] = useState('therapy')

  return (
    <span className="prototype-tag-control">
      <input value={tag} onChange={(event) => setTag(event.target.value)} aria-label="Tag name" placeholder="Tag name" />
      <button type="button" onClick={() => { const name = tag.trim(); if (name) insertDirective({ name: 'tag', type: 'containerDirective', attributes: { name } }) }}>+ Tag</button>
    </span>
  )
}

function PrototypeToolbar() {
  const insertDirective = usePublisher(insertDirective$)

  return (
    <>
      <UndoRedo />
      <BoldItalicUnderlineToggles />
      <ListsToggle options={['bullet', 'number', 'check']} />
      <button className="prototype-toolbar-button" type="button" onClick={() => insertDirective({ name: 'muted', type: 'containerDirective', attributes: {} })}>Mute block</button>
      <AddTagControl />
    </>
  )
}

function setMutedVisibility(root: HTMLElement | null, hidden: boolean) {
  if (!root) return
  const candidates = root.querySelectorAll<HTMLElement>('[data-prototype-muted="true"], p, div, li, blockquote')
  candidates.forEach((element) => {
    const isMuted = element.matches('[data-prototype-muted="true"]') || element.textContent?.trimStart().startsWith('%%')
    if (isMuted) element.hidden = hidden
  })
}

function scheduleMutedVisibility(root: HTMLElement | null, hidden: boolean) {
  const frame = window.requestAnimationFrame(() => setMutedVisibility(root, hidden))
  return () => window.cancelAnimationFrame(frame)
}

function MdxEditorPrototype({ markdown, onChange, hideMuted }: { markdown: string; onChange: (value: string) => void; hideMuted: boolean }) {
  const editorRef = useRef<HTMLDivElement>(null)

  useEffect(() => scheduleMutedVisibility(editorRef.current, hideMuted), [hideMuted, markdown])

  return (
    <div className="prototype-editor-shell prototype-mdx-editor" ref={editorRef}>
      <MDXEditor
        markdown={markdown}
        onChange={onChange}
        plugins={[
          headingsPlugin(),
          listsPlugin(),
          quotePlugin(),
          linkPlugin(),
          tablePlugin(),
          thematicBreakPlugin(),
          markdownShortcutPlugin(),
          directivesPlugin({ directiveDescriptors: [TAG_DIRECTIVE, CUSTOM_DIRECTIVE, MUTED_DIRECTIVE] }),
          toolbarPlugin({ toolbarContents: () => <PrototypeToolbar /> }),
        ]}
      />
    </div>
  )
}

export function MarkdownPrototypePage() {
  const [mdxMarkdown, setMdxMarkdown] = useState(SAMPLE_MARKDOWN)
  const [hideMuted, setHideMuted] = useState(false)
  const mutedCount = useMemo(() => (SAMPLE_MARKDOWN.match(/data-prototype-muted="true"/gu) ?? []).length, [])

  return (
    <main className="markdown-prototype-page">
      <header className="prototype-header">
        <div>
          <span className="prototype-eyebrow">Editor lab</span>
          <h1>MDXEditor + Milkdown</h1>
          <p>This is an isolated MDXEditor prototype for testing a possible CodeMirror replacement.</p>
        </div>
        <div className="prototype-actions">
          <button type="button" onClick={() => setHideMuted((hidden) => !hidden)} aria-pressed={hideMuted}>
            {hideMuted ? 'Show muted content' : 'Hide muted content'}
          </button>
          <button type="button" onClick={() => setMdxMarkdown(SAMPLE_MARKDOWN)}>Reset sample</button>
        </div>
      </header>

      <p className="prototype-status">{mutedCount} muted block · the toolbar covers bold, italic, underline, lists, checklists, muting, and custom tags.</p>

      <section className="prototype-editor-stack" aria-label="Markdown editor prototypes">
        <article className="prototype-panel">
          <div className="prototype-panel-heading">
            <div><span className="prototype-eyebrow">Prototype</span><h2>MDXEditor</h2></div>
            <span>Markdown-native rich text</span>
          </div>
          <MdxEditorPrototype markdown={mdxMarkdown} onChange={setMdxMarkdown} hideMuted={hideMuted} />
        </article>
      </section>

      <aside className="prototype-notes">
        <strong>Prototype notes</strong>
        <span>Try the formatting, list, checklist, mute, and tag controls, then edit the Markdown directly to evaluate how well the document model fits the existing notes editor.</span>
      </aside>
    </main>
  )
}
