/* eslint-disable no-restricted-imports -- Exercise the real first-party owner-pinned API boundary. */
import { describe, expect, it, vi } from 'vitest'

import { audibleLanes, createSongwritingApi, type Lane, lanesWithSuggestion, songLengthMs } from './api'

vi.mock('@/api/client', () => ({ hermesApiAs: vi.fn() }))
import { hermesApiAs } from '@/api/client'

const owner = { connectionId: 'remote-a', profile: 'musician' }

function lane(id: string, patch: Partial<Lane> = {}): Lane {
  return {
    id,
    name: id,
    instrument: { program: 0, drums: false },
    source: 'midi',
    notes: [{ startMs: 0, durationMs: 500, note: 60, velocity: 90 }],
    audio: null,
    play: 'notes',
    muted: false,
    solo: false,
    volume: 0.8,
    ...patch
  }
}

describe('songwriting lanes client', () => {
  it('pins every request to the captured owner and the durable session', async () => {
    vi.mocked(hermesApiAs).mockResolvedValue({ data: btoa('ab'), chunks: 2, index: 0, mime: 'audio/webm' })
    const api = createSongwritingApi({ owner, sessionId: 'session/a' })
    await api.updateLane('lane 1', { muted: true })
    const blob = await api.recording('capture_x')
    const base = '/api/plugins/songwriting/sessions/session%2Fa'
    expect(vi.mocked(hermesApiAs).mock.calls).toEqual([
      [owner, { path: `${base}/lanes/lane%201`, method: 'POST', body: { muted: true } }],
      [owner, { path: `${base}/captures/capture_x/chunks/0`, method: 'GET' }],
      [owner, { path: `${base}/captures/capture_x/chunks/1`, method: 'GET' }]
    ])
    expect(blob.type).toBe('audio/webm')
    expect(await blob.text()).toBe('abab')
  })

  it('solo wins over mute, and mute silences only its lane', () => {
    const lanes = [lane('a'), lane('b', { muted: true }), lane('c')]
    expect(audibleLanes(lanes).map(item => item.id)).toEqual(['a', 'c'])
    expect(audibleLanes([...lanes, lane('d', { solo: true, muted: true })]).map(item => item.id)).toEqual(['d'])
  })

  it('previews a suggestion exactly as Keep would apply it', () => {
    const lanes = [lane('bass'), lane('keys'), lane('old')]

    const merged = lanesWithSuggestion(lanes, {
      id: 'p',
      brief: '',
      changes: [
        { laneId: 'bass', notes: [{ startMs: 1000, durationMs: 250, note: 40, velocity: 100 }] },
        { laneId: 'old', remove: true },
        { laneId: 'pad', name: 'Pad', instrument: { program: 89, drums: false }, notes: [] }
      ]
    })

    expect(merged.map(item => item.id)).toEqual(['bass', 'keys', 'pad'])
    expect(merged[0].notes[0].startMs).toBe(1000)
    expect(merged[2]).toMatchObject({ name: 'Pad', source: 'hermes', instrument: { program: 89 } })
    expect(lanes[0].notes[0].startMs).toBe(0)
  })

  it('measures the song through its last note or recording', () => {
    expect(songLengthMs([])).toBe(0)

    const recorded = lane('voice', {
      notes: [],
      audio: { captureId: 'c', startMs: 2000, offsetMs: 500, durationMs: 3000, mime: 'audio/webm' }
    })

    expect(songLengthMs([lane('a'), recorded])).toBe(5000)
  })
})
