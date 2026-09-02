export type EditorMode = 'normal' | 'raw'
export type FontChoice = 'system' | 'serif' | 'monospace'
export type Theme = 'light' | 'dark'
export type DateFormat = 'long' | 'long-short' | 'weekday-month' | 'short' | 'month-day' | 'iso' | 'numeric'

export interface Preferences {
  editorMode: EditorMode
  zoomLevel: number
  fontChoice: FontChoice
  rolloverHour: number
  showEmptyDays: boolean
  dateFormat: DateFormat
  theme: Theme
  compactSpacing: boolean
}

export const defaultPreferences: Preferences = {
  editorMode: 'normal',
  zoomLevel: 100,
  fontChoice: 'system',
  rolloverHour: 4,
  showEmptyDays: false,
  dateFormat: 'long',
  theme: 'light',
  compactSpacing: false,
}

const storageKey = 'notes-preferences'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function clampZoom(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return defaultPreferences.zoomLevel
  return Math.min(150, Math.max(60, Math.round(value / 10) * 10))
}

function clampRolloverHour(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return defaultPreferences.rolloverHour
  return Math.min(5, Math.max(0, value))
}

export function loadPreferences(): Preferences {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
    if (!isRecord(parsed)) return defaultPreferences
    return {
      editorMode: parsed.editorMode === 'raw' ? 'raw' : defaultPreferences.editorMode,
      zoomLevel: clampZoom(parsed.zoomLevel),
      fontChoice: parsed.fontChoice === 'serif' || parsed.fontChoice === 'monospace' ? parsed.fontChoice : defaultPreferences.fontChoice,
      rolloverHour: clampRolloverHour(parsed.rolloverHour),
      showEmptyDays: parsed.showEmptyDays === true,
      dateFormat: ['long', 'long-short', 'weekday-month', 'short', 'month-day', 'iso', 'numeric'].includes(parsed.dateFormat as string) ? parsed.dateFormat as DateFormat : defaultPreferences.dateFormat,
      theme: parsed.theme === 'dark' ? 'dark' : defaultPreferences.theme,
      compactSpacing: parsed.compactSpacing === true,
    }
  } catch {
    return defaultPreferences
  }
}

export function savePreferences(preferences: Preferences) {
  localStorage.setItem(storageKey, JSON.stringify(preferences))
}
