export interface MidiDeviceInfo {
  id: string
  name: string
  manufacturer: string
}

export interface MidiEvent {
  timeMs: number
  data: readonly number[]
}

export interface MidiTake {
  schema: 1
  kind: 'midi'
  device: MidiDeviceInfo
  durationMs: number
  events: readonly MidiEvent[]
}

/** A local event recorder, deliberately without a MIDI output or audio path. */
export function createMidiRecorder(device: MidiDeviceInfo, startedAt: number, maxEvents = 100_000) {
  if (!Number.isFinite(startedAt) || !Number.isInteger(maxEvents) || maxEvents < 1) {
    throw new Error('Invalid recording limits')
  }

  const events: MidiEvent[] = []
  const identity = { ...device }
  let stopped = false

  return {
    receive(bytes: Uint8Array, receivedAt: number) {
      if (stopped) {
        throw new Error('Recording is stopped')
      }

      if (events.length >= maxEvents) {
        throw new Error('Recording event limit reached; keep the partial take')
      }

      if (!Number.isFinite(receivedAt) || receivedAt < startedAt || bytes.length === 0) {
        throw new Error('Invalid MIDI event')
      }

      events.push({ timeMs: receivedAt - startedAt, data: Array.from(bytes) })
    },
    finish(stoppedAt: number): MidiTake {
      if (!Number.isFinite(stoppedAt) || stoppedAt < startedAt) {
        throw new Error('Invalid recording end time')
      }

      stopped = true

      return {
        schema: 1,
        kind: 'midi',
        device: { ...identity },
        durationMs: Math.max(stoppedAt - startedAt, events.at(-1)?.timeMs ?? 0),
        events: events.map(event => ({ timeMs: event.timeMs, data: [...event.data] }))
      }
    }
  }
}

export function summarizeMidiTake(take: MidiTake) {
  const notes = take.events.filter(event => (event.data[0] & 0xf0) === 0x90 && event.data[2] > 0)
  const channels = [...new Set(notes.map(event => (event.data[0] & 0x0f) + 1))].sort((a, b) => a - b)
  const velocities = notes.map(event => event.data[2])

  return {
    eventCount: take.events.length,
    noteCount: notes.length,
    channels,
    notes: [...new Set(notes.map(event => event.data[1]))].sort((a, b) => a - b),
    velocityRange: velocities.length ? [Math.min(...velocities), Math.max(...velocities)] : [],
    percussionOnly: channels.length === 1 && channels[0] === 10,
    key: null
  }
}

function variableLength(value: number): number[] {
  let remaining = Math.max(0, Math.round(value))

  if (!Number.isSafeInteger(remaining) || remaining > 0x0fffffff) {
    throw new Error('MIDI timestamp exceeds the file format limit')
  }

  const bytes = [remaining & 0x7f]

  while ((remaining = Math.floor(remaining / 128)) > 0) {
    bytes.unshift((remaining & 0x7f) | 0x80)
  }

  return bytes
}

/** SMF format 0, 480 PPQ. The raw take is never quantized or changed. */
export function encodeMidiFile(take: MidiTake): Uint8Array<ArrayBuffer> {
  const track = [0, 0xff, 0x51, 3, 7, 0xa1, 0x20]
  let previousTick = 0

  for (const event of [...take.events].sort((a, b) => a.timeMs - b.timeMs)) {
    const tick = Math.round(event.timeMs * 0.96)
    track.push(...variableLength(tick - previousTick))

    if (event.data[0] >= 0xf0) {
      // SMF escape events preserve system messages without confusing a parser
      // with a live clock/reset byte in place of a file event.
      track.push(0xf7, ...variableLength(event.data.length), ...event.data)
    } else {
      track.push(...event.data)
    }

    previousTick = tick
  }

  track.push(
    ...variableLength(Math.max(previousTick, Math.round(take.durationMs * 0.96)) - previousTick),
    0xff,
    0x2f,
    0
  )
  const output = new Uint8Array(22 + track.length)
  output.set([77, 84, 104, 100, 0, 0, 0, 6, 0, 0, 0, 1, 1, 224, 77, 84, 114, 107])
  new DataView(output.buffer).setUint32(18, track.length)
  output.set(track, 22)

  return output
}
