import { describe, expect, it } from 'vitest'

import { audioToNotes } from './pitch'

const RATE = 48_000

/** A voice-like tone: fundamental plus overtones, with silence between notes. */
function hum(parts: readonly { midi: number | null; ms: number }[]) {
  const total = parts.reduce((sum, part) => sum + part.ms, 0)
  const out = new Float32Array(Math.round((total * RATE) / 1000))
  let offset = 0

  for (const part of parts) {
    const count = Math.round((part.ms * RATE) / 1000)

    if (part.midi !== null) {
      const hz = 440 * 2 ** ((part.midi - 69) / 12)

      for (let i = 0; i < count; i++) {
        const t = i / RATE
        const fade = Math.min(1, i / 480, (count - i) / 480)
        out[offset + i] =
          fade * (0.5 * Math.sin(2 * Math.PI * hz * t) + 0.25 * Math.sin(4 * Math.PI * hz * t) + 0.1 * Math.sin(6 * Math.PI * hz * t))
      }
    }

    offset += count
  }

  return out
}

describe('hum to notes', () => {
  it('hears a hummed melody as the right notes at the right times', () => {
    const notes = audioToNotes(
      hum([
        { midi: null, ms: 200 },
        { midi: 60, ms: 400 },
        { midi: null, ms: 100 },
        { midi: 64, ms: 300 },
        { midi: 67, ms: 500 },
        { midi: null, ms: 200 }
      ]),
      RATE
    )

    expect(notes.map(note => note.note)).toEqual([60, 64, 67])
    expect(notes[0].startMs).toBeGreaterThan(170)
    expect(notes[0].startMs).toBeLessThan(240)
    expect(notes[0].durationMs).toBeGreaterThan(330)
    expect(notes[2].durationMs).toBeGreaterThan(400)
  })

  it('tracks low and high voices without octave errors', () => {
    expect(audioToNotes(hum([{ midi: 45, ms: 500 }, { midi: null, ms: 100 }]), RATE).map(n => n.note)).toEqual([45])
    expect(audioToNotes(hum([{ midi: 79, ms: 500 }, { midi: null, ms: 100 }]), RATE).map(n => n.note)).toEqual([79])
  })

  it('ignores silence and quiet noise', () => {
    let seed = 1

    const noise = Float32Array.from({ length: RATE }, () => {
      seed = (seed * 1664525 + 1013904223) % 2 ** 32

      return (seed / 2 ** 32 - 0.5) * 0.004
    })

    expect(audioToNotes(new Float32Array(RATE), RATE)).toEqual([])
    expect(audioToNotes(noise, RATE)).toEqual([])
  })
})
