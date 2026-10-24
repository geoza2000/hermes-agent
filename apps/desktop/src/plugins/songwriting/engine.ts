import { WorkletSynthesizer } from 'spessasynth_lib'
import processorUrl from 'spessasynth_lib/dist/spessasynth_processor.min.js?url'

import { audibleLanes, type Lane } from './api'

/** The pane's sound: a SoundFont synthesizer for note lanes, buffers for recorded lanes, a
 *  metronome, and live play-through so a keyboard sounds like the lane's instrument. */

type Controller = Parameters<WorkletSynthesizer['controllerChange']>[1]

const DRUM_CHANNEL = 9
const MELODIC_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15]
const LOOKAHEAD_S = 0.2
const TICK_MS = 25
const START_DELAY_S = 0.08
const VOLUME_CC = 7 as Controller
const SUSTAIN_CC = 64 as Controller

interface ScheduledNote {
  timeMs: number
  channel: number
  note: number
  velocity: number
  on: boolean
}

export interface PlayOptions {
  fromMs: number
  tempo: number
  metronome: boolean
  countInBars: number
}

export interface Playback {
  /** performance.now() at which song position `fromMs` becomes audible. */
  songStartsAt: number
  /** AudioContext time at which song position `fromMs` plays. */
  contextStart: number
}

export class SongEngine {
  readonly context: AudioContext
  private readonly synth: WorkletSynthesizer
  private readonly buffers = new Map<string, AudioBuffer>()
  private channels = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | undefined
  private sources: AudioScheduledSourceNode[] = []
  private gains = new Map<string, GainNode>()
  private playing: { contextStart: number; fromMs: number } | null = null

  private constructor(context: AudioContext, synth: WorkletSynthesizer) {
    this.context = context
    this.synth = synth
  }

  static async create(bank: ArrayBuffer): Promise<SongEngine> {
    const context = new AudioContext({ latencyHint: 'interactive' })
    await context.audioWorklet.addModule(processorUrl)
    const synth = new WorkletSynthesizer(context)
    synth.connect(context.destination)
    await synth.isReady
    await synth.soundBankManager.addSoundBank(bank, 'gm')

    return new SongEngine(context, synth)
  }

  /** Give every lane a MIDI channel and its instrument; drum lanes share the GM drum channel. */
  setLanes(lanes: readonly Lane[]) {
    const melodic = lanes.filter(lane => !lane.instrument.drums)
    this.channels = new Map(
      lanes.map(lane => [lane.id, lane.instrument.drums ? DRUM_CHANNEL : MELODIC_CHANNELS[melodic.indexOf(lane)] ?? 0])
    )

    for (const lane of melodic) {
      this.synth.programChange(this.channel(lane.id), lane.instrument.program)
    }

    this.setMix(lanes)
  }

  /** Mute, solo and volume apply instantly, mid-playback, without rescheduling anything. */
  setMix(lanes: readonly Lane[]) {
    const audible = new Set(audibleLanes(lanes).map(lane => lane.id))
    const level = new Map<number, number>()

    for (const lane of lanes) {
      const channel = this.channel(lane.id)
      const value = audible.has(lane.id) && lane.play === 'notes' ? lane.volume : 0
      level.set(channel, Math.max(level.get(channel) ?? 0, value))
      this.gains.get(lane.id)?.gain.setTargetAtTime(audible.has(lane.id) && lane.play === 'audio' ? lane.volume : 0, this.context.currentTime, 0.01)
    }

    for (const [channel, value] of level) {
      this.synth.controllerChange(channel, VOLUME_CC, Math.round(value * 127))
    }
  }

  channel(laneId: string): number {
    return this.channels.get(laneId) ?? 0
  }

  async resume() {
    if (this.context.state !== 'running') {
      await this.context.resume()
    }
  }

  /** Play a key on the selected lane's instrument right now (live monitoring). */
  live(laneId: string, data: Uint8Array) {
    // The selected lane's instrument plays, whatever channel or device the input came from.
    const channel = this.channel(laneId)
    const command = data[0] >> 4

    if (command === 9 && data[2] > 0) {
      this.synth.noteOn(channel, data[1], data[2])
    } else if (command === 8 || command === 9) {
      this.synth.noteOff(channel, data[1])
    } else if (command === 11) {
      this.synth.controllerChange(channel, data[1] as Controller, data[2])
    } else if (command === 14) {
      this.synth.pitchWheel(channel, (data[2] << 7) | data[1])
    }
  }

  async loadRecording(captureId: string, fetch: () => Promise<Blob>): Promise<AudioBuffer> {
    const known = this.buffers.get(captureId)

    if (known) {
      return known
    }

    const decoded = await this.context.decodeAudioData(await (await fetch()).arrayBuffer())
    this.buffers.set(captureId, decoded)

    return decoded
  }

  get positionMs(): number | null {
    if (!this.playing) {
      return null
    }

    return this.playing.fromMs + Math.max(0, this.context.currentTime - this.playing.contextStart) * 1000
  }

  play(lanes: readonly Lane[], options: PlayOptions): Playback {
    this.stop()
    this.setLanes(lanes)
    const beatS = 60 / options.tempo
    const countInS = options.countInBars * 4 * beatS
    const contextStart = this.context.currentTime + START_DELAY_S + countInS
    this.playing = { contextStart, fromMs: options.fromMs }

    const events: ScheduledNote[] = lanes
      .filter(lane => lane.play === 'notes')
      .flatMap(lane =>
        lane.notes
          .filter(note => note.startMs + note.durationMs > options.fromMs)
          .flatMap(note => [
            { timeMs: Math.max(note.startMs, options.fromMs), channel: this.channel(lane.id), note: note.note, velocity: note.velocity, on: true },
            { timeMs: note.startMs + note.durationMs, channel: this.channel(lane.id), note: note.note, velocity: 0, on: false }
          ])
      )
      .sort((a, b) => a.timeMs - b.timeMs || Number(a.on) - Number(b.on))

    for (const lane of lanes) {
      if (lane.play === 'audio' && lane.audio && this.buffers.has(lane.audio.captureId)) {
        this.startRecording(lane, contextStart, options.fromMs)
      }
    }

    this.setMix(lanes)
    this.countIn(contextStart - countInS, options.countInBars * 4, beatS)
    let cursor = 0
    let beat = Math.ceil(options.fromMs / 1000 / beatS - 1e-6)
    let nextClick = contextStart + beat * beatS - options.fromMs / 1000

    const schedule = () => {
      const horizon = this.context.currentTime + LOOKAHEAD_S

      while (cursor < events.length) {
        const event = events[cursor]
        const at = contextStart + (event.timeMs - options.fromMs) / 1000

        if (at > horizon) {
          break
        }

        const time = { time: Math.max(at, this.context.currentTime) }

        if (event.on) {
          this.synth.noteOn(event.channel, event.note, event.velocity, time)
        } else {
          this.synth.noteOff(event.channel, event.note, time)
        }

        cursor++
      }

      while (options.metronome && nextClick < horizon) {
        this.click(nextClick, beat % 4 === 0)
        nextClick += beatS
        beat++
      }
    }

    schedule()
    this.timer = setInterval(schedule, TICK_MS)
    // You hear contextStart after the output latency; measuring from currentTime avoids
    // getOutputTimestamp(), which can report zeros right after the context resumes.
    const latency = this.context.outputLatency || this.context.baseLatency || 0
    const songStartsAt = performance.now() + (contextStart - this.context.currentTime + latency) * 1000

    return { songStartsAt, contextStart }
  }

  stop() {
    clearInterval(this.timer)
    this.timer = undefined
    this.playing = null
    this.sources.forEach(source => {
      try {
        source.stop()
      } catch {
        // Already finished.
      }
    })
    this.sources = []
    this.gains.clear()

    for (let channel = 0; channel < 16; channel++) {
      this.synth.controllerChange(channel, SUSTAIN_CC, 0)
    }

    this.synth.stopAll(true)
  }

  close() {
    this.stop()
    this.synth.destroy()
    void this.context.close()
  }

  private startRecording(lane: Lane, contextStart: number, fromMs: number) {
    const audio = lane.audio!
    const buffer = this.buffers.get(audio.captureId)!
    const intoTake = Math.max(0, fromMs - audio.startMs)
    const offset = (audio.offsetMs + intoTake) / 1000

    if (offset >= buffer.duration) {
      return
    }

    const source = this.context.createBufferSource()
    const gain = this.context.createGain()
    source.buffer = buffer
    source.connect(gain).connect(this.context.destination)
    source.start(contextStart + Math.max(0, audio.startMs - fromMs) / 1000, offset)
    this.sources.push(source)
    this.gains.set(lane.id, gain)
  }

  private countIn(start: number, beats: number, beatS: number) {
    for (let beat = 0; beat < beats; beat++) {
      this.click(start + beat * beatS, beat % 4 === 0)
    }
  }

  private click(at: number, accent: boolean) {
    if (at < this.context.currentTime) {
      return
    }

    const osc = this.context.createOscillator()
    const gain = this.context.createGain()
    osc.frequency.value = accent ? 1760 : 1320
    gain.gain.setValueAtTime(0.25, at)
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.05)
    osc.connect(gain).connect(this.context.destination)
    osc.start(at)
    osc.stop(at + 0.06)
    this.sources.push(osc)
  }
}
