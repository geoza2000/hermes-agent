/* eslint-disable no-restricted-imports -- Reuse the parent-owned lossless MIDI recorder, not a duplicate implementation. */
import { createMidiRecorder, type MidiTake } from '@/lib/songwriting/midi'

export interface CaptureHandle {
  stop: (reason?: string) => void
}
export interface MidiInputSource extends EventTarget {
  id: string
  name: string | null
  manufacturer: string | null
  state: string
}
interface MidiCaptureOptions {
  now?: () => number
  onKeep: (take: MidiTake, reason: string) => void
  onProgress: (eventCount: number) => void
}

const MIDI_MESSAGE_LIMIT = 20_000

export function startMidiCapture(input: MidiInputSource, options: MidiCaptureOptions): CaptureHandle {
  const now = options.now ?? (() => performance.now())
  const startedAt = now()

  const recorder = createMidiRecorder(
    { id: input.id, name: input.name || input.id, manufacturer: input.manufacturer || '' },
    startedAt,
    MIDI_MESSAGE_LIMIT
  )

  let deadline: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let count = 0

  const stop = (reason = 'stopped') => {
    if (stopped) {
      return
    }

    stopped = true
    clearTimeout(deadline)
    input.removeEventListener('midimessage', receive)
    input.removeEventListener('statechange', disconnected)
    options.onKeep(recorder.finish(Math.min(now(), startedAt + 300_000)), reason)
  }

  const receive = (event: Event) => {
    const midi = event as MIDIMessageEvent

    if (!midi.data) {
      return
    }

    // Web MIDI inherits Event's monotonic timestamp (the performance.now() time origin).
    if (!Number.isFinite(midi.timeStamp) || midi.timeStamp < startedAt) {
      stop('interrupted')

      return
    }

    if (midi.timeStamp > startedAt + 300_000) {
      stop('limit')

      return
    }

    try {
      recorder.receive(midi.data, midi.timeStamp)
      options.onProgress(++count)

      if (count === MIDI_MESSAGE_LIMIT) {
        stop('limit')
      }
    } catch {
      stop('limit')
    }
  }

  const disconnected = () => {
    if (input.state === 'disconnected') {
      stop('disconnected')
    }
  }

  input.addEventListener('midimessage', receive)
  input.addEventListener('statechange', disconnected)
  deadline = setTimeout(() => stop('limit'), 300_000)

  return { stop }
}

export interface AudioTake {
  kind: 'audio'
  blob: Blob
  name: string
  durationMs: number
}
interface MicrophoneOptions {
  onKeep: (take: AudioTake, reason: string) => void
  onLevel: (level: number) => void
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  Recorder?: typeof MediaRecorder
  context?: AudioContext | null
}

export async function startMicrophoneCapture(options: MicrophoneOptions): Promise<CaptureHandle> {
  const stream = await (options.getUserMedia ?? (constraints => navigator.mediaDevices.getUserMedia(constraints)))({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    video: false
  })

  let context: AudioContext | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let timer: ReturnType<typeof setInterval> | undefined
  let durationLimit: ReturnType<typeof setTimeout> | undefined
  const tracks = stream.getTracks()

  const release = () => {
    clearInterval(timer)
    clearTimeout(durationLimit)
    source?.disconnect()

    if (context) {
      void context.close()
    }

    tracks.forEach(track => {
      track.removeEventListener('ended', disconnected)
      track.stop()
    })
  }

  let recorder: MediaRecorder
  let stopped = false
  let reason = 'stopped'
  const disconnected = () => stop('disconnected')

  const stop = (why = 'stopped') => {
    if (stopped) {
      return
    }

    stopped = true
    reason = why

    if (recorder.state !== 'inactive') {
      recorder.stop()
    }

    release()
  }

  try {
    const Recorder = options.Recorder ?? MediaRecorder

    const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type =>
      Recorder.isTypeSupported(type)
    )

    recorder = new Recorder(stream, mime ? { mimeType: mime } : undefined)
    context = options.context === undefined ? new AudioContext() : options.context

    if (context) {
      source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples)
        options.onLevel(Math.min(1, Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length)))
      }, 100)
    }

    const chunks: Blob[] = []
    let bytes = 0
    const startedAt = performance.now()
    recorder.addEventListener('dataavailable', event => {
      if (!event.data.size) {
        return
      }

      chunks.push(event.data)
      bytes += event.data.size

      if (bytes >= 18 * 1024 * 1024) {
        stop('limit')
      }
    })
    recorder.addEventListener('error', () => stop('interrupted'))
    recorder.addEventListener(
      'stop',
      () => {
        if (!stopped) {
          stopped = true
          release()
        }

        const blob = new Blob(chunks, { type: recorder.mimeType })
        options.onKeep(
          {
            kind: 'audio',
            blob,
            durationMs: performance.now() - startedAt,
            name: `microphone.${blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'}`
          },
          reason
        )
      },
      { once: true }
    )
    tracks.forEach(track => track.addEventListener('ended', disconnected))
    recorder.start(250)
    // Leave room for the final encoded chunk inside the backend's five-minute bound.
    durationLimit = setTimeout(() => stop('limit'), 299_000)

    return { stop }
  } catch (error) {
    release()
    throw error
  }
}
