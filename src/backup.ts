import type { BackupFrequency } from './preferences'
import type { DailyDocument } from './storage'

export interface BackupDirectoryPicker {
  showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>
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

export function backupFolderName(frequency: Exclude<BackupFrequency, 'off'>, date = new Date()) {
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
