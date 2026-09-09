import type { BackupFrequency } from './preferences'
import type { DailyDocument } from './storage'

export interface BackupDirectoryPicker {
  showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>
}

export type BackupRetention = 'off' | 'week' | 'month' | 'three-months'

export function backupRetentionCutoff(retention: Exclude<BackupRetention, 'off'>, now = new Date()) {
  const cutoff = new Date(now)
  if (retention === 'week') cutoff.setDate(cutoff.getDate() - 7)
  if (retention === 'month') cutoff.setMonth(cutoff.getMonth() - 1)
  if (retention === 'three-months') cutoff.setMonth(cutoff.getMonth() - 3)
  return cutoff
}

export function isGeneratedBackupFolder(name: string) {
  return /^\d{4}-\d{2}-\d{2}(?:-\d{2})?$|^week-\d{4}-\d{2}-\d{2}$/u.test(name)
}

export function backupFolderDate(name: string) {
  if (!isGeneratedBackupFolder(name)) return undefined
  const value = name.startsWith('week-') ? name.slice(5) : name.slice(0, 10)
  const date = new Date(`${value}T23:59:59`)
  return Number.isNaN(date.getTime()) ? undefined : date
}

export function foldersOlderThan(names: string[], retention: Exclude<BackupRetention, 'off'>, now = new Date()) {
  const cutoff = backupRetentionCutoff(retention, now).getTime()
  return names.filter((name) => {
    const date = backupFolderDate(name)
    return date !== undefined && date.getTime() < cutoff
  })
}

export async function cleanupBrowserBackups(directory: FileSystemDirectoryHandle, retention: Exclude<BackupRetention, 'off'>, now = new Date()) {
  const names: string[] = []
  for await (const [name] of directory.entries()) names.push(name)
  const removed = foldersOlderThan(names, retention, now)
  for (const name of removed) await directory.removeEntry(name, { recursive: true })
  return removed
}

export function backupSignature(documents: DailyDocument[]) {
  return JSON.stringify(documents.filter((document) => document.markdown).sort((left, right) => left.day.localeCompare(right.day)).map(({ day, markdown }) => ({ day, markdown })))
}

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function startOfWeek(date: Date) {
  const monday = new Date(date)
  const day = monday.getDay()
  monday.setDate(monday.getDate() - (day === 0 ? 6 : day - 1))
  return monday
}

export function backupFolderName(frequency: Exclude<BackupFrequency, 'off'> | 'hourly', date = new Date()) {
  const day = localDateKey(date)
  if (frequency === 'hourly') return `${day}-${String(date.getHours()).padStart(2, '0')}`
  if (frequency === 'weekly') return `week-${localDateKey(startOfWeek(date))}`
  return day
}

export async function writeBackup(directory: FileSystemDirectoryHandle, documents: DailyDocument[], frequency: Exclude<BackupFrequency, 'off'>, backupDate = new Date()) {
  const folderName = backupFolderName(frequency, backupDate)
  const backupFolder = await directory.getDirectoryHandle(folderName, { create: true })
  const written = []
  for (const document of documents.filter((item) => item.markdown)) {
    const file = await backupFolder.getFileHandle(`${document.day}.md`, { create: true })
    const writable = await file.createWritable()
    await writable.write(document.markdown)
    await writable.close()
    written.push(document.day)
  }
  return { folderName, written }
}

export async function pickBackupDirectory() {
  const picker = window as unknown as BackupDirectoryPicker
  if (!picker.showDirectoryPicker) throw new Error('Folder selection is not supported in this environment.')
  return picker.showDirectoryPicker()
}

export interface ImportedBackupDocument { day: string; markdown: string }

export async function readBackupDirectory(directory: FileSystemDirectoryHandle): Promise<{ documents: ImportedBackupDocument[]; invalid: string[] }> {
  const documents: ImportedBackupDocument[] = []
  const invalid: string[] = []
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind !== 'file' || !name.endsWith('.md')) continue
    const day = name.slice(0, -3)
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) { invalid.push(name); continue }
    const file = await (handle as FileSystemFileHandle).getFile()
    documents.push({ day, markdown: await file.text() })
  }
  return { documents: documents.sort((left, right) => left.day.localeCompare(right.day)), invalid }
}
