import { describe, expect, it } from 'vitest'
import { backupSignature } from './backup'

describe('backup helpers', () => {
  it('excludes empty documents from change signatures', () => {
    expect(backupSignature([
      { day: '2026-09-02', markdown: '', updatedAt: 1 },
      { day: '2026-09-01', markdown: 'note', updatedAt: 1 },
    ])).toBe(backupSignature([{ day: '2026-09-01', markdown: 'note', updatedAt: 2 }]))
  })
})
