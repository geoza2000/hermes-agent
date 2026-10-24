/* eslint-disable no-restricted-imports -- Reuse the parent-owned MIDI capture format and original-file encoder. */
import { useEffect, useRef, useState } from 'react'

import { encodeMidiFile, type MidiTake, summarizeMidiTake } from '@/lib/songwriting/midi'

import type { SongScope } from './api'
import { type AudioTake, type CaptureHandle, startMicrophoneCapture, startMidiCapture } from './capture'
import { useSongText } from './i18n'
import { usePendingSources } from './use-pending-sources'

export interface PendingSource {
  key: string
  scope: SongScope | null
  take: MidiTake | AudioTake
  summary: string
  savedPath?: string
  verified?: boolean
}

interface CaptureOperation {
  handle?: CaptureHandle
  completed: boolean
}

export function useSongCapture(key: string, scope: SongScope | null) {
  const t = useSongText()
  const [source, setSource] = useState<'midi' | 'microphone'>('midi')
  const [inputs, setInputs] = useState<MIDIInput[]>([])
  const [inputId, setInputId] = useState('')
  const [recording, setRecording] = useState(false)
  const [starting, setStarting] = useState(false)
  const [events, setEvents] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const { pending, setPending } = usePendingSources(key)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const capture = useRef<CaptureOperation | null>(null)
  const active = useRef(new Set<CaptureOperation>())
  const discovery = useRef<{ access: MIDIAccess; update: () => void } | null>(null)
  const live = useRef({ generation: 0, mounted: true })
  const started = useRef(0)
  const inFlight = useRef(false)
  // eslint-disable-next-line no-restricted-syntax -- Lifecycle invalidation, not an atom mirror.
  useEffect(() => {
    live.current.generation++
    setRecording(false)
    setStarting(inFlight.current)
    capture.current?.handle?.stop('ownership changed')
    capture.current = null

    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Teardown invalidates the current request generation.
      live.current.generation++
      capture.current?.handle?.stop('ownership changed')
      capture.current = null
    }
  }, [key])
  useEffect(() => {
    live.current.mounted = true
    const operations = active.current

    return () => {
      live.current.mounted = false
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Teardown invalidates the current request generation.
      live.current.generation++
      operations.forEach(operation => operation.handle?.stop('closed'))
      discovery.current?.access.removeEventListener('statechange', discovery.current.update)
    }
  }, [])
  useEffect(() => {
    if (!recording) {
      return
    }

    const timer = setInterval(() => setElapsed(performance.now() - started.current), 100)

    return () => clearInterval(timer)
  }, [recording])

  const discover = async () => {
    setError('')

    if (!navigator.requestMIDIAccess) {
      setNotice(t('unsupportedMidi'))

      return
    }

    const generation = live.current.generation

    try {
      const access = await navigator.requestMIDIAccess({ sysex: false })

      if (!live.current.mounted || generation !== live.current.generation) {
        return
      }

      discovery.current?.access.removeEventListener('statechange', discovery.current.update)

      const update = () => {
        const available = [...access.inputs.values()].filter(input => input.state === 'connected')
        setInputs(available)
        setInputId(current => (available.some(input => input.id === current) ? current : (available[0]?.id ?? '')))
        setNotice(available.length ? '' : t('noMidi'))
      }

      discovery.current = { access, update }
      access.addEventListener('statechange', update)
      update()
    } catch (err) {
      setError(String(err))
    }
  }

  const start = async () => {
    if (inFlight.current || capture.current) {
      return
    }

    const operation: CaptureOperation = { completed: false }
    capture.current = operation
    active.current.add(operation)
    setError('')
    setNotice('')
    setEvents(0)
    setElapsed(0)
    setLevel(0)
    const generation = live.current.generation
    const takeKey = key
    const takeScope = scope ? { sessionId: scope.sessionId, owner: { ...scope.owner } } : null

    const onKeep = (take: MidiTake | AudioTake, reason: string) => {
      operation.completed = true
      active.current.delete(operation)

      if (!live.current.mounted) {
        return
      }

      let summary: string

      if (take.kind === 'midi') {
        const info = summarizeMidiTake(take)
        summary = t(
          'midiSummary',
          take.device.name,
          take.durationMs / 1000,
          info.eventCount,
          info.noteCount,
          info.channels.join(', ')
        )
      } else {
        summary = t('audioSummary', take.name, take.durationMs / 1000, take.blob.size)
      }

      setPending({ key: takeKey, scope: takeScope, take, summary })

      if (capture.current !== operation) {
        return
      }

      setRecording(false)
      setStarting(false)
      setLevel(0)
      setNotice(reason === 'disconnected' ? t('disconnected') : reason === 'limit' ? t('limit') : t('ended', reason))
      capture.current = null
    }

    started.current = performance.now()
    inFlight.current = true
    setStarting(true)

    try {
      let handle: CaptureHandle

      if (source === 'midi') {
        const input = inputs.find(candidate => candidate.id === inputId && candidate.state === 'connected')

        if (!input) {
          throw new Error(t('noMidi'))
        }

        handle = startMidiCapture(input, { onKeep, onProgress: setEvents })
      } else {
        handle = await startMicrophoneCapture({
          onKeep,
          onLevel: value => {
            if (capture.current === operation && live.current.mounted) {
              setLevel(value)
            }
          }
        })
      }

      operation.handle = handle

      if (operation.completed) {
        return
      }

      if (!live.current.mounted || generation !== live.current.generation) {
        handle.stop('ownership changed')

        return
      }

      setRecording(true)
    } catch (err) {
      active.current.delete(operation)

      if (capture.current === operation) {
        capture.current = null
      }

      if (live.current.mounted && generation === live.current.generation) {
        setError(String(err))
      }
    } finally {
      inFlight.current = false

      if (live.current.mounted) {
        setStarting(false)
      }
    }
  }

  const stop = () => capture.current?.handle?.stop()

  const retake = () => {
    setPending(null)
    setNotice('')
    setError('')
  }

  return {
    source,
    setSource,
    inputs,
    inputId,
    setInputId,
    discover,
    start,
    stop,
    retake,
    recording,
    starting,
    events,
    elapsed,
    level,
    pending,
    setPending,
    notice,
    error
  }
}

export function downloadOriginalMidi(take: MidiTake) {
  const url = URL.createObjectURL(new Blob([encodeMidiFile(take)], { type: 'audio/midi' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'original-take.mid'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function audioBody(blob: Blob, name: string): Promise<{ name: string; mime: string; data: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve({ name, mime: blob.type, data: String(reader.result).split(',')[1] })
    reader.readAsDataURL(blob)
  })
}
