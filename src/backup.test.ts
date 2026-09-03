import { describe, expect, it } from 'vitest'
import { backupFolderName, backupSignature } from './backup'

describe('backup helpers', () => {
  it('excludes empty documents from change signatures', () => {
    expect(backupSignature([
      { day: '2026-09-02', markdown: '', updatedAt: 1 },
      { day: '2026-09-01', markdown: 'note', updatedAt: 1 },
    ])).toBe(backupSignature([{ day: '2026-09-01', markdown: 'note', updatedAt: 2 }]))
  })

  it('names the active backup folder by frequency', () => {
    const date = new Date(2026, 8, 3, 14, 30)
    expect(backupFolderName('hourly', date)).toBe('2026-09-03-14')
    expect(backupFolderName('daily', date)).toBe('2026-09-03')
    expect(backupFolderName('weekly', date)).toBe('week-2026-08-31')
  })
})
