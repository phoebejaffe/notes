import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { listen } from '@tauri-apps/api/event'
import { open as openDirectoryDialog } from '@tauri-apps/plugin-dialog'
import { MdxNotesEditor } from './editor/MdxNotesEditor'
import { commentsToTagDirectives } from './editor/tagSyntax'
import { parseMarkdown, renameTagEverywhere, sourceMatchesFilter } from './markerEngine'
import { formatLogicalDay, logicalDayKey, shiftLogicalDay } from './logicalDay'
import { listDailyDocuments, replaceDailyDocuments, saveDailyDocument } from './storage'
import { loadPreferences, savePreferences, type Preferences } from './preferences'
import { backupFolderName, backupRetentionCutoff, backupSignature, cleanupBrowserBackups, pickBackupDirectory, readBackupDirectory, writeBackup, type ImportedBackupDocument } from './backup'
import { diffLines } from './editorCommands'
import { firebaseConfigured, signInWithGoogle, signOutOfGoogle, watchAuth } from './firebase'
import { createRemoteKeyBundle, deleteRemoteUserData, loadRemoteKeyBundle, recoverRemoteDataKey, syncDocuments, uploadEncryptedDocument, watchRemoteDocuments, type SyncConflict } from './firebaseSync'
import { createRecoveryPhrase, normalizeRecoveryPhrase } from './crypto'
import type { User } from 'firebase/auth'
import { MarkdownPrototypePage } from './prototype/MarkdownPrototypePage'
import './App.css'

const SAMPLE = `<!-- therapy 🧠 -->
## Therapy session

I noticed I am more comfortable setting boundaries.

- Practice **bold**, *italic*, and <u>underlined</u> text.
<!-- /therapy -->
<!-- project "spring launch" -->
## Project notes

Draft the onboarding flow and ask Sam for feedback.
<!-- /"spring launch" -->
<!-- therapy -->
A follow-up thought from later in the day.
<!-- /therapy -->`

const DEFAULT_TAG_COLORS = ['#6d9b91', '#8975aa', '#c88968', '#7190b0', '#b28a55']
const SHORTCUT_LABELS = {
  search: 'Search',
  settings: 'Settings',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  jumpToToday: 'Jump to today',
  exportToday: 'Export today',
  strikethrough: 'Strikethrough',
  taskToggle: 'Toggle task',
  toggleMuted: 'Hide muted lines',
  help: 'Show keyboard shortcuts',
  dayPrevious: 'Previous day',
  dayNext: 'Next day',
} as const
const BUILTIN_SHORTCUTS = [
  ['Mod-b', 'Bold'],
  ['Mod-i', 'Italic'],
  ['Mod-u', 'Underline'],
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

function matchesShortcut(event: KeyboardEvent, shortcut: string) {
  const parts = shortcut.toLowerCase().split('-')
  let key = parts.pop() ?? ''
  if (!key && shortcut.endsWith('--')) key = '-'
  const wantsMod = parts.includes('mod')
  const wantsCtrl = parts.includes('ctrl')
  const wantsAlt = parts.includes('alt') || parts.includes('option')
  const wantsShift = parts.includes('shift')
  const modifierMatches = wantsMod ? (/mac/i.test(navigator.platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) : wantsCtrl ? event.ctrlKey && !event.metaKey : !event.ctrlKey && !event.metaKey
  const keyMatches = event.key.toLowerCase() === key || ((key === '/' || key === '?') && event.code === 'Slash')
  return keyMatches && modifierMatches && (wantsAlt ? event.altKey : !event.altKey) && (wantsShift ? event.shiftKey : !event.shiftKey)
}

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
  const [privacyOpen, setPrivacyOpen] = useState(false)
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
  const [rawTextMode, setRawTextMode] = useState(false)
  const [tagColors, setTagColors] = useState<Record<string, string>>(loadTagColors)
  const [query, setQuery] = useState('')
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
  const [syncConflicts, setSyncConflicts] = useState<SyncConflict[]>([])
  const documentUpdatedAtRef = useRef<Record<string, number>>({})
  const documentsRef = useRef<Record<string, string>>({})
  const remoteUpdateRef = useRef(false)
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
    listDailyDocuments().then((stored) => {
      const savedDocuments = Object.fromEntries(stored.map((document) => [document.day, document.markdown]))
      documentUpdatedAtRef.current = Object.fromEntries(stored.map((document) => [document.day, document.updatedAt]))
      if (!(today in savedDocuments)) {
        savedDocuments[today] = ''
      }
      setDocuments(savedDocuments)
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
    void invoke('request_backup_access', { root: preferences.backupFolder }).catch(() => setBackupState('error'))
  }, [loaded, preferences.backupFolder, preferences.backupFrequency])

  const allTags = useMemo(() => [...new Set(Object.values(documents).flatMap((markdown) => parseMarkdown(markdown).ranges.map((range) => range.tag)))].sort((left, right) => left.localeCompare(right)), [documents])
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
      if (entries[0].isIntersecting && !filterTags.length && !hideMutedLines) appendOlderDay()
    }, { root: stream, rootMargin: '0px 0px 800px 0px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [appendOlderDay, filterTags.length, hideMutedLines, loaded])

  useEffect(() => {
    if (!loaded || filterTags.length || hideMutedLines) return
    const sentinel = streamEndRef.current
    const stream = sentinel?.closest<HTMLElement>('.day-stream')
    if (!sentinel || !stream) return
    const distanceFromTop = sentinel.getBoundingClientRect().top - stream.getBoundingClientRect().top
    if (distanceFromTop > stream.clientHeight + 800) return
    appendOlderDay()
  }, [appendOlderDay, days.length, filterTags.length, hideMutedLines, loaded])

  useEffect(() => {
    function handleInterfaceShortcuts(event: KeyboardEvent) {
      if (matchesShortcut(event, preferences.shortcuts.help)) {
        event.preventDefault()
        setShortcutHelpOpen(true)
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
      const direction = matchesShortcut(event, preferences.shortcuts.dayPrevious) ? -1 : matchesShortcut(event, preferences.shortcuts.dayNext) ? 1 : 0
      if (!direction) return
      const activeCard = document.activeElement?.closest('.day-card') as HTMLElement | null
      if (!activeCard) return
      const cards = [...document.querySelectorAll<HTMLElement>('.day-card')]
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
  }, [documents, preferences.shortcuts, today])

  useEffect(() => {
    function closeTransientPanels(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        setSearchOpen(false)
        setFilterOpen(false)
        setSettingsOpen(false)
        setShortcutHelpOpen(false)
        setTagsOpen(false)
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
        const editor = document.querySelector(`[data-day="${today}"] .mdxeditor-root-contenteditable`) as HTMLElement | null
        editor?.focus()
      }, 0)
    }
    function focusTodayIfIdle() {
      if (settingsOpen || tagsOpen) return
      const activeElement = document.activeElement
      if (activeElement && activeElement !== document.body && activeElement !== document.documentElement) return
      focusTodayEditor()
    }
    function handleWindowFocus() {
      setCaptureFocused(true)
      focusTodayIfIdle()
    }
    function handleWindowBlur() {
      setCaptureFocused(false)
    }
    window.addEventListener('focus', handleWindowFocus)
    window.addEventListener('blur', handleWindowBlur)
    let disposed = false
    let unlisten: (() => void) | undefined
    if (isTauriEnvironment()) {
      void listen('quick-entry-focus', focusTodayEditor).then((cleanup) => {
        if (disposed) cleanup()
        else unlisten = cleanup
      })
    }
    return () => {
      disposed = true
      window.removeEventListener('focus', handleWindowFocus)
      window.removeEventListener('blur', handleWindowBlur)
      unlisten?.()
    }
  }, [captureMode, loaded, settingsOpen, tagsOpen, today])

  useEffect(() => {
    if (!loaded) return
    const timer = window.setTimeout(() => {
      setSaveState('saving')
      Promise.all(Object.entries(documents).filter(([, markdown]) => markdown).map(([day, markdown]) => saveDailyDocument({ day, markdown, updatedAt: documentUpdatedAtRef.current[day] ?? Date.now() }))).then(() => setSaveState('saved')).catch(() => setSaveState('saved'))
    }, 350)
    return () => window.clearTimeout(timer)
  }, [documents, loaded])

  useEffect(() => {
    if (!loaded || !firebaseUser || !dataKey) return
    return watchRemoteDocuments(firebaseUser.uid, dataKey, (remoteDocuments) => {
      const updates = remoteDocuments.filter((document) => document.updatedAt > (documentUpdatedAtRef.current[document.day] ?? 0))
      if (!updates.length) return
      remoteUpdateRef.current = true
      updates.forEach((document) => { documentUpdatedAtRef.current[document.day] = document.updatedAt })
      setDocuments((current) => ({ ...current, ...Object.fromEntries(updates.map((document) => [document.day, document.markdown])) }))
      setSyncState('ready')
      setSyncMessage('Cloud changes received.')
    }, (error) => {
      setSyncState('error')
      setSyncMessage(error.message || 'Realtime sync failed.')
    })
  }, [dataKey, firebaseUser, loaded])

  useEffect(() => {
    if (!loaded || !firebaseUser || !dataKey) return
    if (remoteUpdateRef.current) {
      remoteUpdateRef.current = false
      return
    }
    const timer = window.setTimeout(() => {
      const localDocuments = Object.entries(documents).filter(([, markdown]) => markdown).map(([day, markdown]) => ({ day, markdown, updatedAt: documentUpdatedAtRef.current[day] ?? Date.now() }))
      void Promise.all(localDocuments.map((document) => uploadEncryptedDocument(firebaseUser.uid, document, dataKey))).then(() => {
        setSyncState('ready')
        setSyncMessage('Changes synced.')
      }).catch((error: unknown) => {
        setSyncState('error')
        setSyncMessage(error instanceof Error ? error.message : 'Realtime sync failed.')
      })
    }, 600)
    return () => window.clearTimeout(timer)
  }, [dataKey, documents, firebaseUser, loaded])

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
        setPreferences((current) => ({ ...current, backupFolder: selected }))
      } else if (selected) {
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

  const searchResults = useMemo(() => {
    if (!query.trim()) return []
    const needle = query.toLocaleLowerCase()
    return Object.entries(documents).flatMap(([day, markdown]) => parseMarkdown(markdown).lines.flatMap((line, index) => line.toLocaleLowerCase().includes(needle) ? [{ day, line: index + 1, text: line }] : []))
  }, [documents, query])

  function updateSource(day: string, markdown: string) {
    documentUpdatedAtRef.current[day] = currentTimestamp()
    setDocuments((current) => ({ ...current, [day]: markdown }))
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
      await Promise.all(Object.entries(documents).map(([day, markdown]) => saveDailyDocument({ day, markdown, updatedAt: Date.now() })))
      const localDocuments = await listDailyDocuments()
      const result = await syncDocuments(firebaseUser.uid, localDocuments, dataKey)
      result.documents.forEach((document) => { documentUpdatedAtRef.current[document.day] = document.updatedAt })
      setDocuments(Object.fromEntries(result.documents.map((document) => [document.day, document.markdown])))
      setSyncConflicts(result.conflicts)
      setConflictDrafts(Object.fromEntries(result.conflicts.map((conflict) => [conflict.day, conflict.local.markdown])))
      setSyncState('ready')
      setSyncMessage(result.conflicts.length ? `${result.conflicts.length} day${result.conflicts.length === 1 ? '' : 's'} need conflict resolution.` : `Synced ${result.documents.length} day${result.documents.length === 1 ? '' : 's'}.`)
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
    const markdown = choice === 'local' ? conflict.local.markdown : choice === 'remote' ? conflict.remote.markdown : choice === 'merged' ? conflictDrafts[conflict.day] ?? conflict.local.markdown : `${conflict.remote.markdown}${conflict.remote.markdown.endsWith('\\n') ? '' : '\\n'}${conflict.local.markdown}`
    const document = { day: conflict.day, markdown, updatedAt: currentTimestamp() }
    setSyncState('working')
    try {
      await uploadEncryptedDocument(firebaseUser.uid, document, dataKey)
      documentUpdatedAtRef.current[document.day] = document.updatedAt
      setDocuments((current) => ({ ...current, [document.day]: document.markdown }))
      setSyncConflicts((current) => current.filter((currentConflict) => currentConflict.day !== conflict.day))
      setConflictDrafts((current) => { const next = { ...current }; delete next[conflict.day]; return next })
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
    setDocuments((current) => Object.fromEntries(Object.entries(current).map(([day, markdown]) => [day, renameTagEverywhere(markdown, oldTag, newTag)])))
    setTagToRename('')
    setRenamedTag('')
  }

  function exportMarkdown(day: string) {
    downloadMarkdown(documents[day] ?? '', `${day}.md`)
  }

  function exportAllMarkdown() {
    const content = Object.entries(documents).filter(([, markdown]) => markdown).sort(([left], [right]) => left.localeCompare(right)).map(([day, markdown]) => `# ${formatLogicalDay(day, preferences.dateFormat)}\n\n${markdown}`).join('\n\n---\n\n')
    downloadMarkdown(content, 'notes.md')
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
    })
    await replaceDailyDocuments(Object.entries(next).filter(([, markdown]) => markdown).map(([day, markdown]) => ({ day, markdown, updatedAt: documentUpdatedAtRef.current[day] ?? currentTimestamp() })))
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
    if (command === 'privacy') setPrivacyOpen(true)
    if (command === 'sync') void syncNow()
    if (command === 'backup') void performBackup()
    if (command === 'import') void previewImport()
    if (command === 'future') setFutureDateInput(shiftLogicalDay(today, 1))
    if (command === 'export') exportAllMarkdown()
  }

  const commandItems = [
    ['today', 'Jump to today'], ['future', 'Show future days'], ['search', 'Search notes'], ['settings', 'Open settings'], ['privacy', 'Privacy center'],
    ['sync', 'Sync now'], ['backup', 'Backup now'], ['import', 'Import backup'], ['export', 'Export all notes'],
  ].filter(([, label]) => label.toLocaleLowerCase().includes(commandQuery.toLocaleLowerCase()))

  const syncPrompt = !firebaseConfigured
    ? 'Cloud sync is not enabled. Configure Firebase to sign in and sync your notes.'
    : firebaseUser && !dataKey && syncState !== 'working'
      ? 'You are signed in, but encrypted sync is not enabled on this device. Open Settings to unlock it.'
      : ''

  if (!loaded || authLoading) return <main className="loading-screen">{!loaded ? 'Opening your notes…' : 'Checking your sign-in…'}</main>

  return (
    <main className={`${captureMode ? 'capture-shell' : 'app-shell'}${!isTauriEnvironment() ? ' web-shell' : ''}${!captureMode && !isTauriEnvironment() && isMobileKeyboardDevice() ? ' mobile-browser' : ''}${!captureMode && isIosPwa() ? ' ios-pwa' : ''} theme-${preferences.theme}${preferences.compactSpacing ? ' compact-spacing' : ''} font-${preferences.fontChoice}${captureMode && !captureFocused ? ' capture-unfocused' : ''}${rawTextMode ? ' raw-mode' : ''}`} style={{ zoom: isMobileKeyboardDevice() ? 1 : preferences.zoomLevel / 100, opacity: isTauriEnvironment() && preferences.windowOpacityEnabled ? preferences.windowOpacity / 100 : 1 }}>
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
          <button type="button" onClick={() => { setPrivacyOpen(true); setMenuOpen(false) }}>Privacy center</button>
          <button type="button" onClick={() => { setFutureDateInput(shiftLogicalDay(today, 1)); setMenuOpen(false) }}>Write a future note</button>
          <button type="button" onClick={() => { setRawTextMode((raw) => !raw); setMenuOpen(false) }}>{rawTextMode ? 'Rich editor' : 'Raw text mode'}</button>
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
          <button type="button" onClick={() => { setPrivacyOpen(true); setMenuOpen(false) }}>Privacy center</button>
          <button type="button" onClick={() => { setFutureDateInput(shiftLogicalDay(today, 1)); setMenuOpen(false) }}>Write a future note</button>
          <button type="button" onClick={() => { setRawTextMode((raw) => !raw); setMenuOpen(false) }}>{rawTextMode ? 'Rich editor' : 'Raw text mode'}</button>
          <button type="button" onClick={() => { setSettingsOpen(true); setMenuOpen(false) }}>Settings</button>
          <button type="button" onClick={() => { setMenuOpen(false); reloadApp() }}>Reload app</button>
          <button type="button" onClick={() => { setShortcutHelpOpen(true); setMenuOpen(false) }}>Keyboard shortcuts</button>
          <button type="button" onClick={() => { setTagsOpen(true); setMenuOpen(false) }}>Tags</button>
          <button type="button" onClick={() => { exportMarkdown(today); setMenuOpen(false) }}>Export today</button>
          <button type="button" onClick={() => { exportAllMarkdown(); setMenuOpen(false) }}>Export all</button>
          <button type="button" onClick={() => { jumpToToday(); setMenuOpen(false) }}>Jump to today</button>
          <button type="button" onClick={() => { updateSource(today, SAMPLE); setMenuOpen(false) }}>Reset today</button>
          <span className="shortcut-hint">Ctrl⌥N to show or hide</span>
          <p className="menu-build">{buildTimeLabel}</p>
        </nav>}
        {filterOpen && <div className="filter-panel capture-filter-panel" role="dialog" aria-label="Filter notes by tag"><button className="filter-clear" type="button" onClick={() => { setFilterTags([]); setHideMutedLines(false) }} disabled={!filterTags.length && !hideMutedLines}>Clear filters</button><label className="filter-option"><input type="checkbox" checked={hideMutedLines} onChange={(event) => setHideMutedLines(event.target.checked)} />Hide muted lines</label><div className="filter-divider" /><span className="filter-heading">Tags</span>{allTags.length ? allTags.map((tag) => <label className="filter-option" key={tag}><input type="checkbox" checked={filterTags.includes(tag)} onChange={(event) => setFilterTags((current) => event.target.checked ? [...current, tag] : current.filter((value) => value !== tag))} />{tag}</label>) : <span className="filter-empty">No tags yet.</span>}</div>}
      </div>}
      {rawTextMode && <div className="raw-mode-banner" role="status">Raw text mode is on <button type="button" onClick={() => setRawTextMode(false)}>turn off</button></div>}

      {searchOpen && <section className="search-panel"><span className="search-symbol">⌕</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your notes" aria-label="Search your notes" />{query && <span className="search-count">{searchResults.length} matches</span>}</section>}
      {futureDateInput && <section className="future-day-panel" role="dialog" aria-label="Open a future day"><label>Future day <input type="date" value={futureDateInput} onChange={(event) => setFutureDateInput(event.target.value)} /></label><button type="button" onClick={() => { openFutureDay(futureDateInput); setFutureDateInput('') }}>Open</button><button type="button" onClick={() => setFutureDateInput('')}>Cancel</button></section>}
      {futureNotice && futureNoticeDay && <div className="future-notice" role="status">{futureNotice}<button type="button" onClick={() => setFutureNotice(undefined)}>Dismiss</button><button type="button" onClick={() => { localStorage.removeItem(`notes-future-notice:${futureNoticeDay}`); localStorage.setItem(`notes-future-notice:${futureNoticeDay}:snooze`, String(Date.now() + 24 * 60 * 60 * 1000)); setFutureNotice(undefined) }}>Snooze 1 day</button></div>}
      {importPreview && <div className="modal-backdrop" role="presentation"><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="import-title"><div className="modal-heading"><div><span className="eyebrow">Data</span><h2 id="import-title">Review backup import</h2></div><button className="modal-close" type="button" onClick={() => setImportPreview(undefined)}>×</button></div><p className="settings-help">{importPreview.documents.length} Markdown days found; {importPreview.invalid.length} files ignored. Importing can change local notes.</p>{importPreview.documents.filter((document) => document.day in documents).map((document) => <label className="settings-row import-collision" key={document.day}><span className="settings-label">{formatLogicalDay(document.day, preferences.dateFormat)} collision</span><select value={importChoices[document.day] ?? 'local'} onChange={(event) => setImportChoices((current) => ({ ...current, [document.day]: event.target.value as 'local' | 'imported' | 'append' }))}><option value="local">Keep local</option><option value="imported">Keep imported</option><option value="append">Append imported</option></select></label>)}<label className="settings-row"><span className="settings-label">Import mode</span><select value={importMode} onChange={(event) => setImportMode(event.target.value as 'additive' | 'replace')}><option value="additive">Add missing and append collisions</option><option value="replace">Replace all local notes</option></select></label><div className="sync-conflict-actions"><button className="settings-action" type="button" onClick={applyImport}>Import and continue</button><button className="settings-action" type="button" onClick={() => setImportPreview(undefined)}>Cancel</button></div></section></div>}
      {!firebaseConfigured ? <p className="sync-prompt" role="status">{syncPrompt}</p> : !firebaseUser && !preferences.syncPromptDismissed ? <p className="sync-prompt" role="status"><button className="sync-prompt-link" type="button" onClick={() => { void signIn() }}>Sign in with Google</button> to enable encrypted sync.<button className="sync-prompt-close" type="button" aria-label="Dismiss sync prompt" onClick={() => setPreferences((current) => ({ ...current, syncPromptDismissed: true }))}>×</button></p> : syncPrompt && <p className="sync-prompt" role="status">{syncPrompt}</p>}

      <div className="notes-layout">
      <section className="day-stream" aria-label="Daily notes">
        {days.filter((documentDay) => (filterTags.length || hideMutedLines ? sourceMatchesFilter(documents[documentDay] ?? '', filterTags, hideMutedLines) : documentDay === today || preferences.showEmptyDays || documents[documentDay])).map((documentDay) => {
          const source = documents[documentDay] ?? ''
          const parsed = parseMarkdown(source)
          const migratedSource = commentsToTagDirectives(source)
          const hasLegacyTags = migratedSource !== source
          return <article className="day-card" data-day={documentDay} key={documentDay} ref={documentDay === today ? todayRef : undefined}>
            <div className="editor-card">
              <h1 className="day-title">{formatLogicalDay(documentDay, preferences.dateFormat)}</h1>
              {hasLegacyTags && <button className="tag-migration-button" type="button" onClick={() => { if (window.confirm('Migrate this day’s legacy comment tags to Markdown directives?')) updateSource(documentDay, migratedSource) }}>Migrate legacy tags</button>}
              <MdxNotesEditor value={source} onChange={(markdown) => updateSource(documentDay, markdown)} autoFocus={captureMode && documentDay === today} hideMutedLines={hideMutedLines} tagColors={tagColors} showUndoRedo={isMobileKeyboardDevice()} rawTextMode={rawTextMode} />

              {parsed.diagnostics.length > 0 && <div className="diagnostics">{parsed.diagnostics.map((diagnostic) => <div key={`${diagnostic.line}-${diagnostic.message}`}>Line {diagnostic.line + 1}: {diagnostic.message}</div>)}</div>}
            </div>
          </article>
        })}
        <div className="stream-sentinel" ref={streamEndRef} aria-hidden="true" />
      </section>
      </div>

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

      {privacyOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setPrivacyOpen(false) }}><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="privacy-title"><div className="modal-heading"><div><span className="eyebrow">Privacy</span><h2 id="privacy-title">Privacy center</h2></div><button className="modal-close" type="button" aria-label="Close privacy center" onClick={() => setPrivacyOpen(false)}>×</button></div><p className="settings-help">Notes stores your working copy locally in IndexedDB. Cloud notes are encrypted before upload.</p><div className="privacy-status"><strong>Local notes</strong><span>{Object.values(documents).filter(Boolean).length} non-empty days, from {oldestDocumentDay}</span><strong>Cloud sync</strong><span>{!firebaseConfigured ? 'Not configured' : !firebaseUser ? 'Signed out' : dataKey ? 'Unlocked and ready' : 'Signed in, encryption locked'}</span><strong>Backup</strong><span>{preferences.backupFrequency === 'off' ? 'Disabled' : backupState === 'error' ? 'Last backup failed' : lastBackupAt ? `Last saved ${new Date(lastBackupAt).toLocaleString()}` : 'Enabled, not run yet'}</span></div><button className="settings-action" type="button" onClick={() => { exportAllMarkdown(); setPrivacyOpen(false) }}>Export all notes</button><button className="settings-action" type="button" onClick={() => { setPrivacyOpen(false); setSettingsOpen(true) }}>Open privacy settings</button></section></div>}

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
            {!firebaseConfigured ? <p className="settings-help">Add the VITE_FIREBASE_* values from FIREBASE_SETUP.md to enable Google sign-in and encrypted sync.</p> : !firebaseUser ? <><button className="settings-action" type="button" onClick={() => { void signIn() }} disabled={syncState === 'working'}>{syncState === 'working' ? 'Opening Google…' : 'Sign in with Google'}</button>{syncMessage && <p className="settings-help sync-error">{syncMessage}</p>}</> : <>
              <p className="settings-help">Signed in as {firebaseUser.email || firebaseUser.displayName || 'Google user'}.</p>
              {!dataKey && <><div className="settings-row"><span className="settings-label">Recovery phrase <button className="settings-link" type="button" onClick={() => { void generateRecoveryPhrase() }}>Generate random phrase</button></span><input value={recoveryPhrase} onChange={(event) => setRecoveryPhrase(event.target.value)} placeholder="12 words" autoComplete="off" /></div><button className="settings-action" type="button" onClick={() => { void prepareSync() }}>Unlock encrypted sync</button></>}
              {!dataKey && !recoveryPhrase && <p className="settings-help">Write down the displayed recovery phrase and keep it private. It cannot be reset.</p>}
              <div className="cloud-actions"><div>{dataKey && <button className="settings-action" type="button" onClick={() => { void syncNow() }} disabled={syncState === 'working'}>{syncState === 'working' ? 'Syncing…' : 'Sync now'}</button>}{dataKey && recoveryPhrase && <button className="settings-action" type="button" onClick={() => { void copyRecoveryPhrase() }}>Copy recovery phrase</button>}</div><div>{!deleteCloudDataOpen ? <button className="settings-danger-action" type="button" onClick={() => setDeleteCloudDataOpen(true)}>Delete cloud data</button> : <div className="settings-danger-confirm"><strong>Delete all cloud notes and the encryption key?</strong><p>This cannot be undone. Your local notes will be kept, but they will no longer match the deleted cloud key.</p><div className="settings-danger-actions"><button className="settings-action" type="button" onClick={() => setDeleteCloudDataOpen(false)}>Cancel</button><button className="settings-danger-action" type="button" onClick={() => { void deleteCloudData() }} disabled={syncState === 'working'}>{syncState === 'working' ? 'Deleting…' : 'Permanently delete'}</button></div></div>}<button className="settings-action" type="button" onClick={() => { void signOutOfGoogle(); setDataKey(undefined); setRecoveryPhrase(''); setSyncState('idle'); setSyncMessage(''); setDeleteCloudDataOpen(false) }}>Sign out</button></div></div>
              {syncMessage && <p className="settings-help">{syncMessage}</p>}
            </>}
          </fieldset>

          <fieldset className="settings-group"><legend>Data &amp; backups</legend>
            <label className="settings-row"><span className="settings-label">Automatic backup</span><select value={preferences.backupFrequency} onChange={(event) => setPreferences((current) => ({ ...current, backupFrequency: event.target.value as Preferences['backupFrequency'] }))}><option value="off">Off</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
            <label className="settings-row"><span className="settings-label">Delete backups after</span><select value={preferences.backupRetention} onChange={(event) => setPreferences((current) => ({ ...current, backupRetention: event.target.value as Preferences['backupRetention'] }))}><option value="off">Keep all</option><option value="week">1 week</option><option value="month">1 month</option><option value="three-months">3 months</option></select></label>
            {preferences.backupFrequency !== 'off' && <label className="settings-row"><span className="settings-label">Backup folder</span><button className="settings-action" type="button" onClick={() => { void chooseBackupFolder() }}>{preferences.backupFolder || 'Choose folder'}</button></label>}
            {preferences.backupFrequency !== 'off' && <p className="settings-help" title="A new folder is created each day or week. Changes are written to that folder as they happen, so the current backup stays fresh.">Backups create a new {preferences.backupFrequency === 'weekly' ? 'week' : 'day'} folder and update it after changes; previous periods are kept.{backupState === 'saved' ? ' Last backup saved.' : backupState === 'error' ? ' Backup failed.' : ''}</p>}
          </fieldset>

          <fieldset className="settings-group"><legend>Notifications</legend>
            <label className="settings-row"><span className="settings-label">Failure notifications</span><input type="checkbox" checked={preferences.notificationsEnabled} onChange={(event) => setPreferences((current) => ({ ...current, notificationsEnabled: event.target.checked }))} /></label>
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
          {syncConflicts.map((conflict) => <div className="sync-conflict" key={conflict.day}><strong>{formatLogicalDay(conflict.day, preferences.dateFormat)}</strong><div className="sync-conflict-preview"><div><span>Changed lines</span><div className="diff-viewer">{diffLines(conflict.local.markdown, conflict.remote.markdown).map((row) => <code className={`diff-row diff-${row.kind}`} key={`${row.kind}-${row.index}`}>{row.kind === 'added' ? '+ ' : row.kind === 'removed' ? '− ' : '  '}{row.text || ' '}</code>)}</div></div></div><label className="merge-editor"><span>Editable merged version</span><textarea value={conflictDrafts[conflict.day] ?? conflict.local.markdown} onChange={(event) => setConflictDrafts((current) => ({ ...current, [conflict.day]: event.target.value }))} /></label><div className="sync-conflict-actions"><button className="settings-action" type="button" onClick={() => { void resolveConflict(conflict, 'local') }}>Keep local</button><button className="settings-action" type="button" onClick={() => { void resolveConflict(conflict, 'remote') }}>Keep server</button><button className="settings-action" type="button" onClick={() => { void resolveConflict(conflict, 'append') }}>Append local to server</button><button className="settings-action" type="button" onClick={() => { void resolveConflict(conflict, 'merged') }}>Save merged version</button></div></div>)}
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
  return window.location.pathname === '/prototype' ? <MarkdownPrototypePage /> : <NotesApp />
}

export default App
