// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { startMicrophoneCapture, startMidiCapture } from './capture'

class FakeRecorder extends EventTarget {
  static isTypeSupported() {
    return true
  }
  state = 'inactive'
  mimeType = 'audio/webm'
  start() {
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    this.dispatchEvent(
      Object.assign(new Event('dataavailable'), { data: new Blob(['actual recorded bytes'], { type: this.mimeType }) })
    )
    this.dispatchEvent(new Event('stop'))
  }
}

class Input extends EventTarget {
  id = 'k'
  name = 'Actual keyboard'
  manufacturer = 'Maker'
  state = 'connected'
  send(data: number[], timeStamp = 120) {
    const message = Object.assign(new Event('midimessage'), { data: new Uint8Array(data) })
    Object.defineProperty(message, 'timeStamp', { value: timeStamp })
    this.dispatchEvent(message)
  }
}

describe('actual input capture lifecycle', () => {
  it('records microphone bytes with music constraints and releases input on stop', async () => {
    const track = { stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const stream = { getTracks: () => [track] } as unknown as MediaStream
    const getUserMedia = vi.fn().mockResolvedValue(stream)
    const kept = vi.fn()

    const capture = await startMicrophoneCapture({
      onKeep: kept,
      onLevel: vi.fn(),
      getUserMedia,
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
      context: null
    })

    capture.stop()
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false
    })
    expect(kept).toHaveBeenCalledWith(expect.objectContaining({ kind: 'audio', blob: expect.any(Blob) }), 'stopped')
    expect(track.stop).toHaveBeenCalledTimes(1)
    capture.stop()
    expect(kept).toHaveBeenCalledTimes(1)
  })
  it('stops microphone capture before the backend five-minute limit', async () => {
    vi.useFakeTimers()
    const track = { stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const kept = vi.fn()
    await startMicrophoneCapture({
      onKeep: kept,
      onLevel: vi.fn(),
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [track] }),
      Recorder: FakeRecorder as unknown as typeof MediaRecorder,
      context: null
    })
    vi.advanceTimersByTime(299000)
    expect(kept).toHaveBeenCalledWith(expect.objectContaining({ kind: 'audio' }), 'limit')
    expect(track.stop).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
  it('records standard Event timestamps without the obsolete receivedTime property', () => {
    const input = new Input()
    const kept = vi.fn()
    const startedAt = performance.now()
    const capture = startMidiCapture(input, { now: () => startedAt, onKeep: kept, onProgress: vi.fn() })
    const message = Object.assign(new Event('midimessage'), { data: new Uint8Array([0x90, 60, 90]) })

    expect('receivedTime' in message).toBe(false)
    input.dispatchEvent(message)
    expect(kept).not.toHaveBeenCalled()
    capture.stop()
    expect(kept).toHaveBeenCalledWith(
      expect.objectContaining({ events: [{ timeMs: message.timeStamp - startedAt, data: [0x90, 60, 90] }] }),
      'stopped'
    )
  })
  it.each([99, NaN, Infinity])('keeps the partial take as interrupted for an invalid timestamp %s', timeStamp => {
    const input = new Input()
    const kept = vi.fn()
    const progress = vi.fn()
    startMidiCapture(input, { now: () => 100, onKeep: kept, onProgress: progress })
    input.send([0x90, 60, 90])
    input.send([0x80, 60, 0], timeStamp)
    expect(kept).toHaveBeenCalledWith(
      expect.objectContaining({ events: [{ timeMs: 20, data: [0x90, 60, 90] }] }),
      'interrupted'
    )
    expect(progress).toHaveBeenCalledTimes(1)
  })
  it('clamps a MIDI take at five minutes instead of making an unsavable recording', () => {
    vi.useFakeTimers()
    const input = new Input()
    let now = 100
    const kept = vi.fn()
    startMidiCapture(input, { now: () => now, onKeep: kept, onProgress: vi.fn() })
    input.send([0x90, 60, 90])
    now = 300500
    vi.advanceTimersByTime(300000)
    expect(kept).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 300000 }), 'limit')
    vi.useRealTimers()
  })
  it('stops locally at 20,000 MIDI messages and keeps the complete bounded partial take', () => {
    const input = new Input()
    const kept = vi.fn()
    const progress = vi.fn()
    const capture = startMidiCapture(input, { now: () => 100, onKeep: kept, onProgress: progress })

    for (let index = 0; index < 19_999; index++) {
      input.send([0xb0, 64, index % 128])
    }

    expect(kept).not.toHaveBeenCalled()
    input.send([0x80, 60, 0])
    expect(kept).toHaveBeenCalledTimes(1)
    const [take, reason] = kept.mock.calls[0]
    expect(reason).toBe('limit')
    expect(take.events).toHaveLength(20_000)
    expect(take.events[0]).toEqual({ timeMs: 20, data: [0xb0, 64, 0] })
    expect(take.events.at(-1)).toEqual({ timeMs: 20, data: [0x80, 60, 0] })
    expect(progress).toHaveBeenLastCalledWith(20_000)
    input.send([0x90, 62, 90])
    capture.stop()
    expect(kept).toHaveBeenCalledTimes(1)
    expect(progress).toHaveBeenCalledTimes(20_000)
  })
  it('keeps a partial MIDI take on disconnect and detaches all listeners', () => {
    const input = new Input()
    const kept = vi.fn()
    const capture = startMidiCapture(input, { now: () => 100, onKeep: kept, onProgress: vi.fn() })
    input.send([0x90, 60, 90])
    input.state = 'disconnected'
    input.dispatchEvent(new Event('statechange'))
    expect(kept).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'midi',
        device: { id: 'k', name: 'Actual keyboard', manufacturer: 'Maker' },
        events: [{ timeMs: 20, data: [144, 60, 90] }]
      }),
      'disconnected'
    )
    capture.stop()
    input.send([0x90, 62, 90])
    expect(kept).toHaveBeenCalledTimes(1)
  })
})
