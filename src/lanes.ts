import type { NamedDocument } from './storage'

// Lane config gives lanes a persistent identity beyond the notes inside them.
// Visible lanes are the union of config-covered indices (1..lanes.length) and
// lanes referenced by live notes — so empty and disabled lanes persist, and
// remote notes always land somewhere. Config index i corresponds to
// note.lane = i + 1; indices beyond the config are implicitly enabled.
export interface LaneConfig {
  disabled?: boolean
}

export interface LaneConfigState {
  lanes: LaneConfig[]
  updatedAt: number
}

const storageKey = 'notes-lane-config'

export function loadLaneConfig(): LaneConfigState {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return { lanes: [], updatedAt: 0 }
    const parsed = JSON.parse(raw) as Partial<LaneConfigState>
    const lanes = Array.isArray(parsed.lanes) ? parsed.lanes.map((entry) => ({ disabled: (entry as LaneConfig | undefined)?.disabled === true ? true : undefined })) : []
    return { lanes, updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0 }
  } catch {
    return { lanes: [], updatedAt: 0 }
  }
}

export function saveLaneConfig(state: LaneConfigState) {
  try { localStorage.setItem(storageKey, JSON.stringify(state)) } catch { /* storage unavailable */ }
}

// All lane indices (1-based like note.lane), sorted — includes disabled lanes.
export function laneIndices(notes: NamedDocument[], config: LaneConfigState) {
  const indices = new Set<number>()
  notes.forEach((note) => { if (!note.deleted) indices.add(Math.max(1, note.lane || 1)) })
  for (let index = 1; index <= config.lanes.length; index += 1) indices.add(index)
  return [...indices].sort((a, b) => a - b)
}

// Lane indices visible in the track.
export function enabledLanes(notes: NamedDocument[], config: LaneConfigState) {
  return laneIndices(notes, config).filter((lane) => !config.lanes[lane - 1]?.disabled)
}

export function laneDisabled(lane: number, config: LaneConfigState) {
  return config.lanes[lane - 1]?.disabled === true
}

// Compact the union of config-covered and note-referenced lane indices to a
// contiguous 1..N before structural ops, remapping notes and config entries
// together so empty lanes keep their position. Tombstones keep their lane —
// they are never rendered.
export function compactLanes(notes: NamedDocument[], config: LaneConfigState) {
  const union = laneIndices(notes, config)
  const renumber = new Map(union.map((lane, index) => [lane, index + 1]))
  const lanes: LaneConfig[] = []
  union.forEach((lane, index) => { lanes[index] = config.lanes[lane - 1] ?? {} })
  return {
    notes: notes.map((note) => note.deleted ? note : { ...note, lane: renumber.get(Math.max(1, note.lane || 1)) ?? 1 }),
    lanes,
    count: union.length,
  }
}
