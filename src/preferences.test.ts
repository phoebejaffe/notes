import { describe, expect, it } from 'vitest'
import { defaultPreferences } from './preferences'

describe('preferences defaults', () => {
  it('enables empty days by default', () => {
    expect(defaultPreferences.showEmptyDays).toBe(true)
  })

  it('uses monthly backup retention by default', () => {
    expect(defaultPreferences.backupRetention).toBe('month')
  })
})
