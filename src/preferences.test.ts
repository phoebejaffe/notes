import { describe, expect, it, vi } from 'vitest'
import { defaultPreferences, loadPreferences } from './preferences'

describe('preferences defaults', () => {
  it('enables empty days by default', () => {
    expect(defaultPreferences.showEmptyDays).toBe(true)
  })

  it('uses monthly backup retention by default', () => {
    expect(defaultPreferences.backupRetention).toBe('month')
  })

  it('has a separate todo window zoom level', () => {
    expect(defaultPreferences.todoZoomLevel).toBe(90)
    expect(loadPreferences().todoZoomLevel).toBe(90)
  })

  it('clamps todoZoomLevel to the 60–150 range', () => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ todoZoomLevel: 500 }) })
    expect(loadPreferences().todoZoomLevel).toBe(150)
    vi.unstubAllGlobals()
  })
})
