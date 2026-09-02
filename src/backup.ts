import type { DailyDocument } from './storage'

export interface BackupDirectoryPicker {
  showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>
}

export function backupSignature(documents: DailyDocument[]) {
  return JSON.stringify(documents.filter((document) => document.markdown).sort((left, right) => left.day.localeCompare(right.day)).map(({ day, markdown }) => ({ day, markdown })))
}

export async function writeBackup(directory: FileSystemDirectoryHandle, documents: DailyDocument[], backupDate = new Date()) {
  const folderName = backupDate.toISOString().slice(0, 10)
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
