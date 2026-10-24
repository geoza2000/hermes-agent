import type { SongNote } from './api'

/** Turn a hummed, sung or whistled line (one note at a time) into editable MIDI notes.
 *  YIN pitch detection at 16 kHz, then voiced frames are grouped into steady pitches. */

const RATE = 16_000
const WINDOW = 512
const HOP = 160 // 10 ms
const MIN_HZ = 65
const MAX_HZ = 1100
const THRESHOLD = 0.15
const MIN_NOTE_MS = 70
const SILENCE_RMS = 0.005 // about -46 dBFS: room noise, not a voice

export interface PitchFrame {
  timeMs: number
  /** MIDI note number (fractional), or null when the frame is silent or unpitched. */
  midi: number | null
  rms: number
}

export function downsample(samples: Float32Array, rate: number): Float32Array {
  if (rate === RATE) {
    return samples
  }

  const ratio = rate / RATE
  const out = new Float32Array(Math.floor(samples.length / ratio))

  // Box-filter each output sample over its input span: cheap anti-aliasing for voice.
  for (let index = 0; index < out.length; index++) {
    const start = Math.floor(index * ratio)
    const end = Math.min(samples.length, Math.floor((index + 1) * ratio))
    let sum = 0

    for (let source = start; source < end; source++) {
      sum += samples[source]
    }

    out[index] = sum / Math.max(1, end - start)
  }

  return out
}

export function trackPitch(samples: Float32Array, rate: number): PitchFrame[] {
  const audio = downsample(samples, rate)
  const minLag = Math.floor(RATE / MAX_HZ)
  const maxLag = Math.ceil(RATE / MIN_HZ)
  const diff = new Float32Array(maxLag + 1)
  const frames: PitchFrame[] = []
  let peak = 0

  for (let start = 0; start + WINDOW + maxLag < audio.length; start += HOP) {
    let energy = 0

    for (let i = 0; i < WINDOW; i++) {
      energy += audio[start + i] * audio[start + i]
    }

    const rms = Math.sqrt(energy / WINDOW)
    peak = Math.max(peak, rms)
    frames.push({ timeMs: (start * 1000) / RATE, midi: yin(audio, start, minLag, maxLag, diff), rms })
  }

  // Quiet frames are breath and room noise, not notes.
  const floor = Math.max(SILENCE_RMS, peak * 0.08)

  return frames.map(frame => (frame.rms < floor ? { ...frame, midi: null } : frame))
}

function yin(audio: Float32Array, start: number, minLag: number, maxLag: number, diff: Float32Array): number | null {
  for (let lag = 1; lag <= maxLag; lag++) {
    let sum = 0

    for (let i = 0; i < WINDOW; i++) {
      const delta = audio[start + i] - audio[start + i + lag]
      sum += delta * delta
    }

    diff[lag] = sum
  }

  // Cumulative mean normalised difference; the first dip under the threshold is the period.
  let running = 0

  for (let lag = 1; lag <= maxLag; lag++) {
    running += diff[lag]
    diff[lag] = running ? (diff[lag] * lag) / running : 1
  }

  for (let lag = minLag; lag < maxLag; lag++) {
    if (diff[lag] < THRESHOLD) {
      while (lag + 1 < maxLag && diff[lag + 1] < diff[lag]) {
        lag++
      }

      // Parabolic interpolation around the dip for sub-sample accuracy.
      const a = diff[lag - 1]
      const b = diff[lag]
      const c = diff[lag + 1]
      const shift = a + c - 2 * b ? (a - c) / (2 * (a + c - 2 * b)) : 0
      const hz = RATE / (lag + shift)

      return 69 + 12 * Math.log2(hz / 440)
    }
  }

  return null
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)

  return sorted[Math.floor(sorted.length / 2)]
}

/** Group voiced frames into notes: a new note starts on silence or a jump of over half a semitone. */
export function framesToNotes(frames: readonly PitchFrame[]): SongNote[] {
  // A short median filter removes single-frame octave slips.
  const smoothed = frames.map((frame, index) => {
    if (frame.midi === null) {
      return null
    }

    const near = frames
      .slice(Math.max(0, index - 2), index + 3)
      .map(item => item.midi)
      .filter((value): value is number => value !== null)

    return median(near)
  })

  const loudest = Math.max(1e-9, ...frames.map(frame => frame.rms))
  const notes: SongNote[] = []
  let group: number[] = []

  const close = (endIndex: number) => {
    if (group.length) {
      const first = group[0]
      const startMs = frames[first].timeMs
      const durationMs = frames[endIndex - 1].timeMs + (HOP * 1000) / RATE - startMs
      const pitch = Math.round(median(group.map(index => smoothed[index] as number)))
      const level = Math.max(...group.map(index => frames[index].rms)) / loudest

      if (durationMs >= MIN_NOTE_MS && pitch >= 0 && pitch <= 127) {
        notes.push({ startMs, durationMs, note: pitch, velocity: Math.round(45 + 75 * level) })
      }
    }

    group = []
  }

  smoothed.forEach((midi, index) => {
    if (midi === null) {
      close(index)

      return
    }

    if (group.length && Math.abs(midi - median(group.map(item => smoothed[item] as number))) > 0.6) {
      close(index)
    }

    group.push(index)
  })
  close(frames.length)

  return notes
}

export function audioToNotes(samples: Float32Array, rate: number): SongNote[] {
  return framesToNotes(trackPitch(samples, rate))
}
