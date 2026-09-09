import { describe, expect, it } from 'vitest'
import { defaultPreferences } from './preferences'

describe('preferences defaults', () => {
  it('enables empty days by default', () => {
    expect(defaultPreferences.showEmptyDays).toBe(true)
  })

  it('enables toolbar controls and monthly backup retention by default', () => {
    expect(Object.values(defaultPreferences.toolbarControls).every(Boolean)).toBe(true)
    expect(defaultPreferences.backupRetention).toBe('month')
  })
})
