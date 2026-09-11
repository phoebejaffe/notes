import { useState } from 'react'
import { BoldItalicUnderlineToggles, ListsToggle, UndoRedo } from '@mdxeditor/editor'
import { useEditorActions } from './editorActions'

function MuteIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M22 10.5V12C22 16.714 22 19.071 20.536 20.536C19.071 22 16.714 22 12 22C7.286 22 4.929 22 3.464 20.536C2 19.071 2 4.929 3.464 3.464C4.929 3.464 7.286 2 12 2H13.5" /><path d="M22 2L17 7M17 2L22 7" /></svg>
}

function AddTagControl() {
  const [tag, setTag] = useState('therapy')
  const { addTag } = useEditorActions()

  return <span className="notes-editor-tag-control"><input value={tag} onChange={(event) => setTag(event.target.value)} aria-label="Tag name" placeholder="Tag name" /><button className="notes-editor-toolbar-button" type="button" onClick={() => addTag(tag)}>+ Tag</button></span>
}

export function MdxEditorToolbar() {
  const { toggleMute, showUndoRedo } = useEditorActions()
  return <>
    {showUndoRedo && <UndoRedo />}
    <BoldItalicUnderlineToggles />
    <ListsToggle options={['bullet', 'number', 'check']} />
    <button className="notes-editor-toolbar-button notes-editor-mute-button" type="button" aria-label="Mute selected lines" title="Mute selected lines" onClick={toggleMute}><MuteIcon /></button>
    <AddTagControl />
  </>
}
