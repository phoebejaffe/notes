export type EditorMode = 'normal' | 'raw'
export type FontChoice = 'system' | 'serif' | 'monospace'
export type Theme = 'light' | 'dark'
export type DateFormat = 'long' | 'long-short' | 'weekday-month' | 'short' | 'month-day' | 'iso' | 'numeric'
export type BackupFrequency = 'off' | 'hourly' | 'daily' | 'weekly'

export interface Preferences {
  editorMode: EditorMode
  zoomLevel: number
  fontChoice: FontChoice
  rolloverHour: number
  showEmptyDays: boolean
  dateFormat: DateFormat
  theme: Theme
  compactSpacing: boolean
  backupFrequency: BackupFrequency
  backupFolder: string
  captureShortcut: string
  captureAlwaysOnTop: boolean
  launchAtLogin: boolean
  showMenuBar: boolean
  showDockIcon: boolean
  shortcuts: Record<string, string>
  hideTagSyntax: boolean
}

export const defaultPreferences: Preferences = {
  editorMode: 'normal',
  zoomLevel: 100,
  fontChoice: 'system',
  rolloverHour: 4,
  showEmptyDays: true,
  dateFormat: 'long',
  theme: 'light',
  compactSpacing: false,
  backupFrequency: 'off',
  backupFolder: '',
  captureShortcut: 'Ctrl+Alt+N',
  captureAlwaysOnTop: true,
  launchAtLogin: false,
  showMenuBar: true,
  showDockIcon: false,
  shortcuts: {
    search: 'Mod-f',
    rawEditor: 'Mod-e',
    zoomIn: 'Mod-=',
    zoomOut: 'Mod--',
    jumpToToday: 'Mod-j',
    exportToday: 'Mod-s',
    tagSelection: 'Mod-t',
    strikethrough: 'Mod-Shift-x',
    taskToggle: 'Mod-Enter',
    toggleMuted: 'Mod-Alt-/',
    help: 'Mod-Shift-?',
    settings: 'Mod-,',
    dayPrevious: 'Mod-Alt-ArrowUp',
    dayNext: 'Mod-Alt-ArrowDown',
  },
  hideTagSyntax: true,
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
    const parsedShortcuts = isRecord(parsed.shortcuts) ? parsed.shortcuts : {}
    return {
      editorMode: parsed.editorMode === 'raw' ? 'raw' : defaultPreferences.editorMode,
      zoomLevel: clampZoom(parsed.zoomLevel),
      fontChoice: parsed.fontChoice === 'serif' || parsed.fontChoice === 'monospace' ? parsed.fontChoice : defaultPreferences.fontChoice,
      rolloverHour: clampRolloverHour(parsed.rolloverHour),
      showEmptyDays: parsed.showEmptyDays !== false,
      dateFormat: ['long', 'long-short', 'weekday-month', 'short', 'month-day', 'iso', 'numeric'].includes(parsed.dateFormat as string) ? parsed.dateFormat as DateFormat : defaultPreferences.dateFormat,
      theme: parsed.theme === 'dark' ? 'dark' : defaultPreferences.theme,
      compactSpacing: parsed.compactSpacing === true,
      backupFrequency: ['off', 'hourly', 'daily', 'weekly'].includes(parsed.backupFrequency as string) ? parsed.backupFrequency as BackupFrequency : defaultPreferences.backupFrequency,
      backupFolder: typeof parsed.backupFolder === 'string' ? parsed.backupFolder : defaultPreferences.backupFolder,
      captureShortcut: typeof parsed.captureShortcut === 'string' && parsed.captureShortcut.trim() ? parsed.captureShortcut : defaultPreferences.captureShortcut,
      captureAlwaysOnTop: parsed.captureAlwaysOnTop !== false,
      launchAtLogin: parsed.launchAtLogin === true,
      showMenuBar: parsed.showMenuBar !== false || parsed.showDockIcon !== true,
      showDockIcon: parsed.showDockIcon === true,
      shortcuts: Object.fromEntries(Object.entries(defaultPreferences.shortcuts).map(([key, value]) => [key, typeof parsedShortcuts[key] === 'string' && parsedShortcuts[key].trim() ? parsedShortcuts[key] : value])),
      hideTagSyntax: parsed.hideTagSyntax !== false,
    }
  } catch {
    return defaultPreferences
  }
}

export function savePreferences(preferences: Preferences) {
  localStorage.setItem(storageKey, JSON.stringify(preferences))
}
