import { Fragment, useMemo, useState } from 'react'

export interface MoveLinesTarget {
  id: string
  label: string
  section?: string
}

interface MoveLinesDialogProps {
  lineCount: number
  targets: MoveLinesTarget[]
  onSelect: (id: string) => void
  onClose: () => void
}

// Command-palette-style target picker for the cross-editor line move
// (Cmd/Ctrl-M). Sections appear as non-interactive headers whenever the group
// changes; arrow keys navigate only the buttons.
export function MoveLinesDialog({ lineCount, targets, onSelect, onClose }: MoveLinesDialogProps) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const filtered = useMemo(() => {
    const needle = query.toLocaleLowerCase()
    return targets.filter((target) => target.label.toLocaleLowerCase().includes(needle))
  }, [query, targets])
  const selected = Math.min(index, Math.max(0, filtered.length - 1))

  return <div className="modal-backdrop command-palette-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
    <section className="command-palette move-lines-dialog" role="dialog" aria-modal="true" aria-label="Move lines to another editor">
      <input
        autoFocus
        value={query}
        onChange={(event) => { setQuery(event.target.value); setIndex(0) }}
        placeholder={`Move ${lineCount} ${lineCount === 1 ? 'line' : 'lines'} to…`}
        aria-label="Move lines to"
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); onClose() }
          if (event.key === 'ArrowDown') { event.preventDefault(); setIndex(Math.min(selected + 1, filtered.length - 1)) }
          if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(Math.max(selected - 1, 0)) }
          if (event.key === 'Enter' && filtered[selected]) { event.preventDefault(); onSelect(filtered[selected].id) }
        }} />
      {filtered.map((target, itemIndex) => <Fragment key={target.id}>
        {target.section && (itemIndex === 0 || filtered[itemIndex - 1].section !== target.section) && <span className="move-lines-section">{target.section}</span>}
        <button className={itemIndex === selected ? 'command-selected' : ''} type="button" onClick={() => onSelect(target.id)}>{target.label}</button>
      </Fragment>)}
      {filtered.length === 0 && <span className="move-lines-empty">No matching editors.</span>}
    </section>
  </div>
}
