import { describe, expect, it } from 'vitest'

import { createMidiRecorder, encodeMidiFile, summarizeMidiTake } from './midi'

describe('MIDI performance capture', () => {
  it('preserves device identity and every timestamped message without retaining mutable device buffers', () => {
    const recorder = createMidiRecorder({ id: 'port-a', name: 'Test drums', manufacturer: 'Test' }, 1000)
    const bytes = new Uint8Array([0x99, 36, 104])
    recorder.receive(bytes, 1012.5)
    bytes[2] = 1
    recorder.receive(new Uint8Array([0xb9, 4, 72]), 1050)
    recorder.receive(new Uint8Array([0x89, 36, 0]), 1100)
    const take = recorder.finish(1200)
    expect(take.device.name).toBe('Test drums')
    expect(take.events).toEqual([
      { timeMs: 12.5, data: [0x99, 36, 104] },
      { timeMs: 50, data: [0xb9, 4, 72] },
      { timeMs: 100, data: [0x89, 36, 0] }
    ])
    expect(take.durationMs).toBe(200)
    expect(() => recorder.receive(new Uint8Array([0x99, 38, 90]), 1300)).toThrow(/stopped/i)
    expect(take.events).toHaveLength(3)
  })

  it('summarizes percussion as rhythmic evidence, not an inferred musical key', () => {
    const recorder = createMidiRecorder({ id: 'drums', name: 'Drum pads', manufacturer: '' }, 0)
    recorder.receive(new Uint8Array([0x99, 36, 100]), 0)
    recorder.receive(new Uint8Array([0x99, 36, 0]), 50)
    recorder.receive(new Uint8Array([0x99, 38, 80]), 100)
    const take = recorder.finish(150)
    expect(summarizeMidiTake(take)).toEqual({
      eventCount: 3,
      noteCount: 2,
      channels: [10],
      notes: [36, 38],
      velocityRange: [80, 100],
      percussionOnly: true,
      key: null
    })
  })

  it('keeps the partial performance when the input limit is reached', () => {
    const recorder = createMidiRecorder({ id: 'a', name: 'Pads', manufacturer: '' }, 10, 1)
    recorder.receive(new Uint8Array([0x99, 36, 90]), 12)
    expect(() => recorder.receive(new Uint8Array([0x99, 38, 90]), 14)).toThrow(/limit/)
    expect(recorder.finish(15).events).toEqual([{ timeMs: 2, data: [0x99, 36, 90] }])
  })

  it('rejects invalid recording clocks without losing valid events', () => {
    expect(() => createMidiRecorder({ id: 'a', name: '', manufacturer: '' }, Number.NaN)).toThrow(/limits/)
    const recorder = createMidiRecorder({ id: 'a', name: '', manufacturer: '' }, 100)
    expect(() => recorder.receive(new Uint8Array([0x90, 60, 90]), 90)).toThrow(/Invalid/)
    expect(recorder.finish(200).events).toEqual([])
  })

  it('exports a standard MIDI file retaining controllers, notes and release timing', () => {
    const recorder = createMidiRecorder({ id: 'a', name: 'Keys', manufacturer: '' }, 0)
    recorder.receive(new Uint8Array([0x90, 60, 90]), 0)
    recorder.receive(new Uint8Array([0xb0, 64, 127]), 250)
    recorder.receive(new Uint8Array([0x80, 60, 0]), 500)
    const bytes = encodeMidiFile(recorder.finish(1000))
    expect(Array.from(bytes.slice(0, 14))).toEqual([77, 84, 104, 100, 0, 0, 0, 6, 0, 0, 0, 1, 1, 224])
    const track = Array.from(bytes.slice(22))
    expect(track).toContain(0xb0)
    expect(track.slice(0, 7)).toEqual([0, 255, 81, 3, 7, 161, 32])
    expect(track).toEqual(expect.arrayContaining([0x90, 60, 90, 0xb0, 64, 127, 0x80, 60, 0]))
    expect(track.slice(-3)).toEqual([255, 47, 0])
  })
})
