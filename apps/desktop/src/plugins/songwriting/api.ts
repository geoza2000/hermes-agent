/* eslint-disable no-restricted-imports -- First-party REST must retain the exact captured owner; the public SDK REST door is ambient. */
import { hermesApiAs, type ResolvedOwner } from '@/api/client'
import type { MidiTake } from '@/lib/songwriting/midi'

import type { Instrument } from './gm'

export interface SongNote {
  startMs: number
  durationMs: number
  note: number
  velocity: number
}
export type LaneSource = 'midi' | 'voice' | 'audio' | 'hermes'
export interface LaneAudio {
  captureId: string
  startMs: number
  offsetMs: number
  durationMs: number
  mime: string
}
export interface Lane {
  id: string
  name: string
  instrument: Instrument
  source: LaneSource
  notes: SongNote[]
  audio: LaneAudio | null
  play: 'notes' | 'audio'
  muted: boolean
  solo: boolean
  volume: number
}
export interface LaneChange {
  laneId: string
  name?: string
  instrument?: Instrument
  notes?: SongNote[]
  remove?: boolean
}
export interface Suggestion {
  id: string
  brief: string
  changes: LaneChange[]
}
export interface SongProject {
  schema: 2
  id: string
  title: string
  revision: number
  tempo: number
  selectedLaneId: string | null
  lanes: Lane[]
  captures: { id: string; kind: string; path: string; laneId?: string; durationMs?: number; mime?: string }[]
  proposal?: Suggestion
}
export interface SongScope {
  owner: ResolvedOwner
  sessionId: string
}
export interface SoundFontStatus {
  name: string
  installed: boolean
  size: number
  sha256: string
  license: string
  chunkSize: number
  chunks: number
}
interface Chunk {
  index: number
  data: string
  chunks?: number
  mime?: string
}
export type LaneUpdate = Partial<Pick<Lane, 'name' | 'instrument' | 'muted' | 'solo' | 'volume' | 'play'>>

const ROOT = '/api/plugins/songwriting'

export function createSongwritingApi(scope: SongScope) {
  const owner = { ...scope.owner }
  const base = `${ROOT}/sessions/${encodeURIComponent(scope.sessionId)}`
  const get = <T>(path: string) => hermesApiAs<T>(owner, { path, method: 'GET' })

  const post = <T>(route: string, body: unknown = {}) =>
    hermesApiAs<T>(owner, { path: `${base}/${route}`, method: 'POST', body })

  const lane = (id: string) => `lanes/${encodeURIComponent(id)}`

  return {
    project: () => get<SongProject>(`${base}/project`),
    settings: (body: { title?: string; tempo?: number; selectedLaneId?: string }) => post<SongProject>('settings', body),
    addLane: (body: { name: string; instrument: Instrument; source: Exclude<LaneSource, 'hermes'> }) =>
      post<{ project: SongProject; lane: Lane }>('lanes', body),
    updateLane: (id: string, body: LaneUpdate) => post<SongProject>(lane(id), body),
    deleteLane: (id: string) => post<SongProject>(`${lane(id)}/delete`),
    recordMidi: (id: string, take: MidiTake, startMs: number) =>
      post<{ project: SongProject }>(`${lane(id)}/midi`, { take, startMs }),
    recordAudio: (
      id: string,
      body: {
        name: string
        mime: string
        data: string
        durationMs: number
        startMs: number
        offsetMs: number
        notes?: SongNote[]
      }
    ) => post<{ project: SongProject }>(`${lane(id)}/audio`, body),
    apply: (proposalId: string) => post<SongProject>('apply', { proposalId }),
    reject: (proposalId: string) => post<SongProject>('reject', { proposalId }),
    undo: () => post<SongProject>('undo'),
    /** A recording's original bytes, reassembled from base64 chunks. */
    recording: async (captureId: string) => {
      const first = await get<Chunk>(`${base}/captures/${encodeURIComponent(captureId)}/chunks/0`)

      const rest = await Promise.all(
        Array.from({ length: (first.chunks ?? 1) - 1 }, (_, index) =>
          get<Chunk>(`${base}/captures/${encodeURIComponent(captureId)}/chunks/${index + 1}`)
        )
      )

      return new Blob([first, ...rest].map(chunk => decodeBase64(chunk.data)), { type: first.mime })
    }
  }
}

export type SongwritingApi = ReturnType<typeof createSongwritingApi>

export function createSoundFontApi(owner: ResolvedOwner) {
  return {
    status: () => hermesApiAs<SoundFontStatus>(owner, { path: `${ROOT}/soundfont`, method: 'GET' }),
    install: () => hermesApiAs<SoundFontStatus>(owner, { path: `${ROOT}/soundfont/install`, method: 'POST', body: {} }),
    chunk: (index: number) =>
      hermesApiAs<Chunk>(owner, { path: `${ROOT}/soundfont/chunks/${index}`, method: 'GET' }).then(chunk =>
        decodeBase64(chunk.data)
      )
  }
}

export function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.readAsDataURL(blob)
  })
}

/** The lanes you would hear: solo wins; otherwise everything not muted. */
export function audibleLanes(lanes: readonly Lane[]): Lane[] {
  const soloing = lanes.some(lane => lane.solo)

  return lanes.filter(lane => (soloing ? lane.solo : !lane.muted))
}

/** The song as it would be if Hermes's suggestion were kept (mirrors the backend's apply). */
export function lanesWithSuggestion(lanes: readonly Lane[], suggestion: Suggestion): Lane[] {
  let result = lanes.map(lane => ({ ...lane }))

  for (const change of suggestion.changes) {
    if (change.remove) {
      result = result.filter(lane => lane.id !== change.laneId)

      continue
    }

    let lane = result.find(item => item.id === change.laneId)

    if (!lane) {
      lane = {
        id: change.laneId,
        name: change.name ?? 'Hermes',
        instrument: change.instrument ?? { program: 0, drums: false },
        source: 'hermes',
        notes: [],
        audio: null,
        play: 'notes',
        muted: false,
        solo: false,
        volume: 0.8
      }
      result.push(lane)
    }

    Object.assign(lane, {
      ...(change.name ? { name: change.name } : {}),
      ...(change.instrument ? { instrument: change.instrument } : {}),
      ...(change.notes ? { notes: change.notes } : {})
    })
  }

  return result
}

export function songLengthMs(lanes: readonly Lane[]): number {
  return lanes.reduce((end, lane) => {
    const notes = lane.notes.reduce((last, note) => Math.max(last, note.startMs + note.durationMs), 0)
    const audio = lane.audio ? lane.audio.startMs + lane.audio.durationMs : 0

    return Math.max(end, notes, audio)
  }, 0)
}
