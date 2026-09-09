export type EditorMode = 'normal' | 'raw'
export type FontChoice = 'system' | 'serif' | 'monospace'
export type Theme = 'light' | 'dark'
export type DateFormat = 'long' | 'long-short' | 'weekday-month' | 'short' | 'month-day' | 'iso' | 'numeric'
export type BackupFrequency = 'off' | 'daily' | 'weekly'
export type BackupRetention = 'off' | 'week' | 'month' | 'three-months'
export type ToolbarControl = 'bold' | 'italic' | 'strikethrough' | 'mute' | 'bullet' | 'number' | 'task' | 'indent' | 'unindent' | 'tag'

export const TOOLBAR_CONTROLS: Array<{ key: ToolbarControl; label: string }> = [
  { key: 'bold', label: 'Bold' }, { key: 'italic', label: 'Italic' }, { key: 'strikethrough', label: 'Strikethrough' },
  { key: 'mute', label: 'Mute' }, { key: 'bullet', label: 'Bulleted list' }, { key: 'number', label: 'Numbered list' },
  { key: 'task', label: 'Task list' }, { key: 'indent', label: 'Indent' }, { key: 'unindent', label: 'Unindent' }, { key: 'tag', label: 'Add tag' },
]

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
  backupRetention: BackupRetention
  backupRetentionVersion: number
  toolbarControls: Record<ToolbarControl, boolean>
  onboardingDismissed: boolean
  syncPromptDismissed: boolean
  notificationsEnabled: boolean
  captureShortcut: string
  captureAlwaysOnTop: boolean
  windowOpacity: number
  windowOpacityEnabled: boolean
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
  backupRetention: 'month',
  backupRetentionVersion: 1,
  toolbarControls: Object.fromEntries(TOOLBAR_CONTROLS.map(({ key }) => [key, true])) as Record<ToolbarControl, boolean>,
  onboardingDismissed: false,
  syncPromptDismissed: false,
  notificationsEnabled: true,
  captureShortcut: 'Ctrl+Alt+N',
  captureAlwaysOnTop: true,
  windowOpacity: 85,
  windowOpacityEnabled: false,
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

function clampWindowOpacity(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return defaultPreferences.windowOpacity
  return Math.min(100, Math.max(50, Math.round(value / 5) * 5))
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
    const parsedToolbar = isRecord(parsed.toolbarControls) ? parsed.toolbarControls : undefined
    const toolbarValues = Object.fromEntries(TOOLBAR_CONTROLS.map(({ key }) => [key, parsedToolbar?.[key] !== false])) as Record<ToolbarControl, boolean>
    const legacyToolbarWasDisabled = parsedToolbar && TOOLBAR_CONTROLS.every(({ key }) => parsedToolbar[key] === false)
    const toolbarControls = legacyToolbarWasDisabled ? defaultPreferences.toolbarControls : toolbarValues
    return {
      editorMode: parsed.editorMode === 'raw' ? 'raw' : defaultPreferences.editorMode,
      zoomLevel: clampZoom(parsed.zoomLevel),
      fontChoice: parsed.fontChoice === 'serif' || parsed.fontChoice === 'monospace' ? parsed.fontChoice : defaultPreferences.fontChoice,
      rolloverHour: clampRolloverHour(parsed.rolloverHour),
      showEmptyDays: parsed.showEmptyDays !== false,
      dateFormat: ['long', 'long-short', 'weekday-month', 'short', 'month-day', 'iso', 'numeric'].includes(parsed.dateFormat as string) ? parsed.dateFormat as DateFormat : defaultPreferences.dateFormat,
      theme: parsed.theme === 'dark' ? 'dark' : defaultPreferences.theme,
      compactSpacing: parsed.compactSpacing === true,
      backupFrequency: parsed.backupFrequency === 'daily' || parsed.backupFrequency === 'weekly' ? parsed.backupFrequency : parsed.backupFrequency === 'hourly' ? 'daily' : defaultPreferences.backupFrequency,
      backupFolder: typeof parsed.backupFolder === 'string' ? parsed.backupFolder : defaultPreferences.backupFolder,
      backupRetention: parsed.backupRetentionVersion === 1 && ['off', 'week', 'month', 'three-months'].includes(parsed.backupRetention as string) ? parsed.backupRetention as BackupRetention : defaultPreferences.backupRetention,
      backupRetentionVersion: 1,
      toolbarControls,
      onboardingDismissed: parsed.onboardingDismissed === true,
      syncPromptDismissed: parsed.syncPromptDismissed === true,
      notificationsEnabled: parsed.notificationsEnabled !== false,
      captureShortcut: typeof parsed.captureShortcut === 'string' && parsed.captureShortcut.trim() ? parsed.captureShortcut : defaultPreferences.captureShortcut,
      captureAlwaysOnTop: parsed.captureAlwaysOnTop !== false,
      windowOpacity: clampWindowOpacity(parsed.windowOpacity),
      windowOpacityEnabled: parsed.windowOpacityEnabled === true,
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
