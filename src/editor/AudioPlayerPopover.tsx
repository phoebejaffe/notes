import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const minutes = Math.floor(seconds / 60)
  const rest = Math.floor(seconds % 60)
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

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

interface AudioPlayerPopoverProps {
  url: string
  anchorRect: DOMRect
  onClose: () => void
}

export function AudioPlayerPopover({ url, anchorRect, onClose }: AudioPlayerPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)

  useEffect(() => {
    const audio = preloadRecordingAudio(url)
    audio.currentTime = 0
    audioRef.current = audio
    const updateTime = () => setCurrentTime(audio.currentTime)
    const updateDuration = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0)
    updateDuration()
    const markPaused = () => setPlaying(false)
    const markPlaying = () => setPlaying(true)
    audio.addEventListener('timeupdate', updateTime)
    audio.addEventListener('loadedmetadata', updateDuration)
    audio.addEventListener('durationchange', updateDuration)
    audio.addEventListener('play', markPlaying)
    audio.addEventListener('pause', markPaused)
    audio.addEventListener('ended', markPaused)
    return () => {
      audio.pause()
      audioRef.current = null
    }
  }, [url])

  useEffect(() => {
    const closeOnOutside = (event: Event) => {
      if (!popoverRef.current?.contains(event.target as Node)) onClose()
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', closeOnOutside, true)
    document.addEventListener('keydown', closeOnEscape)
    window.addEventListener('scroll', onClose, true)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside, true)
      document.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])

  function togglePlay() {
    const audio = audioRef.current
    if (!audio) return
    if (playing) {
      audio.pause()
    } else {
      void audio.play().catch(() => setPlaying(false))
    }
  }

  function seek(value: string) {
    const time = Number(value)
    if (audioRef.current) audioRef.current.currentTime = time
    setCurrentTime(time)
  }

  const width = 240
  const left = Math.min(Math.max(8, anchorRect.left), Math.max(8, window.innerWidth - width - 8))
  const above = anchorRect.top > 72

  return createPortal(
    <div
      ref={popoverRef}
      className="notes-audio-popover"
      role="dialog"
      aria-label="Audio recording"
      style={{
        left,
        top: above ? anchorRect.top : anchorRect.bottom,
        transform: above ? 'translateY(calc(-100% - 8px))' : 'translateY(8px)',
      }}
    >
      <button type="button" className="notes-audio-play" aria-label={playing ? 'Pause recording' : 'Play recording'} onClick={togglePlay}>
        {playing
          ? <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3" y="2.5" width="3.5" height="11" rx="1" /><rect x="9.5" y="2.5" width="3.5" height="11" rx="1" /></svg>
          : <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 2.8c0-.9 1-1.5 1.8-1L13.6 7c.8.5.8 1.6 0 2.1l-7.3 5.1c-.8.6-1.8 0-1.8-.9z" /></svg>}
      </button>
      <input
        type="range"
        className="notes-audio-seek"
        min={0}
        max={duration || 0}
        step={0.1}
        value={Math.min(currentTime, duration || currentTime)}
        onChange={(event) => seek(event.target.value)}
        aria-label="Seek"
      />
      <span className="notes-audio-time">{formatTime(currentTime)} / {formatTime(duration)}</span>
    </div>,
    document.querySelector('.app-shell, .capture-shell') ?? document.body,
  )
}
