import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { listen } from '@tauri-apps/api/event'
import { open as openDirectoryDialog } from '@tauri-apps/plugin-dialog'
import { MdxNotesEditor } from './editor/MdxNotesEditor'
import { MoveLinesDialog, type MoveLinesTarget } from './editor/MoveLinesDialog'
import { ensureCaretVisible } from './editor/caretVisibility'
import type { SelectionLineRange } from './editor/sourceMapping'
import { extractLinesForMove, parseMarkdown, renameTagEverywhere, sourceMatchesFilter } from './markerEngine'
import { applyFindHighlights, clearFindHighlights, collectFindMatches, type FindMatch } from './editor/findMatches'
import { formatLogicalDay, logicalDayKey, shiftLogicalDay } from './logicalDay'
import { clearNamedSyncBases, clearSyncBases, deleteNamedDocument, listDailyDocuments, listNamedDocuments, replaceDailyDocuments, saveDailyDocument, saveNamedDocument, type DailyDocument, type DocumentSyncBase, type NamedDocument } from './storage'
import { loadPreferences, savePreferences, type Preferences } from './preferences'
import { matchesShortcut } from './shortcuts'
import { NAMED_DOCS_CHANNEL } from './todoNotes'
import { backupFolderName, backupRetentionCutoff, backupSignature, cleanupBrowserBackups, pickBackupDirectory, readBackupDirectory, writeBackup, type ImportedBackupDocument } from './backup'
import { diffLines } from './editorCommands'
import { firebaseConfigured, signInWithGoogle, signOutOfGoogle, watchAuth } from './firebase'
import { createRemoteKeyBundle, deleteRemoteUserData, isStaleRemoteDocument, loadRemoteKeyBundle, recoverRemoteDataKey, syncDocuments, syncNamedDocuments, uploadEncryptedDocument, uploadEncryptedNamedDocument, watchRemoteDocuments, watchRemoteNamedDocuments, type SyncConflict } from './firebaseSync'
import { NoteCard, type NoteMoveTarget } from './NoteCard'
import { mergeMarkdown } from './markdownMerge'
import { disablePush, enablePush, pushStatus, type PushStatus } from './pushNotifications'
import { createRecoveryPhrase, normalizeRecoveryPhrase } from './crypto'
import type { User } from 'firebase/auth'
import { MarkdownPrototypePage } from './prototype/MarkdownPrototypePage'
import { TodoWindow } from './TodoWindow'
import './App.css'

const SAMPLE = `:::tag{name="therapy 🧠"}
## Therapy session

I noticed I am more comfortable setting boundaries.

- Practice **bold**, *italic*, and <u>underlined</u> text.
:::
:::tag{name="spring launch"}
## Project notes

Draft the onboarding flow and ask Sam for feedback.
:::
:::tag{name="therapy"}
A follow-up thought from later in the day.
:::`

const DEFAULT_TAG_COLORS = ['#6d9b91', '#8975aa', '#c88968', '#7190b0', '#b28a55']
const SHORTCUT_LABELS = {
  search: 'Search',
  settings: 'Settings',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  jumpToToday: 'Jump to today',
  exportToday: 'Export today',
  strikethrough: 'Strikethrough',
  taskToggle: 'Task to plain text',
  toggleMuted: 'Hide muted lines',
  help: 'Show keyboard shortcuts',
  dayPrevious: 'Previous day',
  dayNext: 'Next day',
  lanePrevious: 'Previous lane',
  laneNext: 'Next lane',
  todayTop: 'Today, top of note',
  noteCollapse: 'Collapse or expand note',
} as const
const BUILTIN_SHORTCUTS = [
  ['Mod-b', 'Bold'],
  ['Mod-i', 'Italic'],
  ['Mod-u', 'Underline'],
  ['Mod-t', 'Focus tag input'],
  ['Mod-Enter', 'Toggle task state'],
  ['Mod-Shift-Enter', 'Remove checkbox'],
  ['Alt-ArrowUp', 'Move lines up'],
  ['Alt-ArrowDown', 'Move lines down'],
  ['Mod-m', 'Move lines to another editor'],
  ['Mod-Alt-ArrowUp', 'Jump to editor above'],
  ['Mod-Alt-ArrowDown', 'Jump to editor below'],
  ['Mod-ArrowUp', 'Caret to editor top'],
  ['Mod-ArrowDown', 'Caret to editor bottom'],
  ['Mod-g', 'Next find match'],
  ['Mod-Shift-g', 'Previous find match'],
  ['Ctrl-1–9', 'Jump to lane 1–9'],
  ['Backspace', 'Delete one character'],
] as const

function defaultTagColor(tag: string) {
  const hash = [...tag].reduce((sum, character) => sum + character.codePointAt(0)!, 0) % DEFAULT_TAG_COLORS.length
  return DEFAULT_TAG_COLORS[hash]
}

function currentTimestamp() {
  return Date.now()
}

function isMobileKeyboardDevice() {
  return /Android|iPad|iPhone|iPod|Mobile/u.test(navigator.userAgent) || (navigator.maxTouchPoints > 0 && /Macintosh/u.test(navigator.userAgent))
}

function isIosPwa() {
  return /iPad|iPhone|iPod/u.test(navigator.userAgent) && ((window.navigator as Navigator & { standalone?: boolean }).standalone === true || window.matchMedia('(display-mode: standalone)').matches)
}

function recoveryPhraseStorageKey(uid: string) {
  return `notes-recovery-phrase:${uid}`
}

function loadStoredRecoveryPhrase(uid: string) {
  try {
    return localStorage.getItem(recoveryPhraseStorageKey(uid)) ?? ''
  } catch {
    return ''
  }
}

function storeRecoveryPhrase(uid: string, phrase: string) {
  localStorage.setItem(recoveryPhraseStorageKey(uid), phrase)
}

function loadFutureDays() {
  try { return JSON.parse(localStorage.getItem('notes-future-days') ?? '[]') as string[] } catch { return [] }
}

function storeFutureDay(day: string) {
  const days = new Set(loadFutureDays())
  days.add(day)
  localStorage.setItem('notes-future-days', JSON.stringify([...days]))
}

function futureNoticeText(day: string, dateFormat: Preferences['dateFormat']) {
  return `Future note opened for ${formatLogicalDay(day, dateFormat)}. You can snooze this reminder.`
}

function loadTagColors() {
  try {
    return JSON.parse(localStorage.getItem('notes-tag-colors') ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

function loadLastBackupSignature() {
  try { return localStorage.getItem('notes-last-backup-signature') ?? '' } catch { return '' }
}

function formatDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// Lane numbers are contiguous starting at 1 (lane 0 is the daily stream) and
// `order` is the note's index within its lane. Every structural mutation runs
// the result through this so the invariant survives moves and deletions.
function normalizeLanes(notes: NamedDocument[]) {
  // Tombstones don't hold a lane open — only live notes renumber lanes.
  const renumber = new Map([...new Set(notes.filter((note) => !note.deleted).map((note) => Math.max(1, note.lane || 1)))].sort((a, b) => a - b).map((lane, index) => [lane, index + 1]))
  const byLane = new Map<number, NamedDocument[]>()
  notes.forEach((note) => {
    const lane = renumber.get(Math.max(1, note.lane || 1)) ?? 1
    const list = byLane.get(lane) ?? []
    list.push(note)
    byLane.set(lane, list)
  })
  return [...byLane.entries()].flatMap(([lane, laneNotes]) =>
    laneNotes.sort((a, b) => a.order - b.order).map((note, order) => note.lane === lane && note.order === order ? note : { ...note, lane, order }))
}

function namedMeta(note: NamedDocument) {
  return { title: note.title, lane: note.lane, order: note.order, collapsed: note.collapsed, deleted: note.deleted }
}

function namedMetaSynced(note: NamedDocument) {
  const meta = note.syncedMeta
  return !!meta && meta.title === note.title && meta.lane === note.lane && meta.order === note.order && meta.collapsed === note.collapsed && meta.deleted === note.deleted
}

function sameNamedMeta(a: NamedDocument, b: NamedDocument) {
  return a.title === b.title && a.lane === b.lane && a.order === b.order && a.collapsed === b.collapsed && a.deleted === b.deleted
}

function namedAsDailyShape(note: NamedDocument): DailyDocument {
  return { day: note.id, markdown: note.markdown, updatedAt: note.updatedAt, syncBase: note.syncBase, writeId: note.writeId }
}

function FilterIcon({ active }: { active: boolean }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} aria-hidden="true"><path d="M3 4.6C3 4.03995 3 3.75992 3.10899 3.54601C3.20487 3.35785 3.35785 3.20487 3.54601 3.10899C3.75992 3 4.03995 3 4.6 3H19.4C19.9601 3 20.2401 3 20.454 3.10899C20.6422 3.20487 20.7951 3.35785 20.891 3.54601C21 3.75992 21 4.03995 21 4.6V6.33726C21 6.58185 21 6.70414 20.9724 6.81923C20.9479 6.92127 20.9075 7.01881 20.8526 7.10828C20.7908 7.2092 20.7043 7.29568 20.5314 7.46863L14.4686 13.5314C14.2957 13.7043 14.2092 13.7908 14.1474 13.8917C14.0925 13.9812 14.0521 14.0787 14.0276 14.1808C14 14.2959 14 14.4182 14 14.6627V17L10 21V14.6627C10 14.4182 10 14.2959 9.97237 14.1808C9.94787 14.0787 9.90747 13.9812 9.85264 13.8917C9.7908 13.7908 9.70432 13.7043 9.53137 13.5314L3.46863 7.46863C3.29568 7.29568 3.2092 7.2092 3.14736 7.10828C3.09253 7.01881 3.05213 6.92127 3.02763 6.81923C3 6.70414 3 6.58185 3 6.33726V4.6Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

export function MuteIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M22 10.5V12C22 16.714 22 19.071 20.536 20.536C19.071 22 16.714 22 12 22C7.286 22 4.929 22 3.464 20.536C2 19.071 2 16.714 2 12C2 7.286 2 4.929 3.464 3.464C4.929 2 7.286 2 12 2H13.5" /><path d="M22 2L17 7M17 2L22 7" /></svg>
}

function OfflineIndicator() {
  return <button className="offline-indicator" type="button" aria-label="Offline. Show sync warning" title="Offline" aria-describedby="offline-sync-tooltip"><span aria-hidden="true">Offline</span><span className="offline-tooltip" id="offline-sync-tooltip">Changes will still be synced, but if another device changes your notes before this device reconnects, those changes could be lost.</span></button>
}

function downloadMarkdown(markdown: string, filename: string) {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function isTauriEnvironment() {
  return '__TAURI_INTERNALS__' in window
}

async function invokeNative(command: string, args?: Record<string, unknown>) {
  if (!isTauriEnvironment()) return
  await invoke(command, args)
}

async function notifyMac(enabled: boolean, title: string, body: string) {
  if (!isTauriEnvironment() || !enabled) return
  try {
    let allowed = await isPermissionGranted()
    if (!allowed) allowed = await requestPermission() === 'granted'
    if (allowed) sendNotification({ title, body })
  } catch {
    return
  }
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

type LaneEditorLocator = { kind: 'day' | 'note'; id: string }
type LaneSelectionMemory = { editor: LaneEditorLocator; selection: SelectionLineRange }

function formatShortcut(shortcut: string) {
  return shortcut.replaceAll('Mod-', '⌘').replaceAll('Ctrl-', '⌃').replaceAll('Alt-', '⌥').replaceAll('Option-', '⌥').replaceAll('Shift-', '⇧').replace('ArrowUp', '↑').replace('ArrowDown', '↓').replace('ArrowLeft', '←').replace('ArrowRight', '→').replace('Escape', 'Esc')
}

function parseDisplayedShortcut(shortcut: string) {
  return shortcut.replaceAll('⌘', 'Mod-').replaceAll('⌃', 'Ctrl-').replaceAll('⌥', 'Alt-').replaceAll('⇧', 'Shift-').replace('↑', 'ArrowUp').replace('↓', 'ArrowDown').replace('←', 'ArrowLeft').replace('→', 'ArrowRight').replace('Esc', 'Escape').replaceAll(' ', '')
}

function NotesApp() {
  const [preferences, setPreferences] = useState<Preferences>(loadPreferences)
  const [currentDate, setCurrentDate] = useState(() => new Date())
  const today = useMemo(() => logicalDayKey(currentDate, preferences.rolloverHour), [currentDate, preferences.rolloverHour])
  const [days, setDays] = useState(() => [today, shiftLogicalDay(today, -1)])
  const [documents, setDocuments] = useState<Record<string, string>>({})
  const [loaded, setLoaded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pushState, setPushState] = useState<PushStatus>('disabled')
  const [pushBusy, setPushBusy] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(() => !loadPreferences().onboardingDismissed)
  const [commandQuery, setCommandQuery] = useState('')
  const [commandIndex, setCommandIndex] = useState(0)
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent>()
  const [appInstalled, setAppInstalled] = useState(() => window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true)
  const [isOnline, setIsOnline] = useState(() => navigator.onLine)
  const [futureNotice, setFutureNotice] = useState<string>()
  const [futureNoticeDay, setFutureNoticeDay] = useState<string>()
  const [futureDateInput, setFutureDateInput] = useState('')
  const [importPreview, setImportPreview] = useState<{ documents: ImportedBackupDocument[]; invalid: string[] }>()
  const [importMode, setImportMode] = useState<'additive' | 'replace'>('additive')
  const [importChoices, setImportChoices] = useState<Record<string, 'local' | 'imported' | 'append'>>({})
  const [conflictDrafts, setConflictDrafts] = useState<Record<string, string>>({})
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false)
  const [tagsOpen, setTagsOpen] = useState(false)
  const [tagToRename, setTagToRename] = useState('')
  const [renamedTag, setRenamedTag] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterTags, setFilterTags] = useState<string[]>([])
  const [hideMutedLines, setHideMutedLines] = useState(false)
  const [tagColors, setTagColors] = useState<Record<string, string>>(loadTagColors)
  const [query, setQuery] = useState('')
  const [findIndex, setFindIndexState] = useState(-1)
  const [findMatchCount, setFindMatchCount] = useState(0)
  const findMatchesRef = useRef<FindMatch[]>([])
  const findIndexRef = useRef(-1)
  const pendingFindExpandRef = useRef<string | null>(null)
  const findActiveRef = useRef(false)
  const prevFindQueryRef = useRef('')
  const [saveState, setSaveState] = useState<'saved' | 'saving'>('saved')
  const [backupState, setBackupState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [lastBackupAt, setLastBackupAt] = useState<number>()
  const backupDirectoryRef = useRef<FileSystemDirectoryHandle | null>(null)
  const backupAccessRootRef = useRef('')
  const lastBackupSignatureRef = useRef(loadLastBackupSignature())
  const captureMode = useMemo(() => new URLSearchParams(window.location.search).get('mode') === 'capture', [])
  const [captureFocused, setCaptureFocused] = useState(() => document.hasFocus())
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null)
  const [authLoading, setAuthLoading] = useState(firebaseConfigured)
  const [recoveryPhrase, setRecoveryPhrase] = useState('')
  const [dataKey, setDataKey] = useState<CryptoKey>()
  const [syncState, setSyncState] = useState<'idle' | 'working' | 'ready' | 'error'>('idle')
  const [syncMessage, setSyncMessage] = useState('')
  const [deleteCloudDataOpen, setDeleteCloudDataOpen] = useState(false)
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [syncConflicts, setSyncConflicts] = useState<SyncConflict[]>([])
  const [moveRequest, setMoveRequest] = useState<{ source: { kind: 'day'; day: string } | { kind: 'note'; id: string }; startLine: number; endLine: number; host: HTMLElement } | null>(null)
  const documentUpdatedAtRef = useRef<Record<string, number>>({})
  const documentsRef = useRef<Record<string, string>>({})
  const syncBasesRef = useRef<Record<string, DocumentSyncBase>>({})
  const latestRemoteRef = useRef<Record<string, DailyDocument>>({})
  const dirtyDaysRef = useRef(new Set<string>())
  const uploadingDaysRef = useRef(new Map<string, string>())
  const [namedDocs, setNamedDocs] = useState<Record<string, NamedDocument>>({})
  const namedDocsRef = useRef<Record<string, NamedDocument>>({})
  const latestRemoteNotesRef = useRef<Record<string, NamedDocument>>({})
  const dirtyNotesRef = useRef(new Set<string>())
  const uploadingNotesRef = useRef(new Map<string, string>())
  // Named-doc ids this window changed since the last debounced IDB flush.
  // Restricting the periodic save to these keeps stale untouched records from
  // overwriting fresher writes made by the todo window.
  const pendingNoteWritesRef = useRef(new Set<string>())
  const namedDocsChannelRef = useRef<BroadcastChannel | null>(null)
  const lastEditorHostRef = useRef<HTMLElement | null>(null)
  const ownWriteIdsRef = useRef(new Map<string, number>())
  const ownWriteSeqRef = useRef(0)
  const handleRemoteDocumentsRef = useRef<(documents: DailyDocument[]) => void>(() => undefined)
  const handleRemoteNamedDocumentsRef = useRef<(documents: NamedDocument[]) => void>(() => undefined)
  const uploadPendingDocumentsRef = useRef<() => Promise<void>>(async () => undefined)
  const uploadPendingNotesRef = useRef<() => Promise<void>>(async () => undefined)
  const toggleNoteCollapsedRef = useRef<(id: string) => void>(() => undefined)
  const [activeLane, setActiveLane] = useState(0)
  const laneSelectionMemoryRef = useRef(new Map<number, LaneSelectionMemory>())
  const laneViewportRef = useRef<HTMLDivElement>(null)
  const laneScrollIdleRef = useRef(0)
  const laneSwipeAccumRef = useRef(0)
  const streamEndRef = useRef<HTMLDivElement>(null)
  const todayRef = useRef<HTMLElement>(null)
  const recoveryWarningNotifiedRef = useRef(false)

  useEffect(() => {
    if (!firebaseConfigured) return
    return watchAuth((user) => { setFirebaseUser(user); setAuthLoading(false) })
  }, [])

  useEffect(() => {
    const update = () => setIsOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])

  // iOS Safari ignores user-scalable=no in the viewport meta; its proprietary
  // gesture events are the only reliable pinch-zoom hook.
  useEffect(() => {
    const preventGesture = (event: Event) => event.preventDefault()
    document.addEventListener('gesturestart', preventGesture)
    document.addEventListener('gesturechange', preventGesture)
    document.addEventListener('gestureend', preventGesture)
    return () => {
      document.removeEventListener('gesturestart', preventGesture)
      document.removeEventListener('gesturechange', preventGesture)
      document.removeEventListener('gestureend', preventGesture)
    }
  }, [])

  useEffect(() => {
    const handleInstallPrompt = (event: Event) => { event.preventDefault(); setInstallPrompt(event as BeforeInstallPromptEvent) }
    const handleInstalled = () => { setAppInstalled(true); setInstallPrompt(undefined) }
    window.addEventListener('beforeinstallprompt', handleInstallPrompt)
    window.addEventListener('appinstalled', handleInstalled)
    return () => { window.removeEventListener('beforeinstallprompt', handleInstallPrompt); window.removeEventListener('appinstalled', handleInstalled) }
  }, [])

  useEffect(() => {
    if (!loaded || captureMode || onboardingOpen || settingsOpen || commandPaletteOpen || tagsOpen) return
    const timer = window.setTimeout(() => {
      const editor = document.querySelector(`[data-day="${today}"] .mdxeditor-root-contenteditable`) as HTMLElement | null
      editor?.focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [captureMode, commandPaletteOpen, loaded, onboardingOpen, settingsOpen, tagsOpen, today])

  useEffect(() => {
    if (!firebaseUser || !loaded || authLoading || dataKey || loadStoredRecoveryPhrase(firebaseUser.uid) || recoveryWarningNotifiedRef.current) return
    recoveryWarningNotifiedRef.current = true
    void notifyMac(preferences.notificationsEnabled, 'Noteses encrypted sync needs setup', 'Sign in to Noteses and configure your recovery phrase to unlock encrypted sync.')
  }, [authLoading, dataKey, firebaseUser, loaded, preferences.notificationsEnabled])

  // Editors bubble `notes-move-lines` (Cmd/Ctrl-M) up from their host; the
  // source card is identified by the enclosing day-card or note-card element.
  useEffect(() => {
    function handleMoveLinesRequest(event: Event) {
      const detail = (event as CustomEvent<{ startLine?: number; endLine?: number }>).detail
      const host = event.target instanceof HTMLElement ? event.target : null
      if (!host || detail?.startLine === undefined || detail?.endLine === undefined) return
      const day = host.closest<HTMLElement>('.day-card')?.dataset.day
      const noteId = host.closest<HTMLElement>('.note-card')?.dataset.noteId
      const source = day ? { kind: 'day' as const, day } : noteId ? { kind: 'note' as const, id: noteId } : null
      if (!source) return
      setMoveRequest({ source, startLine: detail.startLine, endLine: detail.endLine, host })
    }
    window.addEventListener('notes-move-lines', handleMoveLinesRequest)
    return () => window.removeEventListener('notes-move-lines', handleMoveLinesRequest)
  }, [])

  useEffect(() => {
    function rememberLaneSelection(event: Event) {
      const host = event.target instanceof HTMLElement ? event.target : null
      const selection = (event as CustomEvent<SelectionLineRange>).detail
      const lane = host?.closest<HTMLElement>('.lane')
      const laneIndex = Number(lane?.dataset.lane)
      const day = host?.closest<HTMLElement>('.day-card')?.dataset.day
      const noteId = host?.closest<HTMLElement>('.note-card')?.dataset.noteId
      const editor = day ? { kind: 'day' as const, id: day } : noteId ? { kind: 'note' as const, id: noteId } : null
      if (!host || !selection || !Number.isInteger(laneIndex) || !editor) return
      laneSelectionMemoryRef.current.set(laneIndex, { editor, selection })
    }
    window.addEventListener('notes-editor-selection', rememberLaneSelection)
    return () => window.removeEventListener('notes-editor-selection', rememberLaneSelection)
  }, [])

  useEffect(() => {
    function handlePaletteShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandPaletteOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', handlePaletteShortcut)
    return () => window.removeEventListener('keydown', handlePaletteShortcut)
  }, [])

  useEffect(() => {
    if (!isTauriEnvironment()) return
    let disposed = false
    let unlistenAlwaysOnTop: (() => void) | undefined
    let unlistenTransparency: (() => void) | undefined
    let unlistenOpacity: (() => void) | undefined
    void listen<boolean>('always-on-top-changed', (event) => {
      setPreferences((current) => ({ ...current, captureAlwaysOnTop: event.payload }))
    }).then((cleanup) => {
      if (disposed) cleanup()
      else unlistenAlwaysOnTop = cleanup
    })
    void listen('toggle-window-transparency', () => {
      setPreferences((current) => ({ ...current, windowOpacityEnabled: !current.windowOpacityEnabled }))
    }).then((cleanup) => {
      if (disposed) cleanup()
      else unlistenTransparency = cleanup
    })
    void listen<number>('set-window-opacity', (event) => {
      const windowOpacity = Math.round(event.payload * 100)
      setPreferences((current) => ({ ...current, windowOpacity, windowOpacityEnabled: windowOpacity < 100 }))
    }).then((cleanup) => {
      if (disposed) cleanup()
      else unlistenOpacity = cleanup
    })
    return () => {
      disposed = true
      unlistenAlwaysOnTop?.()
      unlistenTransparency?.()
      unlistenOpacity?.()
    }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentDate(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!loaded || !documents[today] || !loadFutureDays().includes(today)) return
    const noticeKey = `notes-future-notice:${today}`
    const snoozeUntil = Number(localStorage.getItem(`${noticeKey}:snooze`) ?? 0)
    if (snoozeUntil > Date.now()) {
      const timer = window.setTimeout(() => { localStorage.removeItem(`${noticeKey}:snooze`); setFutureNoticeDay(today); setFutureNotice(futureNoticeText(today, preferences.dateFormat)) }, snoozeUntil - Date.now())
      return () => window.clearTimeout(timer)
    }
    if (localStorage.getItem(noticeKey)) return
    localStorage.setItem(noticeKey, 'shown')
    queueMicrotask(() => { setFutureNoticeDay(today); setFutureNotice(futureNoticeText(today, preferences.dateFormat)) })
  }, [documents, loaded, preferences.dateFormat, today])

  useEffect(() => {
    if (!firebaseUser || !loaded || dataKey) return
    const storedPhrase = loadStoredRecoveryPhrase(firebaseUser.uid)
    if (!storedPhrase) return
    queueMicrotask(() => {
      setRecoveryPhrase(storedPhrase)
      setSyncState('working')
    })
    void recoverRemoteDataKey(firebaseUser.uid, storedPhrase).then((key) => {
      if (!key) {
        setSyncState('idle')
        return
      }
      setDataKey(key)
      setSyncState('ready')
      setSyncMessage('Encryption unlocked from this device.')
    }).catch(() => {
      setSyncState('idle')
      setSyncMessage('Enter your recovery phrase to unlock encrypted sync.')
    })
  }, [dataKey, firebaseUser, loaded])

  useEffect(() => {
    documentsRef.current = documents
  }, [documents])

  useEffect(() => {
    namedDocsRef.current = namedDocs
  }, [namedDocs])

  // The todo window shares this IndexedDB store; a BroadcastChannel ping (or
  // a window refocus) means stored named docs may be newer than the in-memory
  // copies. Adopt records written later than ours — skipping notes with
  // unsaved local edits — and recompute sync dirtiness so todo-window edits
  // get uploaded.
  const refreshNamedDocuments = useCallback(() => {
    void listNamedDocuments().then((stored) => {
      const current = namedDocsRef.current
      const next = { ...current }
      const storedIds = new Set(stored.map((note) => note.id))
      let changed = false
      for (const note of stored) {
        const local = current[note.id]
        if (pendingNoteWritesRef.current.has(note.id)) continue
        if (!local || note.updatedAt > local.updatedAt) {
          next[note.id] = note
          changed = true
          const dirty = note.syncBase ? note.markdown !== note.syncBase.markdown || !namedMetaSynced(note) : !note.deleted
          if (dirty) dirtyNotesRef.current.add(note.id)
        }
      }
      for (const id of Object.keys(next)) {
        if (!storedIds.has(id) && !pendingNoteWritesRef.current.has(id)) {
          delete next[id]
          changed = true
        }
      }
      if (changed) {
        namedDocsRef.current = next
        setNamedDocs(next)
      }
    }).catch(() => undefined)
  }, [])

  useEffect(() => {
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(NAMED_DOCS_CHANNEL)
    namedDocsChannelRef.current = channel
    if (channel) channel.onmessage = refreshNamedDocuments
    window.addEventListener('focus', refreshNamedDocuments)
    return () => {
      channel?.close()
      namedDocsChannelRef.current = null
      window.removeEventListener('focus', refreshNamedDocuments)
    }
  }, [refreshNamedDocuments])

  // main.tsx fires this when a new service worker takes control — the running
  // bundle is then stale (fingerprinted assets), so prompt for a reload.
  useEffect(() => {
    const onUpdated = () => setUpdateAvailable(true)
    window.addEventListener('notes-sw-updated', onUpdated)
    return () => window.removeEventListener('notes-sw-updated', onUpdated)
  }, [])

  // Lanes: track index 0 is the daily stream; named lanes occupy 1..laneCount
  // (note.lane maps directly to the track index); laneCount+1 is the ghost
  // "new lane" placeholder at the end.
  const sortedNotes = useMemo(() => Object.values(namedDocs).filter((note) => !note.deleted).sort((a, b) => a.lane - b.lane || a.order - b.order), [namedDocs])
  const laneCount = useMemo(() => sortedNotes.reduce((max, note) => Math.max(max, note.lane), 0), [sortedNotes])
  const lanes = useMemo(() => {
    const byLane = new Map<number, NamedDocument[]>()
    sortedNotes.forEach((note) => {
      const list = byLane.get(note.lane) ?? []
      list.push(note)
      byLane.set(note.lane, list)
    })
    return byLane
  }, [sortedNotes])
  const totalLanes = laneCount + 2

  // Find mode is active once a query exists — the panel alone doesn't change
  // the document view. Muted lines stay revealed while finding so matches
  // inside them are reachable.
  const findActive = searchOpen && query.trim().length >= 2
  const effectiveHideMuted = hideMutedLines && !findActive
  const collapsedFindNoteIds = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!searchOpen || needle.length < 2) return new Set<string>()
    return new Set(sortedNotes.filter((note) => note.collapsed && note.markdown.toLocaleLowerCase().includes(needle)).map((note) => note.id))
  }, [query, searchOpen, sortedNotes])

  useEffect(() => {
    findActiveRef.current = findActive
  }, [findActive])

  const restoreLaneSelection = useCallback((index: number) => {
    // While finding, lane switches must not steal focus from the search input
    // or overwrite the current-match position.
    if (findActiveRef.current) return
    const lane = laneViewportRef.current?.querySelector<HTMLElement>(`.lane[data-lane="${index}"]`)
    const editors = [...lane?.querySelectorAll<HTMLElement>('.notes-mdx-editor') ?? []]
    if (!editors.length) return
    // Browser auto-scroll can bring a lane into view to activate one of its controls.
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement && lane?.contains(activeElement) && !activeElement.closest('.mdxeditor-root-contenteditable') && activeElement.matches('button,input,textarea,select')) return
    const memory = laneSelectionMemoryRef.current.get(index)
    const rememberedEditor = memory && editors.find((host) => {
      const day = host.closest<HTMLElement>('.day-card')?.dataset.day
      const noteId = host.closest<HTMLElement>('.note-card')?.dataset.noteId
      return memory.editor.kind === 'day' ? day === memory.editor.id : noteId === memory.editor.id
    })
    const target = rememberedEditor ?? editors[0]
    if (rememberedEditor && memory) {
      target.dispatchEvent(new CustomEvent('notes-restore-selection', { detail: memory.selection, bubbles: false }))
    } else {
      target.dispatchEvent(new CustomEvent('notes-focus-edge', { detail: { edge: 'start' }, bubbles: false }))
    }
  }, [])

  const goToLane = useCallback((index: number) => {
    const viewport = laneViewportRef.current
    if (!viewport) return
    const clamped = Math.max(0, Math.min(totalLanes - 1, index))
    const target = clamped * viewport.clientWidth
    if (Math.abs(viewport.scrollLeft - target) < 2) {
      setActiveLane(clamped)
      restoreLaneSelection(clamped)
      return
    }
    // `mandatory` snap halts a smooth scroll at the first boundary it crosses,
    // so release it for the animation; the scroll-idle handler restores it.
    viewport.style.scrollSnapType = 'none'
    viewport.scrollTo({ left: target, behavior: 'smooth' })
    window.clearTimeout(laneScrollIdleRef.current)
    laneScrollIdleRef.current = window.setTimeout(() => {
      viewport.classList.remove('lane-scrolling')
      viewport.style.scrollSnapType = ''
    }, 160)
  }, [restoreLaneSelection, totalLanes])

  function handleLaneScroll() {
    const viewport = laneViewportRef.current
    if (!viewport) return
    // Hide fixed toolbars while the track is moving so a focused editor's bar
    // on a departing lane can't linger over the incoming lane.
    viewport.classList.add('lane-scrolling')
    const width = viewport.clientWidth || 1
    const laneIndex = Math.max(0, Math.min(totalLanes - 1, Math.round(viewport.scrollLeft / width)))
    window.clearTimeout(laneScrollIdleRef.current)
    laneScrollIdleRef.current = window.setTimeout(() => {
      viewport.classList.remove('lane-scrolling')
      viewport.style.scrollSnapType = ''
      restoreLaneSelection(laneIndex)
    }, 160)
    setActiveLane(laneIndex)
  }

  // Keep the track aligned to the active lane across resizes/zoom changes.
  // ResizeObserver fires once on observe — the effect re-runs on every lane
  // change, so skip that initial callback or the instant realign would cancel
  // a smooth scroll mid-flight at the first intermediate lane.
  useEffect(() => {
    const viewport = laneViewportRef.current
    if (!viewport) return
    let initial = true
    const observer = new ResizeObserver(() => {
      if (initial) {
        initial = false
        return
      }
      const target = activeLane * viewport.clientWidth
      if (Math.abs(viewport.scrollLeft - target) > 2) viewport.scrollTo({ left: target, behavior: 'instant' })
    })
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [activeLane])

  const setFindIndex = useCallback((index: number) => {
    findIndexRef.current = index
    setFindIndexState(index)
  }, [])

  // Centers the match in its stream's viewport. Cross-lane targets ride the
  // lane track's smooth scroll first — scrollIntoView is deferred until the
  // track settles so its horizontal side-effect can't fight the animation.
  const scrollFindMatchIntoView = useCallback((match: FindMatch) => {
    const start = match.range?.startContainer ?? null
    const element = match.range
      ? (start instanceof Element ? start : start?.parentElement)
      : match.card
    if (!element) return
    const viewport = laneViewportRef.current
    const lane = Number(element.closest<HTMLElement>('.lane')?.dataset.lane ?? 0)
    const target = lane * (viewport?.clientWidth ?? 0)
    const reveal = () => element.scrollIntoView({ block: 'center', inline: 'nearest' })
    if (!viewport || Math.abs(viewport.scrollLeft - target) < 2) {
      reveal()
      return
    }
    goToLane(lane)
    const deadline = performance.now() + 1200
    const poll = () => {
      if (Math.abs(viewport.scrollLeft - target) < 2) {
        reveal()
        return
      }
      if (performance.now() < deadline) requestAnimationFrame(poll)
    }
    requestAnimationFrame(poll)
  }, [goToLane])

  const goToFindMatch = useCallback((index: number) => {
    const matches = findMatchesRef.current
    const match = matches[index]
    if (!match) return
    // A placeholder for a collapsed note: expand it, then the recompute below
    // resolves the pending note into its first rendered match.
    if (match.kind === 'collapsed-note' && match.noteId) {
      pendingFindExpandRef.current = match.noteId
      toggleNoteCollapsedRef.current(match.noteId)
      return
    }
    setFindIndex(index)
    applyFindHighlights(matches, index)
    scrollFindMatchIntoView(match)
  }, [scrollFindMatchIntoView, setFindIndex])

  const advanceFind = useCallback((direction: 1 | -1) => {
    const count = findMatchesRef.current.length
    if (!count) return
    const current = findIndexRef.current
    goToFindMatch(current < 0 ? (direction > 0 ? 0 : count - 1) : (current + direction + count) % count)
  }, [goToFindMatch])

  // Recompute matches whenever the query or rendered documents change, and
  // re-run across frames so nested directive editors mounted after the pass
  // still contribute ranges.
  useEffect(() => {
    if (!findActive) {
      findMatchesRef.current = []
      pendingFindExpandRef.current = null
      findIndexRef.current = -1
      clearFindHighlights()
      queueMicrotask(() => {
        setFindIndexState(-1)
        setFindMatchCount(0)
      })
      return
    }
    let cancelled = false
    const recompute = (isLast: boolean) => {
      if (cancelled) return
      const viewport = laneViewportRef.current
      if (!viewport) return
      const matches = collectFindMatches(query, viewport, collapsedFindNoteIds)
      findMatchesRef.current = matches
      setFindMatchCount(matches.length)
      const pending = pendingFindExpandRef.current
      if (pending) {
        const idx = matches.findIndex((match) => match.kind === 'range' && match.card.dataset.noteId === pending)
        if (idx >= 0) {
          pendingFindExpandRef.current = null
          goToFindMatch(idx)
          return
        }
        if (isLast) pendingFindExpandRef.current = null
      }
      const index = findIndexRef.current >= 0
        ? Math.min(findIndexRef.current, matches.length - 1)
        : (matches.length ? 0 : -1)
      const fresh = findIndexRef.current < 0 && index >= 0
      setFindIndex(index)
      applyFindHighlights(matches, index)
      // A fresh activation (find opened, or a query went from no matches to
      // some) jumps to the first match like incremental browser find.
      if (fresh && matches.length) scrollFindMatchIntoView(matches[index])
    }
    recompute(false)
    const frame = requestAnimationFrame(() => {
      recompute(false)
      requestAnimationFrame(() => recompute(true))
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [findActive, query, documents, namedDocs, days, filterTags, collapsedFindNoteIds, goToFindMatch, scrollFindMatchIntoView, setFindIndex])

  // Typing a new query restarts at the first match — incremental find.
  useEffect(() => {
    if (prevFindQueryRef.current === query) return
    prevFindQueryRef.current = query
    if (!findActive || !findMatchesRef.current.length) return
    goToFindMatch(0)
  }, [findActive, query, goToFindMatch])

  // mac app: a horizontal trackpad swipe should step one lane even while the
  // window is unfocused — macOS scroll-through still delivers wheel events to
  // the webview. Convert a gesture's accumulated deltaX into discrete lane
  // steps and suppress native track scrolling so the two don't compete. On
  // web, native scroll + snap already handles swipes.
  useEffect(() => {
    if (!isTauriEnvironment()) return
    let idle = 0
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return
      if (event.target instanceof Element && event.target.closest('.modal-backdrop, .menu-panel')) return
      const scale = event.deltaMode === 1 ? 16 : 1
      const deltaX = event.deltaX * scale
      if (Math.abs(deltaX) <= Math.abs(event.deltaY * scale)) return
      event.preventDefault()
      laneSwipeAccumRef.current += deltaX
      window.clearTimeout(idle)
      idle = window.setTimeout(() => { laneSwipeAccumRef.current = 0 }, 200)
      if (Math.abs(laneSwipeAccumRef.current) >= 80) {
        goToLane(activeLane + Math.sign(laneSwipeAccumRef.current))
        laneSwipeAccumRef.current = 0
      }
    }
    window.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => {
      window.removeEventListener('wheel', onWheel, true)
      window.clearTimeout(idle)
    }
  }, [activeLane, goToLane])

  useEffect(() => {
    if (!loaded) return
    const timer = window.setTimeout(() => {
      const ids = [...pendingNoteWritesRef.current]
      if (!ids.length) return
      pendingNoteWritesRef.current.clear()
      setSaveState('saving')
      Promise.all(ids.flatMap((id) => {
        const note = namedDocsRef.current[id]
        return note ? [saveNamedDocument(note, { ifNewer: true })] : []
      })).then(() => {
        setSaveState('saved')
        namedDocsChannelRef.current?.postMessage('changed')
      }).catch(() => setSaveState('saved'))
    }, 350)
    return () => window.clearTimeout(timer)
  }, [namedDocs, loaded])

  useEffect(() => {
    Promise.all([listDailyDocuments(), listNamedDocuments()]).then(([stored, storedNotes]) => {
      // Tombstones that were never synced can't exist remotely — purge them.
      storedNotes.filter((note) => note.deleted && !note.syncBase && !note.syncedMeta).forEach((note) => { void deleteNamedDocument(note.id) })
      const noteRecords = Object.fromEntries(normalizeLanes(storedNotes.filter((note) => !(note.deleted && !note.syncBase && !note.syncedMeta))).map((note) => [note.id, note]))
      namedDocsRef.current = noteRecords
      setNamedDocs(noteRecords)
      dirtyNotesRef.current = new Set(Object.values(noteRecords).filter((note) => note.syncBase ? note.markdown !== note.syncBase.markdown || !namedMetaSynced(note) : !note.deleted).map((note) => note.id))
      const savedDocuments = Object.fromEntries(stored.map((document) => [document.day, document.markdown]))
      documentUpdatedAtRef.current = Object.fromEntries(stored.map((document) => [document.day, document.updatedAt]))
      syncBasesRef.current = Object.fromEntries(stored.flatMap((document) => document.syncBase ? [[document.day, document.syncBase]] : []))
      dirtyDaysRef.current = new Set(stored.filter((document) => document.syncBase && document.markdown !== document.syncBase.markdown).map((document) => document.day))
      if (!(today in savedDocuments)) {
        savedDocuments[today] = ''
      }
      setDocuments(savedDocuments)
      setDays([...new Set([today, shiftLogicalDay(today, -1), ...stored.map((document) => document.day)])].sort((left, right) => right.localeCompare(left)))
      setLoaded(true)
    }).catch(() => setLoaded(true))
  }, [today])

  useEffect(() => {
    queueMicrotask(() => {
      setDays((current) => current.includes(today) ? current : [today, ...current])
      setDocuments((current) => today in current ? current : { ...current, [today]: '' })
    })
  }, [today])

  useEffect(() => {
    savePreferences(preferences)
    void invokeNative('set_capture_window_always_on_top', { alwaysOnTop: preferences.captureAlwaysOnTop })
    void invokeNative('set_capture_window_opacity', { opacity: preferences.windowOpacityEnabled ? preferences.windowOpacity / 100 : 1 })
    void invokeNative('set_capture_shortcut', { shortcut: preferences.captureShortcut })
    void invokeNative('set_launch_at_login', { enabled: preferences.launchAtLogin })
    void invokeNative('set_app_visibility', { showMenuBar: preferences.showMenuBar, showDockIcon: preferences.showDockIcon })
  }, [preferences])

  useEffect(() => {
    if (!loaded || !isTauriEnvironment() || preferences.backupFrequency === 'off' || !preferences.backupFolder || backupAccessRootRef.current === preferences.backupFolder) return
    backupAccessRootRef.current = preferences.backupFolder
    void invoke('request_backup_access', { root: preferences.backupFolder })
      .then(() => invoke<number | null>('last_backup_at', { root: preferences.backupFolder }))
      .then((stamp) => { if (stamp) setLastBackupAt((current) => Math.max(current ?? 0, stamp)) })
      .catch(() => setBackupState('error'))
  }, [loaded, preferences.backupFolder, preferences.backupFrequency])

  const allTags = useMemo(() => [...new Set([...Object.values(documents), ...sortedNotes.map((note) => note.markdown)].flatMap((markdown) => parseMarkdown(markdown).ranges.map((range) => range.tag)))].sort((left, right) => left.localeCompare(right)), [documents, sortedNotes])
  const shortcutConflicts = useMemo(() => {
    const values = Object.values(preferences.shortcuts).filter(Boolean)
    return new Set(values.filter((shortcut, index) => values.indexOf(shortcut) !== index))
  }, [preferences.shortcuts])
  const oldestDocumentDay = Object.keys(documents).sort()[0] ?? today
  const buildTimeLabel = useMemo(() => {
    const date = new Date(__BUILD_TIME__)
    if (Number.isNaN(date.getTime())) return `Build time: ${__BUILD_TIME__}`
    const formattedDate = `${date.getMonth() + 1}/${date.getDate()}/${String(date.getFullYear()).slice(-2)}`
    const formattedTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
    return `Build time: ${formattedDate} at ${formattedTime}`
  }, [])

  const appendOlderDay = useCallback(() => {
    setDays((current) => {
      if (!preferences.showEmptyDays && current[current.length - 1] <= oldestDocumentDay) return current
      return [...current, shiftLogicalDay(current[current.length - 1], -1)]
    })
  }, [oldestDocumentDay, preferences.showEmptyDays])

  useEffect(() => {
    if (!loaded) return
    const sentinel = streamEndRef.current
    const stream = sentinel?.closest<HTMLElement>('.day-stream')
    if (!sentinel || !stream) return
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !filterTags.length && !effectiveHideMuted) appendOlderDay()
    }, { root: stream, rootMargin: '0px 0px 800px 0px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [appendOlderDay, filterTags.length, effectiveHideMuted, loaded])

  useEffect(() => {
    if (!loaded || filterTags.length || effectiveHideMuted) return
    const sentinel = streamEndRef.current
    const stream = sentinel?.closest<HTMLElement>('.day-stream')
    if (!sentinel || !stream) return
    const distanceFromTop = sentinel.getBoundingClientRect().top - stream.getBoundingClientRect().top
    if (distanceFromTop > stream.clientHeight + 800) return
    appendOlderDay()
  }, [appendOlderDay, days.length, filterTags.length, effectiveHideMuted, loaded])

  useEffect(() => {
    function handleInterfaceShortcuts(event: KeyboardEvent) {
      const helpShortcut = matchesShortcut(event, preferences.shortcuts.help) || (event.code === 'Slash' && event.shiftKey && event.metaKey && !event.ctrlKey && !event.altKey)
      if (helpShortcut) {
        event.preventDefault()
        setShortcutHelpOpen(true)
        setOnboardingOpen(false)
        setMenuOpen(false)
        return
      }
      if (matchesShortcut(event, preferences.shortcuts.settings)) {
        event.preventDefault()
        setSettingsOpen(true)
        setMenuOpen(false)
        return
      }
      if (matchesShortcut(event, preferences.shortcuts.toggleMuted)) {
        event.preventDefault()
        setHideMutedLines((hidden) => !hidden)
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 't') {
        const selectionAnchor = window.getSelection()?.anchorNode
        const anchorElement = selectionAnchor instanceof Element ? selectionAnchor : selectionAnchor?.parentElement
        const editorHost = (document.activeElement instanceof Element ? document.activeElement.closest('.notes-mdx-editor') : null)
          ?? anchorElement?.closest('.notes-mdx-editor')
          ?? document.querySelector(`[data-day="${today}"] .notes-mdx-editor`)
          ?? document.querySelector('.notes-mdx-editor')
        const tagInput = editorHost?.querySelector<HTMLInputElement>('.notes-editor-tag-input-wrap input')
        if (!tagInput) return
        event.preventDefault()
        const selection = window.getSelection()
        const range = selection && selection.rangeCount > 0 && !selection.isCollapsed && anchorElement?.closest('.mdxeditor-root-contenteditable')
          ? selection.getRangeAt(0).cloneRange()
          : null
        // Defer the focus past keydown dispatch — Lexical's selection
        // reconcile (and WKWebView in the mac capture window) can hand DOM
        // focus straight back to the editor when it happens synchronously.
        // Retry a couple of frames if something steals it right back.
        let attempts = 0
        const focusTagInput = () => {
          tagInput.focus()
          attempts += 1
          if (document.activeElement !== tagInput && attempts < 4) {
            window.requestAnimationFrame(focusTagInput)
          }
        }
        window.requestAnimationFrame(focusTagInput)
        if (range && typeof Highlight !== 'undefined') {
          CSS.highlights.set('notes-preserved-selection', new Highlight(range))
        }
        return
      }
      // Mod-G / Mod-Shift-G = next/previous find match — global while find is
      // active so it works both inside the search input and editors.
      if (findActiveRef.current && (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'g') {
        event.preventDefault()
        advanceFind(event.shiftKey ? -1 : 1)
        return
      }
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      if (matchesShortcut(event, preferences.shortcuts.search)) {
        event.preventDefault()
        setSearchOpen((open) => !open)
        return
      }
      if (matchesShortcut(event, preferences.shortcuts.zoomIn)) {
        event.preventDefault()
        setPreferences((current) => ({ ...current, zoomLevel: Math.min(150, current.zoomLevel + 10) }))
        return
      }
      if (matchesShortcut(event, preferences.shortcuts.zoomOut)) {
        event.preventDefault()
        setPreferences((current) => ({ ...current, zoomLevel: Math.max(60, current.zoomLevel - 10) }))
        return
      }
      if (matchesShortcut(event, preferences.shortcuts.jumpToToday)) {
        event.preventDefault()
        document.querySelector(`[data-day="${today}"]`)?.scrollIntoView({ block: 'start' })
        return
      }
      if (matchesShortcut(event, preferences.shortcuts.exportToday)) {
        event.preventDefault()
        downloadMarkdown(documents[today] ?? '', `${today}.md`)
        return
      }
      const laneDirection = matchesShortcut(event, preferences.shortcuts.lanePrevious) ? -1 : matchesShortcut(event, preferences.shortcuts.laneNext) ? 1 : 0
      if (laneDirection) {
        event.preventDefault()
        goToLane(activeLane + laneDirection)
        return
      }
      if (matchesShortcut(event, preferences.shortcuts.todayTop)) {
        event.preventDefault()
        goToLane(0)
        document.querySelector(`[data-day="${today}"] .notes-mdx-editor`)?.dispatchEvent(new CustomEvent('notes-focus-edge', { detail: { edge: 'start' }, bubbles: false }))
        return
      }
      // Ctrl-1 jumps to the first lane (daily), Ctrl-2 the second, etc.
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && /^[1-9]$/.test(event.key)) {
        event.preventDefault()
        goToLane(Number(event.key) - 1)
        return
      }
      // The lane viewport is a native horizontal scroller — a bare ←/→ (or
      // any non-lane arrow chord) with focus outside an editable scrolls it
      // and snaps to another lane. Lanes only move via the lane shortcuts,
      // swipes, or the dots.
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const target = event.target
        if (!(target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select')))) event.preventDefault()
      }
      if (matchesShortcut(event, preferences.shortcuts.noteCollapse)) {
        const anchor = window.getSelection()?.anchorNode
        const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement
        const card = (document.activeElement instanceof Element ? document.activeElement.closest('.note-card') : null) ?? anchorElement?.closest('.note-card')
        const noteId = card instanceof HTMLElement ? card.dataset.noteId : undefined
        if (!noteId) return
        event.preventDefault()
        toggleNoteCollapsedRef.current(noteId)
        return
      }
      const direction = matchesShortcut(event, preferences.shortcuts.dayPrevious) ? -1 : matchesShortcut(event, preferences.shortcuts.dayNext) ? 1 : 0
      if (!direction) return
      const activeCard = document.activeElement?.closest('.day-card, .note-card') as HTMLElement | null
      if (!activeCard) return
      const cards = [...(activeCard.parentElement?.querySelectorAll<HTMLElement>('.day-card, .note-card') ?? [])]
      const currentIndex = cards.indexOf(activeCard)
      const nextEditor = cards[currentIndex + direction]?.querySelector<HTMLElement>('.mdxeditor-root-contenteditable')
      if (nextEditor) {
        event.preventDefault()
        nextEditor.focus()
        nextEditor.scrollIntoView({ block: 'center' })
      }
    }
    window.addEventListener('keydown', handleInterfaceShortcuts, true)
    return () => window.removeEventListener('keydown', handleInterfaceShortcuts, true)
  }, [activeLane, advanceFind, documents, goToLane, preferences.shortcuts, today])

  useEffect(() => {
    function closeTransientPanels(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        setSearchOpen(false)
        setFilterOpen(false)
        setSettingsOpen(false)
        setShortcutHelpOpen(false)
        setTagsOpen(false)
        setMoveRequest(null)
      }
    }
    function closeOnOutsideClick(event: MouseEvent) {
      const target = event.target as HTMLElement
      if (target.closest('.menu-panel, .icon-button, .search-button, .search-panel, .filter-panel, .filter-button')) return
      setMenuOpen(false)
      setSearchOpen(false)
      setFilterOpen(false)
    }
    window.addEventListener('keydown', closeTransientPanels)
    window.addEventListener('mousedown', closeOnOutsideClick)
    return () => {
      window.removeEventListener('keydown', closeTransientPanels)
      window.removeEventListener('mousedown', closeOnOutsideClick)
    }
  }, [])

  useEffect(() => {
    if (!captureMode || !loaded) return
    function focusTodayEditor() {
      if (settingsOpen || tagsOpen) return
      window.setTimeout(() => {
        if (settingsOpen || tagsOpen) return
        const editorHost = document.querySelector<HTMLElement>(`[data-day="${today}"] .notes-mdx-editor`)
        // 'down' arrives from above → caret at the start of the first line.
        editorHost?.dispatchEvent(new CustomEvent('notes-focus-edge', { detail: { direction: 'down' }, bubbles: false }))
      }, 0)
    }
    // Remember which editor last held a caret — hiding the window can drop
    // the DOM selection, and we restore it in that same editor on refocus.
    function trackCaretHost() {
      const anchor = window.getSelection()?.anchorNode
      const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement
      const editorHost = anchorElement?.closest<HTMLElement>('.notes-mdx-editor')
      if (editorHost) lastEditorHostRef.current = editorHost
    }
    // Window regained focus (or the quick-entry shortcut summoned it): keep a
    // live caret, restore one the hide dropped, or focus the top of today.
    function restoreOrFocusToday() {
      if (settingsOpen || tagsOpen) return
      // A focused control (input, button, …) outside the editors keeps its
      // focus — don't steal it. A focused editor with a dropped selection
      // still falls through to the caret checks below.
      const activeElement = document.activeElement
      const focusedInEditor = !!activeElement?.closest?.('.mdxeditor-root-contenteditable')
      if (!focusedInEditor && activeElement && activeElement !== document.body && activeElement !== document.documentElement) return
      // A caret somewhere in an editor: make sure it's actually in view —
      // scrolling instantly, preferring the stream top when the caret is in
      // the first screenful. Deferred a frame so WKWebView finishes any
      // focus-driven scroll restore first.
      const anchor = window.getSelection()?.anchorNode
      const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement
      if (anchorElement?.closest('.mdxeditor-root-contenteditable')) {
        window.requestAnimationFrame(() => ensureCaretVisible({ preferTop: true }))
        return
      }
      const lastHost = lastEditorHostRef.current
      if (lastHost?.isConnected) {
        lastHost.dispatchEvent(new CustomEvent('notes-restore-caret', { bubbles: false }))
        return
      }
      focusTodayEditor()
    }
    function handleWindowFocus() {
      setCaptureFocused(true)
      restoreOrFocusToday()
    }
    function handleWindowBlur() {
      setCaptureFocused(false)
    }
    document.addEventListener('selectionchange', trackCaretHost)
    window.addEventListener('focus', handleWindowFocus)
    window.addEventListener('blur', handleWindowBlur)
    let disposed = false
    let unlisten: (() => void) | undefined
    if (isTauriEnvironment()) {
      void listen('quick-entry-focus', restoreOrFocusToday).then((cleanup) => {
        if (disposed) cleanup()
        else unlisten = cleanup
      })
    }
    return () => {
      disposed = true
      document.removeEventListener('selectionchange', trackCaretHost)
      window.removeEventListener('focus', handleWindowFocus)
      window.removeEventListener('blur', handleWindowBlur)
      unlisten?.()
    }
  }, [captureMode, loaded, settingsOpen, tagsOpen, today])

  useEffect(() => {
    if (!loaded) return
    const timer = window.setTimeout(() => {
      setSaveState('saving')
      Promise.all(Object.entries(documents).filter(([, markdown]) => markdown).map(([day, markdown]) => saveDailyDocument({ day, markdown, updatedAt: documentUpdatedAtRef.current[day] ?? currentTimestamp() }))).then(() => setSaveState('saved')).catch(() => setSaveState('saved'))
    }, 350)
    return () => window.clearTimeout(timer)
  }, [documents, loaded])

  useEffect(() => {
    if (!loaded || !firebaseUser || !dataKey) return
    const unwatchDays = watchRemoteDocuments(firebaseUser.uid, dataKey, (remoteDocuments) => handleRemoteDocumentsRef.current(remoteDocuments), (error) => {
      setSyncState('error')
      setSyncMessage(error.message || 'Realtime sync failed.')
    })
    const unwatchNotes = watchRemoteNamedDocuments(firebaseUser.uid, dataKey, (remoteDocuments) => handleRemoteNamedDocumentsRef.current(remoteDocuments), (error) => {
      setSyncState('error')
      setSyncMessage(error.message || 'Realtime sync failed.')
    })
    return () => { unwatchDays(); unwatchNotes() }
  }, [dataKey, firebaseUser, loaded])

  useEffect(() => {
    if (!loaded || !firebaseUser || !dataKey || !isOnline) return
    const timer = window.setTimeout(() => {
      void uploadPendingDocumentsRef.current()
      void uploadPendingNotesRef.current()
    }, 600)
    return () => window.clearTimeout(timer)
  }, [dataKey, documents, namedDocs, firebaseUser, isOnline, loaded])

  function setDocumentMarkdown(day: string, markdown: string) {
    documentsRef.current = { ...documentsRef.current, [day]: markdown }
    setDocuments((current) => ({ ...current, [day]: markdown }))
  }

  useEffect(() => {
    if (!settingsOpen || !firebaseUser) return
    void pushStatus(firebaseUser.uid).then(setPushState).catch(() => undefined)
  }, [firebaseUser, settingsOpen])

  async function togglePush() {
    if (!firebaseUser) return
    setPushBusy(true)
    try {
      setPushState(pushState === 'enabled' ? await disablePush(firebaseUser.uid) : await enablePush(firebaseUser.uid))
    } finally {
      setPushBusy(false)
    }
  }

  function persistLocalDocument(day: string, markdown: string, updatedAt: number, syncBase = syncBasesRef.current[day]) {
    void saveDailyDocument({ day, markdown, updatedAt, syncBase }).catch(() => undefined)
  }

  function trackOwnWriteId(writeId: string) {
    ownWriteIdsRef.current.set(writeId, ++ownWriteSeqRef.current)
  }

  function showSyncConflict(conflict: SyncConflict) {
    setSyncConflicts((current) => [...current.filter((item) => item.day !== conflict.day), conflict])
    setConflictDrafts((current) => ({ ...current, [conflict.day]: current[conflict.day] ?? conflict.local.markdown }))
    setSyncState('ready')
    setSyncMessage('Cloud changes need review.')
  }

  function clearSyncConflict(day: string) {
    setSyncConflicts((current) => current.filter((item) => item.day !== day))
    setConflictDrafts((current) => {
      const next = { ...current }
      delete next[day]
      return next
    })
  }

  function handleRemoteDocuments(remoteDocuments: DailyDocument[]) {
    const remoteDays = new Set(remoteDocuments.map((document) => document.day))
    remoteDocuments.forEach((remote) => {
      const latestRemote = latestRemoteRef.current[remote.day]
      if (latestRemote && remote.markdown === latestRemote.markdown && remote.updatedAt === latestRemote.updatedAt) return
      // Echoes decrypt asynchronously and can surface out of order — a
      // superseded version must not regress the merge base or dedupe state.
      if (isStaleRemoteDocument(remote, latestRemote, ownWriteIdsRef.current)) return
      latestRemoteRef.current[remote.day] = remote
      const base = syncBasesRef.current[remote.day]
      if (base && remote.markdown === base.markdown && remote.updatedAt === base.updatedAt) return

      const currentMarkdown = documentsRef.current[remote.day] ?? ''
      const syncBase = { markdown: remote.markdown, updatedAt: remote.updatedAt }
      // A snapshot carrying a write id this app stamped is our own commit
      // echoing back — possibly a transaction-merged result that differs from
      // the submitted markdown. Adopt it as the merge base without touching
      // the editor, or the merge can resurrect just-deleted text or flash a
      // false conflict that the upload resolution clears a moment later.
      if (remote.writeId && ownWriteIdsRef.current.has(remote.writeId)) {
        syncBasesRef.current[remote.day] = syncBase
        persistLocalDocument(remote.day, currentMarkdown, documentUpdatedAtRef.current[remote.day] ?? currentTimestamp(), syncBase)
        return
      }
      if (remote.markdown === uploadingDaysRef.current.get(remote.day)) {
        // This snapshot is our own in-flight upload landing, not an external
        // edit. Adopt it as the merge base so typing during the upload is
        // treated as new divergence, not as a conflict against ourselves.
        syncBasesRef.current[remote.day] = syncBase
        persistLocalDocument(remote.day, currentMarkdown, documentUpdatedAtRef.current[remote.day] ?? currentTimestamp(), syncBase)
        return
      }
      const localDiverged = base ? currentMarkdown !== base.markdown : Boolean(currentMarkdown) && currentMarkdown !== remote.markdown
      if (!localDiverged) {
        syncBasesRef.current[remote.day] = syncBase
        dirtyDaysRef.current.delete(remote.day)
        documentUpdatedAtRef.current[remote.day] = remote.updatedAt
        if (currentMarkdown !== remote.markdown) setDocumentMarkdown(remote.day, remote.markdown)
        persistLocalDocument(remote.day, remote.markdown, remote.updatedAt, syncBase)
        clearSyncConflict(remote.day)
        return
      }

      if (!base) {
        dirtyDaysRef.current.add(remote.day)
        persistLocalDocument(remote.day, currentMarkdown, documentUpdatedAtRef.current[remote.day] ?? currentTimestamp())
        showSyncConflict({
          day: remote.day,
          local: { day: remote.day, markdown: currentMarkdown, updatedAt: documentUpdatedAtRef.current[remote.day] ?? currentTimestamp(), syncBase: base },
          remote,
          base,
        })
        return
      }

      const merged = mergeMarkdown(base.markdown, currentMarkdown, remote.markdown)
      if (merged.status === 'conflict') {
        dirtyDaysRef.current.add(remote.day)
        persistLocalDocument(remote.day, currentMarkdown, documentUpdatedAtRef.current[remote.day] ?? currentTimestamp())
        showSyncConflict({
          day: remote.day,
          local: { day: remote.day, markdown: currentMarkdown, updatedAt: documentUpdatedAtRef.current[remote.day] ?? currentTimestamp(), syncBase: base },
          remote,
          base,
        })
        return
      }

      syncBasesRef.current[remote.day] = syncBase
      const updatedAt = merged.markdown === remote.markdown ? remote.updatedAt : currentTimestamp()
      documentUpdatedAtRef.current[remote.day] = updatedAt
      setDocumentMarkdown(remote.day, merged.markdown)
      if (merged.markdown === remote.markdown) dirtyDaysRef.current.delete(remote.day)
      else dirtyDaysRef.current.add(remote.day)
      persistLocalDocument(remote.day, merged.markdown, updatedAt, syncBase)
      clearSyncConflict(remote.day)
    })

    Object.keys(documentsRef.current).forEach((day) => {
      if (!remoteDays.has(day) && documentsRef.current[day]) dirtyDaysRef.current.add(day)
    })
    if (remoteDocuments.length) {
      setSyncState('ready')
      setSyncMessage('Cloud changes received.')
    }
    void uploadPendingDocumentsRef.current()
  }

  async function uploadPendingDocuments() {
    if (!firebaseUser || !dataKey || !isOnline) return
    const days = [...dirtyDaysRef.current].filter((day) => !uploadingDaysRef.current.has(day))
    if (!days.length) return
    setSyncState('working')
    const outcomes = await Promise.all(days.map((day) => uploadPendingDocument(day)))
    if (outcomes.includes('failed')) {
      setSyncState('error')
      setSyncMessage('Realtime sync failed.')
      return
    }
    if (outcomes.includes('conflict')) {
      setSyncState('ready')
      setSyncMessage('Cloud changes need review.')
    } else {
      setSyncState('ready')
      setSyncMessage('Changes synced.')
    }
    if (outcomes.includes('retry')) window.setTimeout(() => { void uploadPendingDocumentsRef.current() }, 0)
  }

  async function uploadPendingDocument(day: string): Promise<'written' | 'conflict' | 'failed' | 'retry'> {
    if (!firebaseUser || !dataKey) return 'failed'
    const submitted: DailyDocument = {
      day,
      markdown: documentsRef.current[day] ?? '',
      updatedAt: documentUpdatedAtRef.current[day] ?? currentTimestamp(),
      syncBase: syncBasesRef.current[day],
    }
    uploadingDaysRef.current.set(day, submitted.markdown)
    try {
      const result = await uploadEncryptedDocument(firebaseUser.uid, submitted, dataKey, { onWriteId: trackOwnWriteId })
      if (result.status === 'conflict') {
        handleUploadConflict(result.conflict)
        return 'conflict'
      }
      return handleCommittedUpload(submitted, result.document)
    } catch {
      dirtyDaysRef.current.add(day)
      return 'failed'
    } finally {
      uploadingDaysRef.current.delete(day)
    }
  }

  function handleCommittedUpload(submitted: DailyDocument, committed: DailyDocument) {
    const committedBase = { markdown: committed.markdown, updatedAt: committed.updatedAt }
    latestRemoteRef.current[committed.day] = committed
    const currentMarkdown = documentsRef.current[committed.day] ?? ''
    if (currentMarkdown === submitted.markdown) {
      syncBasesRef.current[committed.day] = committedBase
      documentUpdatedAtRef.current[committed.day] = committed.updatedAt
      setDocumentMarkdown(committed.day, committed.markdown)
      dirtyDaysRef.current.delete(committed.day)
      persistLocalDocument(committed.day, committed.markdown, committed.updatedAt, committedBase)
      clearSyncConflict(committed.day)
      return 'written' as const
    }

    const rebased = mergeMarkdown(submitted.markdown, currentMarkdown, committed.markdown)
    if (rebased.status === 'conflict') {
      const submittedBase = { markdown: submitted.markdown, updatedAt: submitted.updatedAt }
      syncBasesRef.current[committed.day] = submittedBase
      dirtyDaysRef.current.add(committed.day)
      persistLocalDocument(committed.day, currentMarkdown, documentUpdatedAtRef.current[committed.day] ?? currentTimestamp(), submittedBase)
      showSyncConflict({
        day: committed.day,
        local: { day: committed.day, markdown: currentMarkdown, updatedAt: documentUpdatedAtRef.current[committed.day] ?? currentTimestamp(), syncBase: submittedBase },
        remote: committed,
        base: submittedBase,
      })
      return 'conflict' as const
    }

    syncBasesRef.current[committed.day] = committedBase
    const updatedAt = rebased.markdown === committed.markdown ? committed.updatedAt : currentTimestamp()
    documentUpdatedAtRef.current[committed.day] = updatedAt
    setDocumentMarkdown(committed.day, rebased.markdown)
    if (rebased.markdown === committed.markdown) dirtyDaysRef.current.delete(committed.day)
    else dirtyDaysRef.current.add(committed.day)
    persistLocalDocument(committed.day, rebased.markdown, updatedAt, committedBase)
    clearSyncConflict(committed.day)
    return rebased.markdown === committed.markdown ? 'written' as const : 'retry' as const
  }

  function handleUploadConflict(conflict: SyncConflict) {
    const currentMarkdown = documentsRef.current[conflict.day] ?? conflict.local.markdown
    const mergeBase = conflict.base ?? conflict.local.syncBase
    latestRemoteRef.current[conflict.day] = conflict.remote
    if (mergeBase) syncBasesRef.current[conflict.day] = mergeBase
    else delete syncBasesRef.current[conflict.day]
    dirtyDaysRef.current.add(conflict.day)
    persistLocalDocument(conflict.day, currentMarkdown, documentUpdatedAtRef.current[conflict.day] ?? currentTimestamp(), mergeBase)
    showSyncConflict({
      ...conflict,
      local: { day: conflict.day, markdown: currentMarkdown, updatedAt: documentUpdatedAtRef.current[conflict.day] ?? currentTimestamp(), syncBase: mergeBase },
      remote: conflict.remote,
    })
  }

  // --- Named notes ---------------------------------------------------------

  function persistNamedDocument(note: NamedDocument) {
    void saveNamedDocument(note).then(() => namedDocsChannelRef.current?.postMessage('changed')).catch(() => undefined)
  }

  function writeNamedDoc(note: NamedDocument) {
    namedDocsRef.current = { ...namedDocsRef.current, [note.id]: note }
    setNamedDocs(namedDocsRef.current)
  }

  // Applies a structural mutation (create/move/reorder/rename/delete):
  // renormalizes lane/order, stamps updatedAt on anything that changed, marks
  // it dirty for sync, and persists it.
  function commitNamedDocuments(notes: NamedDocument[]) {
    const stamp = currentTimestamp()
    const current = namedDocsRef.current
    const records: Record<string, NamedDocument> = {}
    for (const note of normalizeLanes(notes)) {
      const existing = current[note.id]
      const changed = !existing || existing.title !== note.title || existing.markdown !== note.markdown || existing.lane !== note.lane || existing.order !== note.order || existing.collapsed !== note.collapsed || existing.deleted !== note.deleted
      const record = changed ? { ...note, updatedAt: stamp } : note
      records[note.id] = record
      if (changed) {
        dirtyNotesRef.current.add(note.id)
        pendingNoteWritesRef.current.add(note.id)
        persistNamedDocument(record)
      }
    }
    namedDocsRef.current = records
    setNamedDocs(records)
  }

  function updateNoteMarkdown(id: string, markdown: string) {
    const note = namedDocsRef.current[id]
    if (!note) return
    writeNamedDoc({ ...note, markdown, updatedAt: currentTimestamp() })
    dirtyNotesRef.current.add(id)
    pendingNoteWritesRef.current.add(id)
  }

  function createNote(lane: number) {
    const notes = Object.values(namedDocsRef.current)
    const order = notes.filter((note) => note.lane === lane && !note.deleted).length
    commitNamedDocuments([...notes, { id: crypto.randomUUID(), title: '', markdown: '', lane, order, collapsed: false, updatedAt: currentTimestamp() }])
  }

  function renameNote(id: string, title: string) {
    const note = namedDocsRef.current[id]
    if (!note || note.title === title.trim()) return
    commitNamedDocuments(Object.values(namedDocsRef.current).map((current) => current.id === id ? { ...current, title: title.trim() } : current))
  }

  function toggleNoteCollapsed(id: string) {
    const note = namedDocsRef.current[id]
    if (!note) return
    commitNamedDocuments(Object.values(namedDocsRef.current).map((current) => current.id === id ? { ...current, collapsed: !current.collapsed } : current))
  }

  function deleteNote(id: string) {
    // Deletion syncs via tombstone: the remote doc gets `deleted: true` so
    // other devices mark their copy deleted instead of resurrecting it.
    commitNamedDocuments(Object.values(namedDocsRef.current).map((current) => current.id === id ? { ...current, deleted: true } : current))
  }

  function moveNote(id: string, target: NoteMoveTarget) {
    const notes = Object.values(namedDocsRef.current)
    const note = notes.find((current) => current.id === id)
    if (!note) return
    const maxLane = notes.reduce((max, current) => current.deleted ? max : Math.max(max, current.lane), 0)
    let lane = note.lane
    let order = note.order
    if (target === 'up' || target === 'down') {
      const laneNotes = notes.filter((current) => current.lane === note.lane && !current.deleted).sort((a, b) => a.order - b.order)
      const index = laneNotes.findIndex((current) => current.id === id)
      const swap = laneNotes[index + (target === 'up' ? -1 : 1)]
      if (!swap) return
      commitNamedDocuments(notes.map((current) => current.id === id ? { ...current, order: swap.order } : current.id === swap.id ? { ...current, order: note.order } : current))
      return
    }
    if (target === 'new-lane') lane = maxLane + 1
    else lane = Math.max(1, Math.min(maxLane, note.lane + (target === 'left' ? -1 : 1)))
    order = notes.filter((current) => current.lane === lane && !current.deleted && current.id !== id).length
    const updated = notes.map((current) => current.id === id ? { ...current, lane, order } : current)
    // The note's lane can shift when normalization collapses an emptied lane —
    // navigate to its final position.
    const moved = normalizeLanes(updated).find((current) => current.id === id)
    commitNamedDocuments(updated)
    if (moved) goToLane(moved.lane)
  }

  // Live reorder during a handle drag: preview without dirty stamps; the
  // commit (pointerup) stamps changed records so the new order propagates.
  const reorderSnapshotRef = useRef<Record<string, NamedDocument> | null>(null)

  function reorderNotePreview(id: string, index: number) {
    const note = namedDocsRef.current[id]
    if (!note) return
    if (!reorderSnapshotRef.current) reorderSnapshotRef.current = namedDocsRef.current
    const laneNotes = Object.values(namedDocsRef.current).filter((current) => current.lane === note.lane && !current.deleted && current.id !== id).sort((a, b) => a.order - b.order)
    laneNotes.splice(Math.max(0, Math.min(laneNotes.length, index)), 0, note)
    const reordered = new Map(laneNotes.map((current, order) => [current.id, order]))
    const next = Object.fromEntries(Object.entries(namedDocsRef.current).map(([key, current]) => {
      const order = reordered.get(current.id)
      return [key, order === undefined || order === current.order ? current : { ...current, order }] as const
    }))
    namedDocsRef.current = next
    setNamedDocs(next)
  }

  function commitNoteReorder() {
    const before = reorderSnapshotRef.current
    reorderSnapshotRef.current = null
    if (!before) return
    const stamp = currentTimestamp()
    const next = { ...namedDocsRef.current }
    Object.values(next).forEach((note) => {
      const previous = before[note.id]
      if (!previous || previous.order === note.order && previous.lane === note.lane) return
      next[note.id] = { ...note, updatedAt: stamp }
      dirtyNotesRef.current.add(note.id)
      pendingNoteWritesRef.current.add(note.id)
    })
    namedDocsRef.current = next
    setNamedDocs(next)
  }

  function handleRemoteNamedDocuments(remoteDocuments: NamedDocument[]) {
    const remoteIds = new Set(remoteDocuments.map((document) => document.id))
    remoteDocuments.forEach((remote) => {
      const latestRemote = latestRemoteNotesRef.current[remote.id]
      if (latestRemote && remote.updatedAt === latestRemote.updatedAt && remote.markdown === latestRemote.markdown && sameNamedMeta(remote, latestRemote)) return
      // Same out-of-order guard as daily documents: superseded snapshot
      // versions must not regress the merge base or dedupe state.
      if (isStaleRemoteDocument(remote, latestRemote, ownWriteIdsRef.current)) return
      latestRemoteNotesRef.current[remote.id] = remote
      const local = namedDocsRef.current[remote.id]
      const syncBase = { markdown: remote.markdown, updatedAt: remote.updatedAt }
      const remoteMeta = namedMeta(remote)

      if (remote.writeId && ownWriteIdsRef.current.has(remote.writeId)) {
        // Our own commit echo — adopt it as merge base without touching the
        // editor, same as the daily-document path.
        if (local) {
          const next = { ...local, syncBase, syncedMeta: remoteMeta }
          writeNamedDoc(next)
          persistNamedDocument(next)
        }
        return
      }
      if (remote.markdown === uploadingNotesRef.current.get(remote.id)) {
        // Our own in-flight upload landing; adopt as base, not a merge.
        if (local) {
          const next = { ...local, syncBase, syncedMeta: remoteMeta }
          writeNamedDoc(next)
          persistNamedDocument(next)
        }
        return
      }
      if (!local) {
        const adopted: NamedDocument = { ...remote, syncBase, syncedMeta: remoteMeta }
        writeNamedDoc(adopted)
        persistNamedDocument(adopted)
        return
      }

      const base = local.syncBase
      const markdownDiverged = base ? local.markdown !== base.markdown : Boolean(local.markdown) && local.markdown !== remote.markdown
      const metaDiverged = !namedMetaSynced(local)
      const localNewer = local.updatedAt > remote.updatedAt

      if (!markdownDiverged && !metaDiverged) {
        // Local is unchanged since last sync — remote is authoritative.
        const next: NamedDocument = { ...remote, syncBase, syncedMeta: remoteMeta }
        dirtyNotesRef.current.delete(remote.id)
        writeNamedDoc(next)
        persistNamedDocument(next)
        clearSyncConflict(remote.id)
        return
      }

      if (!markdownDiverged) {
        // Content settled; only metadata diverged — last writer wins on
        // updatedAt. A local win stays dirty so the meta propagates.
        const next: NamedDocument = localNewer
          ? { ...local, syncBase }
          : { ...local, ...remoteMeta, syncBase, syncedMeta: remoteMeta }
        if (localNewer) dirtyNotesRef.current.add(remote.id)
        else dirtyNotesRef.current.delete(remote.id)
        writeNamedDoc(next)
        persistNamedDocument(next)
        if (!localNewer) clearSyncConflict(remote.id)
        return
      }

      const winnerMeta = localNewer ? namedMeta(local) : remoteMeta
      if (!base) {
        dirtyNotesRef.current.add(remote.id)
        persistNamedDocument(local)
        showSyncConflict({ day: remote.id, family: 'named', title: winnerMeta.title, local: namedAsDailyShape(local), remote: namedAsDailyShape(remote), base })
        return
      }

      const merged = mergeMarkdown(base.markdown, local.markdown, remote.markdown)
      if (merged.status === 'conflict') {
        dirtyNotesRef.current.add(remote.id)
        persistNamedDocument(local)
        showSyncConflict({ day: remote.id, family: 'named', title: winnerMeta.title, local: namedAsDailyShape(local), remote: namedAsDailyShape(remote), base })
        return
      }

      const next: NamedDocument = {
        ...local,
        ...winnerMeta,
        markdown: merged.markdown,
        updatedAt: merged.markdown === remote.markdown ? remote.updatedAt : currentTimestamp(),
        syncBase,
        syncedMeta: remoteMeta,
      }
      if (merged.markdown === remote.markdown && !localNewer) dirtyNotesRef.current.delete(remote.id)
      else dirtyNotesRef.current.add(remote.id)
      writeNamedDoc(next)
      persistNamedDocument(next)
      clearSyncConflict(remote.id)
    })

    Object.keys(namedDocsRef.current).forEach((id) => {
      const note = namedDocsRef.current[id]
      if (!remoteIds.has(id) && (note.markdown || note.deleted)) dirtyNotesRef.current.add(id)
    })
    void uploadPendingNotesRef.current()
  }

  async function uploadPendingNamedDocuments() {
    if (!firebaseUser || !dataKey || !isOnline) return
    const ids = [...dirtyNotesRef.current].filter((id) => !uploadingNotesRef.current.has(id) && namedDocsRef.current[id])
    if (!ids.length) return
    const outcomes = await Promise.all(ids.map((id) => uploadPendingNote(id)))
    if (outcomes.includes('failed')) {
      setSyncState('error')
      setSyncMessage('Realtime sync failed.')
      return
    }
    if (outcomes.includes('conflict')) {
      setSyncState('ready')
      setSyncMessage('Cloud changes need review.')
    } else {
      setSyncState('ready')
      setSyncMessage('Changes synced.')
    }
    if (outcomes.includes('retry')) window.setTimeout(() => { void uploadPendingNotesRef.current() }, 0)
  }

  async function uploadPendingNote(id: string): Promise<'written' | 'conflict' | 'failed' | 'retry'> {
    if (!firebaseUser || !dataKey) return 'failed'
    const local = namedDocsRef.current[id]
    if (!local) return 'written'
    const submitted = { ...local }
    uploadingNotesRef.current.set(id, submitted.markdown)
    try {
      const result = await uploadEncryptedNamedDocument(firebaseUser.uid, submitted, dataKey, { onWriteId: trackOwnWriteId })
      if (result.status === 'conflict') {
        handleUploadNoteConflict(result.conflict)
        return 'conflict'
      }
      return handleCommittedNoteUpload(submitted, result.document)
    } catch {
      dirtyNotesRef.current.add(id)
      return 'failed'
    } finally {
      uploadingNotesRef.current.delete(id)
    }
  }

  function handleCommittedNoteUpload(submitted: NamedDocument, committed: NamedDocument) {
    const committedBase = { markdown: committed.markdown, updatedAt: committed.updatedAt }
    const committedMeta = namedMeta(committed)
    latestRemoteNotesRef.current[committed.id] = committed
    const current = namedDocsRef.current[committed.id]
    if (!current) return 'written' as const
    const settled = current.markdown === submitted.markdown && sameNamedMeta(current, submitted)
    if (settled) {
      const next = { ...current, syncBase: committedBase, syncedMeta: committedMeta, updatedAt: committed.updatedAt }
      dirtyNotesRef.current.delete(committed.id)
      writeNamedDoc(next)
      persistNamedDocument(next)
      clearSyncConflict(committed.id)
      return 'written' as const
    }

    const rebased = mergeMarkdown(submitted.markdown, current.markdown, committed.markdown)
    if (rebased.status === 'conflict') {
      const submittedBase = { markdown: submitted.markdown, updatedAt: submitted.updatedAt }
      const next = { ...current, syncBase: submittedBase, syncedMeta: namedMeta(submitted) }
      dirtyNotesRef.current.add(committed.id)
      writeNamedDoc(next)
      persistNamedDocument(next)
      showSyncConflict({ day: committed.id, family: 'named', title: current.title, local: namedAsDailyShape(next), remote: namedAsDailyShape(committed), base: submittedBase })
      return 'conflict' as const
    }

    const winnerMeta = current.updatedAt > committed.updatedAt ? namedMeta(current) : committedMeta
    const next: NamedDocument = {
      ...current,
      ...winnerMeta,
      markdown: rebased.markdown,
      updatedAt: rebased.markdown === committed.markdown ? committed.updatedAt : currentTimestamp(),
      syncBase: committedBase,
      syncedMeta: committedMeta,
    }
    if (rebased.markdown === committed.markdown && sameNamedMeta(next, committed)) dirtyNotesRef.current.delete(committed.id)
    else dirtyNotesRef.current.add(committed.id)
    writeNamedDoc(next)
    persistNamedDocument(next)
    clearSyncConflict(committed.id)
    return rebased.markdown === committed.markdown ? 'written' as const : 'retry' as const
  }

  function handleUploadNoteConflict(conflict: SyncConflict) {
    const local = namedDocsRef.current[conflict.day]
    const mergeBase = conflict.base ?? conflict.local.syncBase
    if (local) {
      const next = { ...local, syncBase: mergeBase }
      dirtyNotesRef.current.add(conflict.day)
      writeNamedDoc(next)
      persistNamedDocument(next)
    }
    showSyncConflict({ ...conflict, base: mergeBase })
  }

  useEffect(() => {
    handleRemoteDocumentsRef.current = handleRemoteDocuments
    handleRemoteNamedDocumentsRef.current = handleRemoteNamedDocuments
    uploadPendingDocumentsRef.current = uploadPendingDocuments
    uploadPendingNotesRef.current = uploadPendingNamedDocuments
    toggleNoteCollapsedRef.current = toggleNoteCollapsed
  })

  const performBackup = useCallback(async () => {
    const directory = backupDirectoryRef.current
    if (!loaded || (!directory && !preferences.backupFolder) || preferences.backupFrequency === 'off') return
    const dailyDocuments = Object.entries(documents).map(([day, markdown]) => ({ day, markdown, updatedAt: Date.now() }))
    const documentSignature = backupSignature(dailyDocuments)
    const folderName = backupFolderName(preferences.backupFrequency)
    const currentBackupSignature = `${folderName}:${documentSignature}`
    if (!dailyDocuments.some((document) => document.markdown) || currentBackupSignature === lastBackupSignatureRef.current) return
    setBackupState('saving')
    try {
      if (isTauriEnvironment()) {
        await invoke('write_backup', { root: preferences.backupFolder, folderName, documents: dailyDocuments.map(({ day, markdown }) => ({ day, markdown })) })
        if (preferences.backupRetention !== 'off') await invoke('cleanup_backups', { root: preferences.backupFolder, cutoff: formatDateKey(backupRetentionCutoff(preferences.backupRetention)) })
      } else if (directory) {
        await writeBackup(directory, dailyDocuments, preferences.backupFrequency)
        if (preferences.backupRetention !== 'off') await cleanupBrowserBackups(directory, preferences.backupRetention)
      }
      lastBackupSignatureRef.current = currentBackupSignature
      localStorage.setItem('notes-last-backup-signature', currentBackupSignature)
      setLastBackupAt(Date.now())
      setBackupState('saved')
    } catch {
      setBackupState('error')
      void notifyMac(preferences.notificationsEnabled, 'Noteses backup failed', 'Automatic backup could not save your latest notes.')
    }
  }, [documents, loaded, preferences.backupFolder, preferences.backupFrequency, preferences.backupRetention, preferences.notificationsEnabled])

  useEffect(() => {
    if (!loaded) return
    const timer = window.setTimeout(() => { void performBackup() }, 400)
    return () => window.clearTimeout(timer)
  }, [documents, loaded, performBackup])

  async function chooseBackupFolder() {
    try {
      const selected = isTauriEnvironment() ? await openDirectoryDialog({ directory: true, multiple: false }) : await pickBackupDirectory()
      if (typeof selected === 'string') {
        setLastBackupAt(undefined)
        setPreferences((current) => ({ ...current, backupFolder: selected }))
      } else if (selected) {
        setLastBackupAt(undefined)
        backupDirectoryRef.current = selected
        setPreferences((current) => ({ ...current, backupFolder: 'Selected folder' }))
      } else {
        return
      }
      setBackupState('idle')
    } catch {
      setBackupState('error')
    }
  }

  function updateSource(day: string, markdown: string) {
    documentUpdatedAtRef.current[day] = currentTimestamp()
    dirtyDaysRef.current.add(day)
    setDocumentMarkdown(day, markdown)
  }

  // Cmd/Ctrl-M move targets: today first, then every named note in lane
  // order, then the previous 14 days — minus whichever editor the lines are
  // leaving.
  const moveTargets = useMemo<MoveLinesTarget[]>(() => {
    if (!moveRequest) return []
    const sourceDay = moveRequest.source.kind === 'day' ? moveRequest.source.day : null
    const targets: MoveLinesTarget[] = []
    if (sourceDay !== today) targets.push({ id: `day:${today}`, label: 'Today', section: 'Daily notes' })
    sortedNotes.forEach((note) => {
      if (moveRequest.source.kind === 'note' && moveRequest.source.id === note.id) return
      targets.push({ id: `note:${note.id}`, label: note.title || 'Untitled note', section: 'Named notes' })
    })
    for (let offset = 1; offset <= 14; offset += 1) {
      const day = shiftLogicalDay(today, -offset)
      if (day === sourceDay) continue
      targets.push({ id: `day:${day}`, label: formatLogicalDay(day, preferences.dateFormat), section: 'Past days' })
    }
    return targets
  }, [moveRequest, preferences.dateFormat, sortedNotes, today])

  function moveLinesTo(targetId: string) {
    const request = moveRequest
    setMoveRequest(null)
    if (!request) return
    const sourceMarkdown = request.source.kind === 'day'
      ? documentsRef.current[request.source.day] ?? ''
      : namedDocsRef.current[request.source.id]?.markdown ?? ''
    const extracted = extractLinesForMove(sourceMarkdown, request.startLine, request.endLine)
    if (!extracted) return
    if (extracted.source !== sourceMarkdown) {
      request.host.dispatchEvent(new CustomEvent('notes-move-caret-restore', { detail: { line: extracted.startLine } }))
    }
    if (request.source.kind === 'day') updateSource(request.source.day, extracted.source)
    else updateNoteMarkdown(request.source.id, extracted.source)
    if (!extracted.moved.trim()) return
    if (targetId.startsWith('day:')) {
      const day = targetId.slice(4)
      const existing = (documentsRef.current[day] ?? '').trim()
      updateSource(day, existing ? `${extracted.moved}\n\n${existing}` : extracted.moved)
      // Render the target card if that day wasn't already in the stream.
      setDays((current) => current.includes(day) ? current : [...current, day].sort((left, right) => right.localeCompare(left)))
      return
    }
    const note = namedDocsRef.current[targetId.slice(5)]
    if (!note) return
    const existing = note.markdown.trim()
    updateNoteMarkdown(note.id, existing ? `${extracted.moved}\n\n${existing}` : extracted.moved)
  }

  async function generateRecoveryPhrase() {
    const phrase = createRecoveryPhrase()
    setRecoveryPhrase(phrase)
    try {
      await navigator.clipboard.writeText(phrase)
      setSyncMessage('Random recovery phrase copied to the clipboard.')
    } catch {
      setSyncMessage('Phrase generated, but it could not be copied automatically.')
    }
  }

  async function copyRecoveryPhrase() {
    if (!recoveryPhrase) return
    try {
      await navigator.clipboard.writeText(recoveryPhrase)
      setSyncMessage('Recovery phrase copied to the clipboard.')
    } catch {
      setSyncMessage('Could not copy the recovery phrase.')
    }
  }

  async function signIn() {
    setSyncState('working')
    setSyncMessage('Opening Google sign-in in your browser…')
    try {
      await signInWithGoogle()
      setSyncState('ready')
      setSyncMessage('Signed in with Google.')
    } catch (error) {
      setSyncState('error')
      const details = typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error)
      setSyncMessage(details || 'Google sign-in failed.')
    }
  }

  async function prepareSync() {
    if (!firebaseUser) return
    setSyncState('working')
    try {
      const existingBundle = await loadRemoteKeyBundle(firebaseUser.uid)
      if (!existingBundle) {
        const created = await createRemoteKeyBundle(firebaseUser.uid, recoveryPhrase.trim() ? normalizeRecoveryPhrase(recoveryPhrase) : undefined)
        setDataKey(created.key)
        setRecoveryPhrase(created.recoveryKey)
        storeRecoveryPhrase(firebaseUser.uid, created.recoveryKey)
        setSyncState('ready')
        setSyncMessage('Save this recovery phrase before closing this window.')
        return
      }
      const key = await recoverRemoteDataKey(firebaseUser.uid, normalizeRecoveryPhrase(recoveryPhrase))
      if (!key) throw new Error('No recovery bundle found')
      setDataKey(key)
      storeRecoveryPhrase(firebaseUser.uid, normalizeRecoveryPhrase(recoveryPhrase))
      setSyncState('ready')
      setSyncMessage('Encryption unlocked. You can sync this device.')
    } catch (error) {
      setSyncState('error')
      const errorName = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : ''
      const details = typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error)
      setSyncMessage(errorName === 'OperationError' ? 'This recovery phrase does not match the encryption key for this Google account. Use the original phrase; generating a new one cannot unlock existing data.' : details || 'Could not unlock encryption. Check the recovery phrase.')
    }
  }

  async function syncNow() {
    if (!firebaseUser || !dataKey || !loaded) return
    setSyncState('working')
    try {
      await Promise.all([
        ...Object.entries(documents).map(([day, markdown]) => saveDailyDocument({ day, markdown, updatedAt: Date.now() })),
        ...Object.values(namedDocsRef.current).map((note) => saveNamedDocument(note)),
      ])
      const localDocuments = await listDailyDocuments()
      const localNotes = await listNamedDocuments()
      localDocuments.forEach((document) => uploadingDaysRef.current.set(document.day, document.markdown))
      localNotes.forEach((note) => uploadingNotesRef.current.set(note.id, note.markdown))
      const [result, namedResult] = await Promise.all([
        syncDocuments(firebaseUser.uid, localDocuments, dataKey, { onWriteId: trackOwnWriteId })
          .finally(() => localDocuments.forEach((document) => uploadingDaysRef.current.delete(document.day))),
        syncNamedDocuments(firebaseUser.uid, localNotes, dataKey, { onWriteId: trackOwnWriteId })
          .finally(() => localNotes.forEach((note) => uploadingNotesRef.current.delete(note.id))),
      ])
      dirtyDaysRef.current.clear()
      result.documents.forEach((document) => {
        documentUpdatedAtRef.current[document.day] = document.updatedAt
        if (document.syncBase) {
          syncBasesRef.current[document.day] = document.syncBase
          latestRemoteRef.current[document.day] = document
        }
      })
      result.conflicts.forEach((conflict) => {
        const mergeBase = conflict.base ?? conflict.local.syncBase
        latestRemoteRef.current[conflict.day] = conflict.remote
        if (mergeBase) syncBasesRef.current[conflict.day] = mergeBase
        else delete syncBasesRef.current[conflict.day]
        dirtyDaysRef.current.add(conflict.day)
        persistLocalDocument(conflict.day, conflict.local.markdown, conflict.local.updatedAt, mergeBase)
      })
      dirtyNotesRef.current.clear()
      const localNotesById = new Map(localNotes.map((note) => [note.id, note]))
      namedResult.documents.forEach((note) => { latestRemoteNotesRef.current[note.id] = note })
      namedResult.conflicts.forEach((conflict) => {
        const mergeBase = conflict.base ?? conflict.local.syncBase
        const local = localNotesById.get(conflict.day)
        dirtyNotesRef.current.add(conflict.day)
        if (local) persistNamedDocument({ ...local, syncBase: mergeBase })
      })
      const nextDocuments = Object.fromEntries(result.documents.map((document) => [document.day, document.markdown]))
      documentsRef.current = nextDocuments
      setDocuments(nextDocuments)
      const nextNotes = Object.fromEntries(normalizeLanes(namedResult.documents).map((note) => [note.id, note]))
      namedDocsRef.current = nextNotes
      Object.keys(nextNotes).forEach((id) => pendingNoteWritesRef.current.add(id))
      setNamedDocs(nextNotes)
      const conflicts = [...result.conflicts, ...namedResult.conflicts]
      setSyncConflicts(conflicts)
      setConflictDrafts(Object.fromEntries(conflicts.map((conflict) => [conflict.day, conflict.local.markdown])))
      setSyncState('ready')
      setSyncMessage(conflicts.length ? `${conflicts.length} document${conflicts.length === 1 ? '' : 's'} need conflict resolution.` : `Synced ${result.documents.length + namedResult.documents.length} documents.`)
    } catch {
      setSyncState('error')
      setSyncMessage('Sync failed. Check your Firebase setup and recovery phrase.')
      void notifyMac(preferences.notificationsEnabled, 'Noteses sync failed', 'Encrypted sync could not complete. Open Notes to retry.')
    }
  }

  async function deleteCloudData() {
    if (!firebaseUser) return
    setSyncState('working')
    try {
      await deleteRemoteUserData(firebaseUser.uid)
      syncBasesRef.current = {}
      latestRemoteRef.current = {}
      dirtyDaysRef.current.clear()
      ownWriteIdsRef.current.clear()
      latestRemoteNotesRef.current = {}
      dirtyNotesRef.current.clear()
      pendingNoteWritesRef.current.clear()
      await clearSyncBases()
      await clearNamedSyncBases()
      const clearedNotes = Object.fromEntries(Object.values(namedDocsRef.current).map((note) => {
        const next = { ...note }
        delete next.syncBase
        delete next.syncedMeta
        return [note.id, next]
      }))
      namedDocsRef.current = clearedNotes
      setNamedDocs(clearedNotes)
      setDataKey(undefined)
      setRecoveryPhrase('')
      localStorage.removeItem(recoveryPhraseStorageKey(firebaseUser.uid))
      setDeleteCloudDataOpen(false)
      setSyncState('ready')
      setSyncMessage('Cloud notes and encryption key deleted. Local notes were kept.')
    } catch (error) {
      setSyncState('error')
      const details = typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error)
      setSyncMessage(details || 'Could not delete cloud data.')
    }
  }

  async function resolveConflict(conflict: SyncConflict, choice: 'local' | 'remote' | 'append' | 'merged') {
    if (!firebaseUser || !dataKey) return
    if (conflict.family === 'named') {
      await resolveNamedConflict(conflict, choice)
      return
    }
    const syncBase = { markdown: conflict.remote.markdown, updatedAt: conflict.remote.updatedAt }
    const markdown = choice === 'local' ? conflict.local.markdown : choice === 'remote' ? conflict.remote.markdown : choice === 'merged' ? conflictDrafts[conflict.day] ?? conflict.local.markdown : `${conflict.remote.markdown}${conflict.remote.markdown.endsWith('\\n') ? '' : '\\n'}${conflict.local.markdown}`
    setSyncState('working')
    try {
      if (choice === 'remote') {
        syncBasesRef.current[conflict.day] = syncBase
        latestRemoteRef.current[conflict.day] = conflict.remote
        dirtyDaysRef.current.delete(conflict.day)
        documentUpdatedAtRef.current[conflict.day] = conflict.remote.updatedAt
        setDocumentMarkdown(conflict.day, conflict.remote.markdown)
        persistLocalDocument(conflict.day, conflict.remote.markdown, conflict.remote.updatedAt, syncBase)
      } else {
        const document = { day: conflict.day, markdown, updatedAt: currentTimestamp(), syncBase }
        uploadingDaysRef.current.set(conflict.day, markdown)
        const result = await uploadEncryptedDocument(firebaseUser.uid, document, dataKey, { strategy: 'replace', onWriteId: trackOwnWriteId })
          .finally(() => { uploadingDaysRef.current.delete(conflict.day) })
        if (result.status === 'conflict') {
          handleUploadConflict(result.conflict)
          return
        }
        const committed = result.document
        syncBasesRef.current[conflict.day] = committed.syncBase ?? { markdown: committed.markdown, updatedAt: committed.updatedAt }
        latestRemoteRef.current[conflict.day] = committed
        dirtyDaysRef.current.delete(conflict.day)
        documentUpdatedAtRef.current[conflict.day] = committed.updatedAt
        setDocumentMarkdown(conflict.day, committed.markdown)
        persistLocalDocument(conflict.day, committed.markdown, committed.updatedAt, syncBasesRef.current[conflict.day])
      }
      setSyncConflicts((current) => current.filter((currentConflict) => currentConflict.day !== conflict.day))
      setConflictDrafts((current) => { const next = { ...current }; delete next[conflict.day]; return next })
      setSyncState('ready')
      setSyncMessage('Conflict resolved and synced.')
    } catch (error) {
      setSyncState('error')
      setSyncMessage(error instanceof Error ? error.message : 'Could not sync the conflict resolution.')
    }
  }

  // Named-doc conflicts resolve markdown the same way; metadata comes from
  // the live local record (and the latest remote snapshot for 'remote').
  async function resolveNamedConflict(conflict: SyncConflict, choice: 'local' | 'remote' | 'append' | 'merged') {
    if (!firebaseUser || !dataKey) return
    const local = namedDocsRef.current[conflict.day]
    if (!local) {
      clearSyncConflict(conflict.day)
      return
    }
    const remote = latestRemoteNotesRef.current[conflict.day]
    const syncBase = { markdown: conflict.remote.markdown, updatedAt: conflict.remote.updatedAt }
    const markdown = choice === 'local' ? conflict.local.markdown : choice === 'remote' ? conflict.remote.markdown : choice === 'merged' ? conflictDrafts[conflict.day] ?? conflict.local.markdown : `${conflict.remote.markdown}${conflict.remote.markdown.endsWith('\n') ? '' : '\n'}${conflict.local.markdown}`
    setSyncState('working')
    try {
      if (choice === 'remote') {
        const remoteMeta = remote ? namedMeta(remote) : namedMeta(local)
        const next: NamedDocument = { ...local, ...remoteMeta, markdown: conflict.remote.markdown, updatedAt: conflict.remote.updatedAt, syncBase, syncedMeta: remoteMeta }
        if (remote) latestRemoteNotesRef.current[conflict.day] = remote
        dirtyNotesRef.current.delete(conflict.day)
        writeNamedDoc(next)
        persistNamedDocument(next)
      } else {
        const document = { ...local, markdown, updatedAt: currentTimestamp(), syncBase }
        uploadingNotesRef.current.set(conflict.day, markdown)
        const result = await uploadEncryptedNamedDocument(firebaseUser.uid, document, dataKey, { strategy: 'replace', onWriteId: trackOwnWriteId })
          .finally(() => { uploadingNotesRef.current.delete(conflict.day) })
        if (result.status === 'conflict') {
          handleUploadNoteConflict(result.conflict)
          return
        }
        const committed = result.document
        const committedMeta = namedMeta(committed)
        const next: NamedDocument = { ...local, ...committedMeta, markdown: committed.markdown, updatedAt: committed.updatedAt, syncBase: committed.syncBase ?? { markdown: committed.markdown, updatedAt: committed.updatedAt }, syncedMeta: committedMeta }
        latestRemoteNotesRef.current[conflict.day] = committed
        dirtyNotesRef.current.delete(conflict.day)
        writeNamedDoc(next)
        persistNamedDocument(next)
      }
      clearSyncConflict(conflict.day)
      setSyncState('ready')
      setSyncMessage('Conflict resolved and synced.')
    } catch (error) {
      setSyncState('error')
      setSyncMessage(error instanceof Error ? error.message : 'Could not sync the conflict resolution.')
    }
  }

  function updateShortcut(name: string, value: string) {
    setPreferences((current) => ({ ...current, shortcuts: { ...current.shortcuts, [name]: value } }))
  }

  function renameTag() {
    const oldTag = tagToRename.trim().normalize('NFC')
    const newTag = renamedTag.trim().normalize('NFC')
    if (!oldTag || !newTag || oldTag === newTag) return
    const next = Object.fromEntries(Object.entries(documentsRef.current).map(([day, markdown]) => {
      const renamed = renameTagEverywhere(markdown, oldTag, newTag)
      if (renamed !== markdown) {
        documentUpdatedAtRef.current[day] = currentTimestamp()
        dirtyDaysRef.current.add(day)
      }
      return [day, renamed]
    }))
    documentsRef.current = next
    setDocuments(next)
    commitNamedDocuments(Object.values(namedDocsRef.current).map((note) => {
      const renamed = renameTagEverywhere(note.markdown, oldTag, newTag)
      return renamed === note.markdown ? note : { ...note, markdown: renamed }
    }))
    setTagToRename('')
    setRenamedTag('')
  }

  function exportMarkdown(day: string) {
    downloadMarkdown(documents[day] ?? '', `${day}.md`)
  }

  function exportAllMarkdown() {
    const daySections = Object.entries(documents).filter(([, markdown]) => markdown).sort(([left], [right]) => left.localeCompare(right)).map(([day, markdown]) => `# ${formatLogicalDay(day, preferences.dateFormat)}\n\n${markdown}`)
    const noteSections = sortedNotes.filter((note) => note.markdown || note.title).map((note) => `# ${note.title || 'Untitled note'}\n\n${note.markdown}`)
    downloadMarkdown([...daySections, ...noteSections].join('\n\n---\n\n'), 'notes.md')
  }

  function jumpToToday() {
    todayRef.current?.scrollIntoView({ block: 'start' })
  }

  function openFutureDay(day: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || day <= today) return
    storeFutureDay(day)
    setDays((current) => current.includes(day) ? current : [day, ...current])
    setDocuments((current) => day in current ? current : { ...current, [day]: '' })
    window.setTimeout(() => document.querySelector(`[data-day="${day}"]`)?.scrollIntoView({ block: 'start' }), 0)
  }

  function reloadApp() {
    window.location.reload()
  }

  async function installPwa() {
    if (!installPrompt) return
    await installPrompt.prompt()
    await installPrompt.userChoice
    setInstallPrompt(undefined)
  }

  async function previewImport() {
    try {
      const result = isTauriEnvironment()
        ? { documents: await invoke<ImportedBackupDocument[]>('read_backup', { root: preferences.backupFolder }), invalid: [] }
        : await readBackupDirectory(await pickBackupDirectory())
      setImportChoices(Object.fromEntries(result.documents.filter((document) => document.day in documents).map((document) => [document.day, 'local'])))
      setImportPreview(result)
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'Could not read the backup folder.')
    }
  }

  async function applyImport() {
    if (!importPreview) return
    const imported = new Map(importPreview.documents.map((document) => [document.day, document.markdown]))
    const next = importMode === 'replace' ? {} : { ...documents }
    imported.forEach((markdown, day) => {
      const choice = importChoices[day] ?? 'imported'
      if (importMode === 'replace' || !(day in documents) || choice === 'imported') next[day] = markdown
      else if (choice === 'append' && next[day] !== markdown && markdown) next[day] = `${next[day]}${next[day].endsWith('\\n') ? '' : '\\n'}\\n${markdown}`
      documentUpdatedAtRef.current[day] = currentTimestamp()
      dirtyDaysRef.current.add(day)
    })
    await replaceDailyDocuments(Object.entries(next).filter(([, markdown]) => markdown).map(([day, markdown]) => ({ day, markdown, updatedAt: documentUpdatedAtRef.current[day] ?? currentTimestamp() })))
    documentsRef.current = next
    setDocuments(next)
    setDays((current) => [...new Set([...Object.keys(next), ...current])].sort((left, right) => right.localeCompare(left)))
    setImportPreview(undefined)
  }

  function executeCommand(command: string) {
    setCommandPaletteOpen(false)
    setCommandQuery('')
    setCommandIndex(0)
    if (command === 'today') jumpToToday()
    if (command === 'search') setSearchOpen(true)
    if (command === 'settings') setSettingsOpen(true)
    if (command === 'sync') void syncNow()
    if (command === 'backup') void performBackup()
    if (command === 'import') void previewImport()
    if (command === 'future') setFutureDateInput(shiftLogicalDay(today, 1))
    if (command === 'export') exportAllMarkdown()
  }

  const commandItems = [
    ['today', 'Jump to today'], ['future', 'Show future days'], ['search', 'Search notes'], ['settings', 'Open settings'],
    ['sync', 'Sync now'], ...(isTauriEnvironment() ? [['backup', 'Backup now']] : []), ['import', 'Import backup'], ['export', 'Export all notes'],
  ].filter(([, label]) => label.toLocaleLowerCase().includes(commandQuery.toLocaleLowerCase()))

  const syncPrompt = !firebaseConfigured
    ? 'Cloud sync is not enabled. Configure Firebase to sign in and sync your notes.'
    : firebaseUser && !dataKey && syncState !== 'working'
      ? 'You are signed in, but encrypted sync is not enabled on this device. Open Settings to unlock it.'
      : ''

  if (!loaded || authLoading) return <main className="loading-screen">{!loaded ? 'Opening your notes…' : 'Checking your sign-in…'}</main>

  return (
    <main className={`${captureMode ? 'capture-shell' : 'app-shell'}${!isTauriEnvironment() ? ' web-shell' : ''}${!captureMode && !isTauriEnvironment() && isMobileKeyboardDevice() ? ' mobile-browser' : ''}${!captureMode && isIosPwa() ? ' ios-pwa' : ''} theme-${preferences.theme}${preferences.compactSpacing ? ' compact-spacing' : ''} font-${preferences.fontChoice}${captureMode && !captureFocused ? ' capture-unfocused' : ''}`} style={{ '--editor-zoom': isMobileKeyboardDevice() ? 1 : preferences.zoomLevel / 100, opacity: isTauriEnvironment() && preferences.windowOpacityEnabled ? preferences.windowOpacity / 100 : 1 } as CSSProperties}>
      {!captureMode && <header className="topbar">
        <div className="topbar-left" />
        <div className="topbar-right">
          <button className="search-button" type="button" aria-label="Search" aria-expanded={searchOpen} onClick={() => setSearchOpen((open) => !open)}>⌕</button>
          {!isOnline && <OfflineIndicator />}
          <button className={`filter-button icon-button${filterTags.length || hideMutedLines ? ' filter-active' : ''}`} type="button" aria-label="Filter by tag" aria-expanded={filterOpen} onClick={() => setFilterOpen((open) => !open)}><FilterIcon active={filterTags.length > 0 || hideMutedLines} /></button>
          <button className="icon-button" type="button" aria-label="Open menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>☰</button>
          {saveState === 'saving' && <span className="save-spinner" role="status" aria-label="Saving" />}
        </div>
        {menuOpen && <nav className="menu-panel" aria-label="Noteses menu">
          <button type="button" onClick={() => { setSearchOpen(true); setMenuOpen(false) }}>Search</button>
          <button type="button" onClick={() => { setCommandPaletteOpen(true); setMenuOpen(false) }}>Command palette</button>
          <button type="button" onClick={() => { setFutureDateInput(shiftLogicalDay(today, 1)); setMenuOpen(false) }}>Write a future note</button>
          <button type="button" onClick={() => { setSettingsOpen(true); setMenuOpen(false) }}>Settings</button>
          <button type="button" onClick={() => { setMenuOpen(false); reloadApp() }}>Reload app</button>
          <button type="button" onClick={() => { setShortcutHelpOpen(true); setMenuOpen(false) }}>Keyboard shortcuts</button>
          <button type="button" onClick={() => { setTagsOpen(true); setMenuOpen(false) }}>Tags</button>
          <button type="button" onClick={() => { exportMarkdown(today); setMenuOpen(false) }}>Export today</button>
          <button type="button" onClick={() => { exportAllMarkdown(); setMenuOpen(false) }}>Export all</button>
          <button type="button" onClick={() => { jumpToToday(); setMenuOpen(false) }}>Jump to today</button>
          <button type="button" onClick={() => { updateSource(today, SAMPLE); setMenuOpen(false) }}>Reset today</button>
          <p className="menu-build">{buildTimeLabel}</p>
        </nav>}
        {filterOpen && <div className="filter-panel" role="dialog" aria-label="Filter notes by tag"><button className="filter-clear" type="button" onClick={() => { setFilterTags([]); setHideMutedLines(false) }} disabled={!filterTags.length && !hideMutedLines}>Clear filters</button><label className="filter-option"><input type="checkbox" checked={hideMutedLines} onChange={(event) => setHideMutedLines(event.target.checked)} />Hide muted lines</label><div className="filter-divider" /><span className="filter-heading">Tags</span>{allTags.length ? allTags.map((tag) => <label className="filter-option" key={tag}><input type="checkbox" checked={filterTags.includes(tag)} onChange={(event) => setFilterTags((current) => event.target.checked ? [...current, tag] : current.filter((value) => value !== tag))} />{tag}</label>) : <span className="filter-empty">No tags yet.</span>}</div>}
      </header>}
      {captureMode && <div className="capture-menu">
        {!isOnline && <OfflineIndicator />}
        <button className={`filter-button icon-button${filterTags.length || hideMutedLines ? ' filter-active' : ''}`} type="button" aria-label="Filter by tag" aria-expanded={filterOpen} onClick={() => setFilterOpen((open) => !open)}><FilterIcon active={filterTags.length > 0 || hideMutedLines} /></button>
        <button className="icon-button" type="button" aria-label="Open quick entry menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>☰</button>
        {menuOpen && <nav className="menu-panel" aria-label="Quick entry menu">
          <button type="button" onClick={() => { setSearchOpen(true); setMenuOpen(false) }}>Search</button>
          <button type="button" onClick={() => { setCommandPaletteOpen(true); setMenuOpen(false) }}>Command palette</button>
          <button type="button" onClick={() => { setFutureDateInput(shiftLogicalDay(today, 1)); setMenuOpen(false) }}>Write a future note</button>
          <button type="button" onClick={() => { setSettingsOpen(true); setMenuOpen(false) }}>Settings</button>
          <button type="button" onClick={() => { setMenuOpen(false); reloadApp() }}>Reload app</button>
          <button type="button" onClick={() => { setShortcutHelpOpen(true); setMenuOpen(false) }}>Keyboard shortcuts</button>
          <button type="button" onClick={() => { setTagsOpen(true); setMenuOpen(false) }}>Tags</button>
          <button type="button" onClick={() => { exportMarkdown(today); setMenuOpen(false) }}>Export today</button>
          <button type="button" onClick={() => { exportAllMarkdown(); setMenuOpen(false) }}>Export all</button>
          <button type="button" onClick={() => { jumpToToday(); setMenuOpen(false) }}>Jump to today</button>
          <button type="button" onClick={() => { updateSource(today, SAMPLE); setMenuOpen(false) }}>Reset today</button>
          <span className="shortcut-hint">Ctrl⌥N to show or hide</span>
          {isTauriEnvironment() && <span className="shortcut-hint">⌃⌥⌘T toggles the todo window</span>}
          <p className="menu-build">{buildTimeLabel}</p>
        </nav>}
        {filterOpen && <div className="filter-panel capture-filter-panel" role="dialog" aria-label="Filter notes by tag"><button className="filter-clear" type="button" onClick={() => { setFilterTags([]); setHideMutedLines(false) }} disabled={!filterTags.length && !hideMutedLines}>Clear filters</button><label className="filter-option"><input type="checkbox" checked={hideMutedLines} onChange={(event) => setHideMutedLines(event.target.checked)} />Hide muted lines</label><div className="filter-divider" /><span className="filter-heading">Tags</span>{allTags.length ? allTags.map((tag) => <label className="filter-option" key={tag}><input type="checkbox" checked={filterTags.includes(tag)} onChange={(event) => setFilterTags((current) => event.target.checked ? [...current, tag] : current.filter((value) => value !== tag))} />{tag}</label>) : <span className="filter-empty">No tags yet.</span>}</div>}
      </div>}
      {searchOpen && <section className="search-panel"><span className="search-symbol">⌕</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your notes" aria-label="Search your notes" onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); advanceFind(event.shiftKey ? -1 : 1) } }} />{findActive && <span className="search-count">{findMatchCount ? `${Math.max(1, findIndex + 1)} of ${findMatchCount}` : 'No matches'}</span>}{findActive ? <><button className="find-nav" type="button" aria-label="Previous match" onClick={() => advanceFind(-1)}>‹</button><button className="find-nav" type="button" aria-label="Next match" onClick={() => advanceFind(1)}>›</button></> : null}</section>}
      {futureDateInput && <section className="future-day-panel" role="dialog" aria-label="Open a future day"><label>Future day <input type="date" value={futureDateInput} onChange={(event) => setFutureDateInput(event.target.value)} /></label><button type="button" onClick={() => { openFutureDay(futureDateInput); setFutureDateInput('') }}>Open</button><button type="button" onClick={() => setFutureDateInput('')}>Cancel</button></section>}
      {futureNotice && futureNoticeDay && <div className="future-notice" role="status">{futureNotice}<button type="button" onClick={() => setFutureNotice(undefined)}>Dismiss</button><button type="button" onClick={() => { localStorage.removeItem(`notes-future-notice:${futureNoticeDay}`); localStorage.setItem(`notes-future-notice:${futureNoticeDay}:snooze`, String(Date.now() + 24 * 60 * 60 * 1000)); setFutureNotice(undefined) }}>Snooze 1 day</button></div>}
      {importPreview && <div className="modal-backdrop" role="presentation"><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="import-title"><div className="modal-heading"><div><span className="eyebrow">Data</span><h2 id="import-title">Review backup import</h2></div><button className="modal-close" type="button" onClick={() => setImportPreview(undefined)}>×</button></div><p className="settings-help">{importPreview.documents.length} Markdown days found; {importPreview.invalid.length} files ignored. Importing can change local notes.</p>{importPreview.documents.filter((document) => document.day in documents).map((document) => <label className="settings-row import-collision" key={document.day}><span className="settings-label">{formatLogicalDay(document.day, preferences.dateFormat)} collision</span><select value={importChoices[document.day] ?? 'local'} onChange={(event) => setImportChoices((current) => ({ ...current, [document.day]: event.target.value as 'local' | 'imported' | 'append' }))}><option value="local">Keep local</option><option value="imported">Keep imported</option><option value="append">Append imported</option></select></label>)}<label className="settings-row"><span className="settings-label">Import mode</span><select value={importMode} onChange={(event) => setImportMode(event.target.value as 'additive' | 'replace')}><option value="additive">Add missing and append collisions</option><option value="replace">Replace all local notes</option></select></label><div className="sync-conflict-actions"><button className="settings-action" type="button" onClick={applyImport}>Import and continue</button><button className="settings-action" type="button" onClick={() => setImportPreview(undefined)}>Cancel</button></div></section></div>}
      {!firebaseConfigured ? <p className="sync-prompt" role="status">{syncPrompt}</p> : !firebaseUser && !preferences.syncPromptDismissed ? <p className="sync-prompt" role="status"><button className="sync-prompt-link" type="button" onClick={() => { void signIn() }}>Sign in with Google</button> to enable encrypted sync.<button className="sync-prompt-close" type="button" aria-label="Dismiss sync prompt" onClick={() => setPreferences((current) => ({ ...current, syncPromptDismissed: true }))}>×</button></p> : syncPrompt && <p className="sync-prompt" role="status">{syncPrompt}</p>}

      <div className="notes-layout lane-viewport" ref={laneViewportRef} onScroll={handleLaneScroll}>
      <section className={`lane${activeLane === 0 ? ' lane-active' : ''}`} data-lane={0} aria-label="Daily lane">
        <section className="day-stream" aria-label="Daily notes">
          {days.filter((documentDay) => (filterTags.length || effectiveHideMuted ? sourceMatchesFilter(documents[documentDay] ?? '', filterTags, effectiveHideMuted) : documentDay === today || preferences.showEmptyDays || documents[documentDay])).map((documentDay) => {
            const source = documents[documentDay] ?? ''
            const parsed = parseMarkdown(source)
            return <article className="day-card" data-day={documentDay} data-weekday={new Date(`${documentDay}T12:00:00`).getDay()} key={documentDay} ref={documentDay === today ? todayRef : undefined}>
              <div className="editor-card">
                <h1 className="day-title">{formatLogicalDay(documentDay, preferences.dateFormat)}</h1>
                <MdxNotesEditor value={source} onChange={(markdown) => updateSource(documentDay, markdown)} autoFocus={captureMode && documentDay === today} hideMutedLines={effectiveHideMuted} tagColors={tagColors} findActive={findActive} />

                {parsed.diagnostics.length > 0 && <div className="diagnostics">{parsed.diagnostics.map((diagnostic) => <div key={`${diagnostic.line}-${diagnostic.message}`}>Line {diagnostic.line + 1}: {diagnostic.message}</div>)}</div>}
              </div>
            </article>
          })}
          <div className="stream-sentinel" ref={streamEndRef} aria-hidden="true" />
        </section>
      </section>
      {[...lanes.keys()].sort((a, b) => a - b).map((lane) => {
        const laneNotes = lanes.get(lane) ?? []
        return <section className={`lane${activeLane === lane ? ' lane-active' : ''}`} key={lane} data-lane={lane} aria-label={`Notes lane ${lane}`}>
          <div className="note-stream">
            {laneNotes.filter((note) => filterTags.length || effectiveHideMuted ? sourceMatchesFilter(note.markdown, filterTags, effectiveHideMuted) : true).map((note) => (
              <NoteCard key={note.id} note={note} laneCount={laneCount} laneSize={laneNotes.length} hideMutedLines={effectiveHideMuted} tagColors={tagColors} findActive={findActive} onChange={updateNoteMarkdown} onRename={renameNote} onToggleCollapsed={toggleNoteCollapsed} onMoveNote={moveNote} onReorderPreview={reorderNotePreview} onReorderCommit={commitNoteReorder} onDelete={deleteNote} />
            ))}
            <button className="lane-add" type="button" onClick={() => createNote(lane)}>+ New note</button>
          </div>
        </section>
      })}
      <section className={`lane lane-ghost${activeLane === laneCount + 1 ? ' lane-active' : ''}`} data-lane={laneCount + 1} aria-label="New lane">
        <div className="note-stream note-stream-ghost">
          <button className="lane-add" type="button" onClick={() => createNote(laneCount + 1)}>+ New note</button>
          <p className="lane-ghost-hint">New lane</p>
        </div>
      </section>
      </div>
      <nav className="lane-dots" aria-label="Lanes">
        {Array.from({ length: totalLanes }, (_, index) => (
          <button key={index} type="button" className={`lane-dot${index === activeLane ? ' lane-dot-active' : ''}`} aria-label={index === 0 ? 'Daily notes' : index === totalLanes - 1 ? 'New lane' : `Notes lane ${index}`} aria-current={index === activeLane ? 'true' : undefined} onClick={() => goToLane(index)}>{index === totalLanes - 1 ? '+' : '•'}</button>
        ))}
      </nav>

      {updateAvailable && <div className="update-toast" role="status"><span>A new version is available.</span><button type="button" onClick={() => window.location.reload()}>Reload</button></div>}

      {moveRequest && <MoveLinesDialog lineCount={moveRequest.endLine - moveRequest.startLine + 1} targets={moveTargets} onSelect={moveLinesTo} onClose={() => setMoveRequest(null)} />}

      {commandPaletteOpen && <div className="modal-backdrop command-palette-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setCommandPaletteOpen(false) }}>
        <section className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette"><input autoFocus value={commandQuery} onChange={(event) => { setCommandQuery(event.target.value); setCommandIndex(0) }} placeholder="Type a command…" onKeyDown={(event) => { if (event.key === 'Escape') setCommandPaletteOpen(false); if (event.key === 'ArrowDown') { event.preventDefault(); setCommandIndex((index) => Math.min(index + 1, commandItems.length - 1)) }; if (event.key === 'ArrowUp') { event.preventDefault(); setCommandIndex((index) => Math.max(index - 1, 0)) }; if (event.key === 'Enter' && commandItems[commandIndex]) executeCommand(commandItems[commandIndex][0]) }} />{commandItems.map(([key, label], index) => <button className={index === commandIndex ? 'command-selected' : ''} type="button" key={key} onClick={() => executeCommand(key)}>{label}</button>)}</section>
      </div>}

      {shortcutHelpOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setShortcutHelpOpen(false) }}>
        <section className="settings-modal shortcut-help-modal" role="dialog" aria-modal="true" aria-labelledby="shortcut-help-title">
          <div className="modal-heading"><div><span className="eyebrow">Keyboard</span><h2 id="shortcut-help-title">Keyboard shortcuts</h2></div><button className="modal-close" type="button" aria-label="Close keyboard shortcuts" onClick={() => setShortcutHelpOpen(false)}>×</button></div>
          <div className="shortcut-help-list">{Object.entries(SHORTCUT_LABELS).map(([name, label]) => <div className="shortcut-help-row" key={name}><span>{label}</span><kbd>{formatShortcut(preferences.shortcuts[name] ?? '')}</kbd></div>)}{BUILTIN_SHORTCUTS.map(([shortcut, label]) => <div className="shortcut-help-row" key={shortcut}><span>{label}</span><kbd>{formatShortcut(shortcut)}</kbd></div>)}</div>
        </section>
      </div>}

      {onboardingOpen && !captureMode && <div className="modal-backdrop" role="presentation"><section className="settings-modal onboarding-modal" role="dialog" aria-modal="true" aria-labelledby="onboarding-title"><div className="modal-heading"><div><span className="eyebrow">Welcome</span><h2 id="onboarding-title">Set up Notes</h2></div></div><p className="settings-description">Notes works offline first. Your notes stay on this device unless you choose encrypted cloud sync.</p><ol className="onboarding-list"><li>{appInstalled ? 'Notes is installed on this device.' : installPrompt ? 'Install Notes for quick offline access.' : 'On iPhone/iPad, use Safari Share → Add to Home Screen. On desktop, use your browser’s install option when available.'}</li><li>Sign in with Google in Settings if you want cloud sync.</li><li>Create or enter your recovery phrase to unlock encrypted sync.</li></ol>{installPrompt && !appInstalled && <button className="settings-action" type="button" onClick={() => { void installPwa() }}>Install Notes</button>}<button className="settings-action" type="button" onClick={() => { setOnboardingOpen(false); setPreferences((current) => ({ ...current, onboardingDismissed: true })) }}>Continue to Notes</button><button className="settings-link" type="button" onClick={() => { setOnboardingOpen(false); setSettingsOpen(true) }}>Open sync settings</button></section></div>}

      {settingsOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setSettingsOpen(false) }}>
        <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title">
          <div className="modal-heading"><div><span className="eyebrow">Preferences</span><h2 id="settings-modal-title">Settings</h2></div><button className="modal-close" type="button" aria-label="Close settings" onClick={() => setSettingsOpen(false)}>×</button></div>
          <fieldset className="settings-group"><legend>Editor</legend>
            <label className="settings-row settings-range-row"><span className="settings-label">Zoom</span><span className="settings-range-control"><input type="range" min="60" max="150" step="10" value={preferences.zoomLevel} onChange={(event) => setPreferences((current) => ({ ...current, zoomLevel: Number(event.target.value) }))} /><output>{preferences.zoomLevel}%</output></span></label>
            <label className="settings-row"><span className="settings-label">Font choice</span><select value={preferences.fontChoice} onChange={(event) => setPreferences((current) => ({ ...current, fontChoice: event.target.value as Preferences['fontChoice'] }))}><option value="system">System sans-serif</option><option value="serif">Serif</option><option value="monospace">Monospace</option></select></label>
          </fieldset>

          <fieldset className="settings-group"><legend>Daily notes</legend>
            <label className="settings-row"><span className="settings-label">Day rollover time</span><select value={preferences.rolloverHour} onChange={(event) => { const rolloverHour = Number(event.target.value); setPreferences((current) => ({ ...current, rolloverHour })); const nextToday = logicalDayKey(new Date(), rolloverHour); setDays([nextToday, shiftLogicalDay(nextToday, -1)]) }}><option value={0}>Midnight (12:00 AM)</option><option value={1}>1:00 AM</option><option value={2}>2:00 AM</option><option value={3}>3:00 AM</option><option value={4}>4:00 AM</option><option value={5}>5:00 AM</option></select></label>
            <label className="settings-row"><span className="settings-label">Show empty days</span><input type="checkbox" checked={preferences.showEmptyDays} onChange={(event) => setPreferences((current) => ({ ...current, showEmptyDays: event.target.checked }))} /></label>
            <label className="settings-row"><span className="settings-label">Date display format</span><select value={preferences.dateFormat} onChange={(event) => setPreferences((current) => ({ ...current, dateFormat: event.target.value as Preferences['dateFormat'] }))}><option value="long">Monday, September 2, 2026</option><option value="long-short">Monday, Sep 2</option><option value="weekday-month">Mon, September 2</option><option value="short">Sep 2, 2026</option><option value="month-day">September 2</option><option value="iso">2026-09-02</option><option value="numeric">09/02/2026</option></select></label>
          </fieldset>

          <fieldset className="settings-group"><legend>Appearance</legend>
            <label className="settings-row"><span className="settings-label">Dark/light mode</span><select value={preferences.theme} onChange={(event) => setPreferences((current) => ({ ...current, theme: event.target.value === 'dark' ? 'dark' : 'light' }))}><option value="light">Light</option><option value="dark">Dark</option></select></label>
            <label className="settings-row"><span className="settings-label">Compact spacing</span><input type="checkbox" checked={preferences.compactSpacing} onChange={(event) => setPreferences((current) => ({ ...current, compactSpacing: event.target.checked }))} /></label>
          </fieldset>

          <fieldset className="settings-group"><legend>Cloud sync</legend>
            <p className="settings-help">Notes stores your working copy locally in IndexedDB. Cloud notes are encrypted before upload.</p>
            <div className="settings-status"><strong>Local notes</strong><span>{Object.values(documents).filter(Boolean).length} non-empty days, from {oldestDocumentDay}</span><strong>Cloud sync</strong><span>{!firebaseConfigured ? 'Not configured' : !firebaseUser ? 'Signed out' : dataKey ? 'Encrypted sync enabled' : 'Signed in — recovery phrase needed'}</span>{isTauriEnvironment() && <><strong>Backup</strong><span>{preferences.backupFrequency === 'off' ? 'Disabled on this device' : backupState === 'error' ? 'Last backup failed' : lastBackupAt ? `Last saved ${new Date(lastBackupAt).toLocaleString()}` : preferences.backupFolder ? 'No backups found' : 'No folder chosen'}</span></>}</div>
            {!firebaseConfigured ? <p className="settings-help">Add the VITE_FIREBASE_* values from FIREBASE_SETUP.md to enable Google sign-in and encrypted sync.</p> : !firebaseUser ? <><button className="settings-action" type="button" onClick={() => { void signIn() }} disabled={syncState === 'working'}>{syncState === 'working' ? 'Opening Google…' : 'Sign in with Google'}</button>{syncMessage && <p className="settings-help sync-error">{syncMessage}</p>}</> : <>
              <p className="settings-help">Signed in as {firebaseUser.email || firebaseUser.displayName || 'Google user'}.</p>
              {!dataKey && <><div className="settings-row"><span className="settings-label">Recovery phrase <button className="settings-link" type="button" onClick={() => { void generateRecoveryPhrase() }}>Generate random phrase</button></span><input value={recoveryPhrase} onChange={(event) => setRecoveryPhrase(event.target.value)} placeholder="12 words" autoComplete="off" /></div><button className="settings-action" type="button" onClick={() => { void prepareSync() }}>Unlock encrypted sync</button></>}
              {!dataKey && !recoveryPhrase && <p className="settings-help">Write down the displayed recovery phrase and keep it private. It cannot be reset.</p>}
              <div className="cloud-actions"><div>{dataKey && <button className="settings-action" type="button" onClick={() => { void syncNow() }} disabled={syncState === 'working'}>{syncState === 'working' ? 'Syncing…' : 'Sync now'}</button>}{dataKey && recoveryPhrase && <button className="settings-action" type="button" onClick={() => { void copyRecoveryPhrase() }}>Copy recovery phrase</button>}</div><div>{!deleteCloudDataOpen ? <button className="settings-danger-action" type="button" onClick={() => setDeleteCloudDataOpen(true)}>Delete cloud data</button> : <div className="settings-danger-confirm"><strong>Delete all cloud notes and the encryption key?</strong><p>This cannot be undone. Your local notes will be kept, but they will no longer match the deleted cloud key.</p><div className="settings-danger-actions"><button className="settings-action" type="button" onClick={() => setDeleteCloudDataOpen(false)}>Cancel</button><button className="settings-danger-action" type="button" onClick={() => { void deleteCloudData() }} disabled={syncState === 'working'}>{syncState === 'working' ? 'Deleting…' : 'Permanently delete'}</button></div></div>}<button className="settings-action" type="button" onClick={() => { void signOutOfGoogle(); setDataKey(undefined); setRecoveryPhrase(''); setSyncState('idle'); setSyncMessage(''); setDeleteCloudDataOpen(false) }}>Sign out</button></div></div>
              {syncMessage && <p className="settings-help">{syncMessage}</p>}
            </>}
          </fieldset>

          {isTauriEnvironment() && <fieldset className="settings-group"><legend>Data &amp; backups</legend>
            <label className="settings-row"><span className="settings-label">Automatic backup</span><select value={preferences.backupFrequency} onChange={(event) => setPreferences((current) => ({ ...current, backupFrequency: event.target.value as Preferences['backupFrequency'] }))}><option value="off">Off</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
            <label className="settings-row"><span className="settings-label">Delete backups after</span><select value={preferences.backupRetention} onChange={(event) => setPreferences((current) => ({ ...current, backupRetention: event.target.value as Preferences['backupRetention'] }))}><option value="off">Keep all</option><option value="week">1 week</option><option value="month">1 month</option><option value="three-months">3 months</option></select></label>
            {preferences.backupFrequency !== 'off' && <label className="settings-row"><span className="settings-label">Backup folder</span><button className="settings-action" type="button" onClick={() => { void chooseBackupFolder() }}>{preferences.backupFolder || 'Choose folder'}</button></label>}
            {preferences.backupFrequency !== 'off' && <p className="settings-help" title="A new folder is created each day or week. Changes are written to that folder as they happen, so the current backup stays fresh.">Backups create a new {preferences.backupFrequency === 'weekly' ? 'week' : 'day'} folder and update it after changes; previous periods are kept.{backupState === 'saved' ? ' Last backup saved.' : backupState === 'error' ? ' Backup failed.' : ''}</p>}
          </fieldset>}

          <fieldset className="settings-group"><legend>Notifications</legend>
            <label className="settings-row"><span className="settings-label">Failure notifications</span><input type="checkbox" checked={preferences.notificationsEnabled} onChange={(event) => setPreferences((current) => ({ ...current, notificationsEnabled: event.target.checked }))} /></label>
            {!isTauriEnvironment() && firebaseUser && <div className="settings-row"><span className="settings-label">Ring phone alerts</span><button className="settings-action" type="button" disabled={pushBusy || pushState === 'unsupported' || pushState === 'unconfigured' || pushState === 'denied'} onClick={() => { void togglePush() }}>{pushBusy ? 'Working…' : pushState === 'enabled' ? 'Disable' : 'Enable'}</button></div>}
            {!isTauriEnvironment() && firebaseUser && pushState !== 'unsupported' && <p className="settings-help">{pushState === 'unconfigured' ? 'Ring alerts are not ready yet — the receiver provisions push keys when it next processes a recording.' : pushState === 'denied' ? 'Notifications are blocked for this app — allow them in the device settings.' : 'Sends a notification to this device when a ring recording starts with “notify” or “urgent”.'}</p>}
            <p className="settings-help">macOS notifications will be used for sync and backup failures when native notification support is available.</p>
          </fieldset>

          <fieldset className="settings-group"><legend>Capture mode</legend>
            <label className="settings-row"><span className="settings-label">Global capture shortcut</span><input className="shortcut-input" value={preferences.captureShortcut} onChange={(event) => setPreferences((current) => ({ ...current, captureShortcut: event.target.value }))} onBlur={() => { void invokeNative('set_capture_shortcut', { shortcut: preferences.captureShortcut }) }} /></label>
            <label className="settings-row"><span className="settings-label">Capture window always on top</span><input type="checkbox" checked={preferences.captureAlwaysOnTop} onChange={(event) => { const alwaysOnTop = event.target.checked; setPreferences((current) => ({ ...current, captureAlwaysOnTop: alwaysOnTop })); void invokeNative('set_capture_window_always_on_top', { alwaysOnTop }) }} /></label>
            {isTauriEnvironment() && <label className="settings-row settings-range-row"><span className="settings-label">Window transparency</span><span className="settings-range-control"><input type="range" min="50" max="100" step="5" value={preferences.windowOpacity} onChange={(event) => { const windowOpacity = Number(event.target.value); setPreferences((current) => ({ ...current, windowOpacity, windowOpacityEnabled: windowOpacity < 100 })) }} /><output>{preferences.windowOpacity}%</output></span></label>}
            <label className="settings-row"><span className="settings-label">Launch at login</span><input type="checkbox" checked={preferences.launchAtLogin} onChange={(event) => { const launchAtLogin = event.target.checked; setPreferences((current) => ({ ...current, launchAtLogin })); void invokeNative('set_launch_at_login', { enabled: launchAtLogin }) }} /></label>
            <label className="settings-row"><span className="settings-label">Show in menu bar</span><input type="checkbox" checked={preferences.showMenuBar} onChange={(event) => { const showMenuBar = event.target.checked; if (!showMenuBar && !preferences.showDockIcon) return; setPreferences((current) => ({ ...current, showMenuBar })); void invokeNative('set_app_visibility', { showMenuBar, showDockIcon: preferences.showDockIcon }) }} /></label>
            <label className="settings-row"><span className="settings-label">Show dock icon</span><input type="checkbox" checked={preferences.showDockIcon} onChange={(event) => { const showDockIcon = event.target.checked; if (!showDockIcon && !preferences.showMenuBar) return; setPreferences((current) => ({ ...current, showDockIcon })); void invokeNative('set_app_visibility', { showMenuBar: preferences.showMenuBar, showDockIcon }) }} /></label>
            <p className="settings-help">At least one of “Show in menu bar” and “Show dock icon” must be selected.</p>
          </fieldset>

          {isTauriEnvironment() && <fieldset className="settings-group"><legend>Todo window</legend>
            <p className="settings-help">Notes titled “todo…” also appear in a floating window — toggle or focus it with ⌃⌥⌘T. Multiple todo notes stack alphabetically.</p>
            <label className="settings-row settings-range-row"><span className="settings-label">Todo zoom</span><span className="settings-range-control"><input type="range" min="60" max="150" step="10" value={preferences.todoZoomLevel} onChange={(event) => setPreferences((current) => ({ ...current, todoZoomLevel: Number(event.target.value) }))} /><output>{preferences.todoZoomLevel}%</output></span></label>
            <div className="settings-row"><span className="settings-label">Floating todo window</span><button className="settings-action" type="button" onClick={() => { void invokeNative('toggle_todo_window_command') }}>Show or hide</button></div>
          </fieldset>}

          <fieldset className="settings-group"><legend>Keyboard shortcuts</legend>
            {Object.entries(SHORTCUT_LABELS).map(([name, label]) => <label className="settings-row" key={name}><span className="settings-label">{label}</span><input className={`shortcut-input${shortcutConflicts.has(preferences.shortcuts[name]) ? ' shortcut-conflict' : ''}`} value={formatShortcut(preferences.shortcuts[name] ?? '')} onChange={(event) => updateShortcut(name, parseDisplayedShortcut(event.target.value))} aria-label={`${label} shortcut`} /></label>)}
            {shortcutConflicts.size > 0 && <p className="settings-help shortcut-error">Each shortcut must be unique.</p>}
          </fieldset>

          <fieldset className="settings-group"><legend>Tags</legend>
            <label className="settings-row"><span className="settings-label">Manage known tags</span><button className="settings-action" type="button" onClick={() => { setTagsOpen(true); setSettingsOpen(false) }}>Manage</button></label>
            <p className="settings-help">Rename tags and choose their colors from the known-tags manager.</p>
          </fieldset>
        </section>
      </div>}

      {syncConflicts.length > 0 && <div className="modal-backdrop" role="presentation">
        <section className="settings-modal sync-conflict-modal" role="dialog" aria-modal="true" aria-labelledby="sync-conflict-title">
          <div className="modal-heading"><div><span className="eyebrow">Cloud sync</span><h2 id="sync-conflict-title">Choose which notes to keep</h2></div></div>
          <p className="settings-help">These days were edited both locally and on the server. Choose how to combine each one.</p>
          {syncConflicts.map((conflict) => <div className="sync-conflict" key={`${conflict.family ?? 'daily'}:${conflict.day}`}><strong>{conflict.family === 'named' ? conflict.title || 'Untitled note' : formatLogicalDay(conflict.day, preferences.dateFormat)}</strong><div className="sync-conflict-preview"><div><span>Changed lines</span><div className="diff-viewer">{diffLines(conflict.local.markdown, conflict.remote.markdown).map((row) => <code className={`diff-row diff-${row.kind}`} key={`${row.kind}-${row.index}`}>{row.kind === 'added' ? '+ ' : row.kind === 'removed' ? '− ' : '  '}{row.text || ' '}</code>)}</div></div></div><label className="merge-editor"><span>Editable merged version</span><textarea value={conflictDrafts[conflict.day] ?? conflict.local.markdown} onChange={(event) => setConflictDrafts((current) => ({ ...current, [conflict.day]: event.target.value }))} /></label><div className="sync-conflict-actions"><button className="settings-action" type="button" onClick={() => { void resolveConflict(conflict, 'local') }}>Keep local</button><button className="settings-action" type="button" onClick={() => { void resolveConflict(conflict, 'remote') }}>Keep server</button><button className="settings-action" type="button" onClick={() => { void resolveConflict(conflict, 'append') }}>Append local to server</button><button className="settings-action" type="button" onClick={() => { void resolveConflict(conflict, 'merged') }}>Save merged version</button></div></div>)}
        </section>
      </div>}

      {tagsOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setTagsOpen(false) }}>
        <section className="tag-modal" role="dialog" aria-modal="true" aria-labelledby="tag-modal-title">
          <div className="modal-heading"><div><span className="eyebrow">Organization</span><h2 id="tag-modal-title">Manage known tags</h2></div><button className="modal-close" type="button" aria-label="Close tag manager" onClick={() => setTagsOpen(false)}>×</button></div>
          {allTags.length ? allTags.map((tag) => <label className="color-row" key={tag}><span>{tag}</span><input type="color" aria-label={`Color for ${tag}`} value={tagColors[tag] ?? defaultTagColor(tag)} onChange={(event) => setTagColors((current) => ({ ...current, [tag]: event.target.value }))} /></label>) : <p className="empty-modal">Add a tag to see it here.</p>}
          <div className="tag-rename-form"><label htmlFor="tag-to-rename">Rename a tag everywhere</label><select id="tag-to-rename" value={tagToRename} onChange={(event) => setTagToRename(event.target.value)}><option value="">Choose a tag</option>{allTags.map((tag) => <option key={tag}>{tag}</option>)}</select><input value={renamedTag} onChange={(event) => setRenamedTag(event.target.value)} placeholder="New name" aria-label="New tag name" /><button type="button" onClick={renameTag} disabled={!tagToRename || !renamedTag.trim() || tagToRename === renamedTag.trim()}>Rename</button></div>
        </section>
      </div>}
    </main>
  )
}

function App() {
  if (window.location.pathname === '/prototype') return <MarkdownPrototypePage />
  if (new URLSearchParams(window.location.search).get('mode') === 'todo') return <TodoWindow />
  return <NotesApp />
}

export default App
