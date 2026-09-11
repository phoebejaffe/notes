import { useState } from 'react'
import { BoldItalicUnderlineToggles, ListsToggle, UndoRedo } from '@mdxeditor/editor'
import { useEditorActions } from './editorActions'

function MuteIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M22 10.5V12C22 16.714 22 19.071 20.536 20.536C19.071 22 16.714 22 12 22C7.286 22 4.929 22 3.464 20.536C2 19.071 2 4.929 3.464 3.464C4.929 3.464 7.286 2 12 2H13.5" /><path d="M22 2L17 7M17 2L22 7" /></svg>
}

function AddTagControl() {
  const [tag, setTag] = useState('')
  const [open, setOpen] = useState(false)
  const { addTag, recentTags } = useEditorActions()

  function submit(value = tag) {
    const normalized = value.trim()
    if (!normalized) return
    addTag(normalized)
    setTag('')
    setOpen(false)
  }

  return <span className="notes-editor-tag-control">
    <span className="notes-editor-tag-input-wrap">
      <input value={tag} onChange={(event) => { setTag(event.target.value); setOpen(true) }} onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 120)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit() } }} aria-label="Tag name" placeholder="Add tag" />
      {open && recentTags.length > 0 && <span className="notes-editor-tag-suggestions" role="listbox">{recentTags.filter((recent) => !tag || recent.toLocaleLowerCase().includes(tag.toLocaleLowerCase())).map((recent) => <button type="button" key={recent} onMouseDown={(event) => event.preventDefault()} onClick={() => submit(recent)}>{recent}</button>)}</span>}
    </span>
    <button className="notes-editor-toolbar-button" type="button" onClick={() => submit()}>+ Tag</button>
  </span>
}

export function MdxEditorToolbar() {
  const { activeTags, removeTag, toggleMute, showUndoRedo } = useEditorActions()
  return <>
    {showUndoRedo && <UndoRedo />}
    <BoldItalicUnderlineToggles />
    <ListsToggle options={['bullet', 'number', 'check']} />
    <button className="notes-editor-toolbar-button notes-editor-mute-button" type="button" aria-label="Mute selected lines" title="Mute selected lines" onClick={toggleMute}><MuteIcon /></button>
    {activeTags.length > 0 && <span className="notes-editor-active-tags" aria-label="Active tags">{activeTags.map((tag) => <span className="notes-editor-active-tag" key={tag}>{tag}<button type="button" aria-label={`Remove ${tag}`} onClick={() => removeTag(tag)}>×</button></span>)}</span>}
    <AddTagControl />
  </>
}
