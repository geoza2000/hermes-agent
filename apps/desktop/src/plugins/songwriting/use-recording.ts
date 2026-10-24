/* eslint-disable no-restricted-imports -- Reuse the parent-owned lossless MIDI take format. */
import { useCallback, useEffect, useRef, useState } from 'react'

import type { MidiTake } from '@/lib/songwriting/midi'

import { blobToBase64, type Lane, type SongwritingApi } from './api'
import { type AudioTake, type CaptureHandle, startMicrophoneCapture, startMidiCapture } from './capture'
import type { SongEngine } from './engine'
import { audioToNotes } from './pitch'
import type { useEngine } from './use-engine'
import type { useSong } from './use-song'

export interface Recording {
  laneId: string
  kind: 'midi' | 'mic'
  level: number
  events: number
}

interface RecorderDeps {
  api: SongwritingApi | null
  sound: ReturnType<typeof useEngine>
  lanes: readonly Lane[]
  tempo: number
  metronome: boolean
  run: ReturnType<typeof useSong>['run']
  setError: (message: string) => void
}

/** MIDI keyboards: discovery, live play-through on the selected lane, and the input to record from. */
export function useMidiInput(engine: SongEngine | null, monitorLaneId: string | null) {
  const [inputs, setInputs] = useState<MIDIInput[]>([])
  const [inputId, setInputId] = useState('')
  const [notice, setNotice] = useState('')
  const monitor = useRef(monitorLaneId)
  monitor.current = monitorLaneId

  useEffect(() => {
    if (!navigator.requestMIDIAccess) {
      setNotice('MIDI is unavailable here; record with the microphone instead.')

      return
    }

    let access: MIDIAccess | null = null

    const update = () => {
      const connected = [...(access?.inputs.values() ?? [])].filter(input => input.state === 'connected')
      setInputs(connected)
      setInputId(current => (connected.some(input => input.id === current) ? current : (connected[0]?.id ?? '')))
      setNotice(connected.length ? '' : 'No MIDI keyboard found. Plug one in, or use a voice or audio lane.')
    }

    navigator
      .requestMIDIAccess({ sysex: false })
      .then(granted => {
        access = granted
        access.addEventListener('statechange', update)
        update()
      })
      .catch(err => setNotice(String(err)))

    return () => access?.removeEventListener('statechange', update)
  }, [])

  const input = inputs.find(item => item.id === inputId) ?? null

  // Whatever you play is heard on the selected lane's instrument.
  useEffect(() => {
    if (!input || !engine) {
      return
    }

    const listener = (event: Event) => {
      const data = (event as MIDIMessageEvent).data

      if (data && monitor.current) {
        engine.live(monitor.current, data)
      }
    }

    input.addEventListener('midimessage', listener)

    return () => input.removeEventListener('midimessage', listener)
  }, [input, engine])

  return { inputs, inputId, setInputId, input, notice }
}

async function decode(engine: SongEngine, blob: Blob): Promise<AudioBuffer> {
  return engine.context.decodeAudioData(await blob.arrayBuffer())
}

/** Record onto a lane in time with the song: a bar of count-in, the other lanes playing. */
export function useRecorder(deps: RecorderDeps, input: MIDIInput | null) {
  const [recording, setRecording] = useState<Recording | null>(null)
  const capture = useRef<CaptureHandle | null>(null)
  const latest = useRef(deps)
  latest.current = deps

  useEffect(() => () => capture.current?.stop('closed'), [])

  const start = useCallback(
    async (lane: Lane, fromMs: number) => {
      const { sound, lanes, tempo, metronome, api, setError } = latest.current
      const engine = sound.engine.current

      if (!engine || !api || capture.current) {
        return
      }

      const midi = lane.source === 'midi'

      if (midi && !input) {
        setError('Connect a MIDI keyboard to record this lane.')

        return
      }

      // You hear everything except the lane being replaced.
      const backing = lanes.filter(item => item.id !== lane.id)
      setRecording({ laneId: lane.id, kind: midi ? 'midi' : 'mic', level: 0, events: 0 })

      try {
        if (midi) {
          const playback = await sound.play(backing, { fromMs, tempo, metronome, countInBars: 1 })

          if (!playback) {
            throw new Error('The sound engine is not ready')
          }

          await waitUntil(playback.songStartsAt)
          const startedAt = performance.now()
          capture.current = startMidiCapture(input!, {
            onProgress: events => setRecording(current => current && { ...current, events }),
            onKeep: (take: MidiTake) => {
              capture.current = null
              sound.stop()
              setRecording(null)

              if (take.events.length) {
                void latest.current.run(a => a.recordMidi(lane.id, take, Math.max(0, fromMs + (startedAt - playback.songStartsAt))), r => r.project)
              }
            }
          })

          return
        }

        const micStartedAt = performance.now()
        let songStartsAt = 0
        capture.current = await startMicrophoneCapture({
          context: null,
          onLevel: level => setRecording(current => current && { ...current, level }),
          onKeep: (take: AudioTake) => {
            capture.current = null
            sound.stop()
            setRecording(null)
            void saveAudio(lane, take, fromMs, Math.max(0, songStartsAt - micStartedAt))
          }
        })
        const playback = await sound.play(backing, { fromMs, tempo, metronome, countInBars: 1 })
        songStartsAt = playback?.songStartsAt ?? performance.now()
      } catch (err) {
        capture.current?.stop('failed')
        capture.current = null
        sound.stop()
        setRecording(null)
        setError(String(err instanceof Error ? err.message : err))
      }
    },
    [input]
  )

  const stop = useCallback(() => capture.current?.stop(), [])

  return { recording, start, stop }

  async function saveAudio(lane: Lane, take: AudioTake, fromMs: number, offsetMs: number) {
    const { sound, run, setError } = latest.current
    const engine = sound.engine.current

    if (!engine) {
      return
    }

    try {
      const buffer = await decode(engine, take.blob)
      const durationMs = Math.max(1, buffer.duration * 1000 - offsetMs)
      const notes = lane.source === 'voice' ? notesAfter(buffer, offsetMs) : undefined
      const data = await blobToBase64(take.blob)
      await run(
        a => a.recordAudio(lane.id, { name: take.name, mime: take.blob.type || 'audio/webm', data, durationMs, startMs: fromMs, offsetMs, notes }),
        r => r.project
      )
    } catch (err) {
      setError(`The recording could not be read: ${String(err instanceof Error ? err.message : err)}`)
    }
  }
}

/** Notes heard after the count-in, timed from the song start. */
export function notesAfter(buffer: AudioBuffer, offsetMs: number) {
  const skip = Math.round((offsetMs / 1000) * buffer.sampleRate)

  return audioToNotes(buffer.getChannelData(0).subarray(skip), buffer.sampleRate)
}

/** Import an audio file onto a lane at the playhead. */
export async function importAudio(
  engine: SongEngine,
  lane: Lane,
  file: File,
  atMs: number,
  run: RecorderDeps['run']
) {
  const buffer = await decode(engine, file)
  const notes = lane.source === 'voice' ? notesAfter(buffer, 0) : undefined
  const data = await blobToBase64(file)
  await run(
    a =>
      a.recordAudio(lane.id, {
        name: file.name.slice(0, 120),
        mime: file.type,
        data,
        durationMs: buffer.duration * 1000,
        startMs: atMs,
        offsetMs: 0,
        notes
      }),
    r => r.project
  )
}

function waitUntil(performanceTime: number) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, performanceTime - performance.now())))
}
