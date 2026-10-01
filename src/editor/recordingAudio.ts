// Ring-recording audio elements are shared between the hover preloader and the
// popover player so a warmed link plays instantly. Capped so signed URLs (which
// rotate) can't grow the cache unboundedly.
const recordingAudioCache = new Map<string, HTMLAudioElement>()

export function preloadRecordingAudio(url: string) {
  let audio = recordingAudioCache.get(url)
  if (!audio) {
    audio = new Audio()
    audio.preload = 'auto'
    audio.src = url
    audio.load()
    recordingAudioCache.set(url, audio)
    if (recordingAudioCache.size > 12) recordingAudioCache.delete(recordingAudioCache.keys().next().value!)
  }
  return audio
}
