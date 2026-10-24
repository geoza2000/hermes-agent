import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Lane, SongProject } from './api'

const calls = vi.hoisted(() => ({ api: vi.fn(), restart: vi.fn(async () => undefined), engine: null as null | Record<string, ReturnType<typeof vi.fn>> }))
vi.mock('@/api/client', () => ({ hermesApiAs: calls.api }))
vi.mock('./soundfont-cache', () => ({ loadSoundFont: vi.fn(async () => new ArrayBuffer(8)) }))
vi.mock('./engine', () => ({
  SongEngine: {
    create: vi.fn(async () => {
      calls.engine = {
        setLanes: vi.fn(),
        setMix: vi.fn(),
        live: vi.fn(),
        resume: vi.fn(async () => undefined),
        stop: vi.fn(),
        close: vi.fn(),
        loadRecording: vi.fn(async () => undefined),
        play: vi.fn(() => ({ songStartsAt: performance.now(), contextStart: 0 }))
      }

      return Object.assign(calls.engine, { positionMs: null })
    })
  }
}))
vi.mock('@hermes/plugin-sdk', async () => {
  const { atom: makeAtom } = await import('nanostores')

  return {
    ...(await import('@/components/ui/button')),
    ...(await import('@/components/ui/input')),
    ...(await import('@/components/ui/select')),
    ...(await import('@/components/ui/popover')),
    ...(await import('@/components/ui/error-state')),
    ...(await import('@/components/ui/loader')),
    host: {
      restartGateway: calls.restart,
      state: {
        focusedStoredSessionId: makeAtom('session-1'),
        focusedSessionOwner: makeAtom({ connectionId: 'local', profile: 'default' })
      }
    },
    usePluginI18n:
      () =>
      (key: string, ...args: unknown[]) => {
        const value = en[key as keyof typeof en]

        return typeof value === 'function' ? (value as (...a: unknown[]) => string)(...args) : (value ?? key)
      }
  }
})
import { en } from './i18n'
import { SongPane } from './pane'

const NOTE = { startMs: 0, durationMs: 400, note: 40, velocity: 90 }

function lane(id: string, patch: Partial<Lane> = {}): Lane {
  return {
    id,
    name: id,
    instrument: { program: 33, drums: false },
    source: 'midi',
    notes: [NOTE],
    audio: null,
    play: 'notes',
    muted: false,
    solo: false,
    volume: 0.8,
    ...patch
  }
}

const base: SongProject = {
  schema: 2,
  id: 'session-1',
  title: 'Song',
  revision: 1,
  tempo: 120,
  selectedLaneId: 'bass',
  lanes: [lane('bass'), lane('keys', { instrument: { program: 0, drums: false } })],
  captures: []
}

const posts = (suffix: string) =>
  calls.api.mock.calls.filter(([, request]) => request.method === 'POST' && request.path.endsWith(suffix))

function gateway(project: SongProject, installed = true) {
  let current = project
  let bank = installed
  calls.api.mockImplementation(async (_owner, request: { path: string; method: string; body?: Record<string, unknown> }) => {
    const path = request.path.replace('/api/plugins/songwriting', '')

    if (path === '/soundfont') {
      return { name: 'GeneralUser GS', installed: bank, size: 32_000_000, sha256: 'x', license: 'Free', chunkSize: 1, chunks: 1 }
    }

    if (path === '/soundfont/install') {
      bank = true

      return { name: 'GeneralUser GS', installed: true, size: 32_000_000, sha256: 'x', license: 'Free', chunkSize: 1, chunks: 1 }
    }

    if (request.method === 'GET') {
      return current
    }

    if (path.endsWith('/settings')) {
      current = { ...current, ...request.body, revision: current.revision + 1 }

      return current
    }

    if (path.endsWith('/apply')) {
      current = { ...current, proposal: undefined, revision: current.revision + 1 }

      return current
    }

    if (path.endsWith('/midi')) {
      return { project: { ...current, revision: current.revision + 1 } }
    }

    return current
  })
}

let keyboard: EventTarget & { id: string; name: string; state: string }

beforeEach(() => {
  keyboard = Object.assign(new EventTarget(), { id: 'k', name: 'Keys', manufacturer: 'Test', state: 'connected' })
  Object.defineProperty(navigator, 'requestMIDIAccess', {
    configurable: true,
    value: vi.fn(async () => Object.assign(new EventTarget(), { inputs: new Map([['k', keyboard]]) }))
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function midi(bytes: number[]) {
  const event = Object.assign(new Event('midimessage'), { data: new Uint8Array(bytes) })
  Object.defineProperty(event, 'timeStamp', { value: performance.now() })
  keyboard.dispatchEvent(event)
}

describe('songwriting pane', () => {
  it('asks before downloading instruments, then opens the lanes', async () => {
    gateway(base, false)
    render(<SongPane />)
    fireEvent.click(await screen.findByRole('button', { name: en.instrumentsInstall }))
    expect(await screen.findAllByRole('textbox', { name: en.laneName })).toHaveLength(2)
    expect(posts('/soundfont/install')).toHaveLength(1)
  })

  it('plays your keyboard on the selected lane and records the take into place', async () => {
    gateway(base)
    render(<SongPane />)
    await screen.findAllByRole('option')
    midi([0x90, 64, 100])
    expect(calls.engine!.live).toHaveBeenCalledWith('bass', new Uint8Array([0x90, 64, 100]))
    fireEvent.click(screen.getByRole('button', { name: /Record/ }))
    await waitFor(() => expect(calls.engine!.play).toHaveBeenCalled())
    const [backing, options] = calls.engine!.play.mock.calls[0]
    expect(backing.map((item: Lane) => item.id)).toEqual(['keys'])
    expect(options).toMatchObject({ countInBars: 1, tempo: 120 })
    await screen.findByText(/Recording/)
    midi([0x90, 40, 90])
    midi([0x80, 40, 0])
    fireEvent.click(screen.getByRole('button', { name: en.stopRecording }))
    await waitFor(() => expect(posts('/lanes/bass/midi')).toHaveLength(1))
    const body = posts('/lanes/bass/midi')[0][1].body
    expect(body.take.events.map((event: { data: number[] }) => event.data)).toEqual([
      [0x90, 40, 90],
      [0x80, 40, 0]
    ])
    expect(body.startMs).toBeGreaterThanOrEqual(0)
  })

  it('an older gateway gets a restart prompt instead of a crash', async () => {
    gateway({ schema: 1, id: 'session-1', revision: 3, tracks: [], captures: [], proposal: { id: 'x', tracks: [] } } as never)
    render(<SongPane />)
    fireEvent.click(await screen.findByRole('button', { name: en.restartGateway }))
    expect(calls.restart).toHaveBeenCalledTimes(1)
  })

  it('selecting a lane tells Hermes which lane “this lane” is', async () => {
    gateway(base)
    render(<SongPane />)
    const [, keys] = await screen.findAllByRole('option')
    fireEvent.click(keys)
    await waitFor(() => expect(posts('/settings')).toHaveLength(1))
    expect(posts('/settings')[0][1].body).toEqual({ selectedLaneId: 'keys' })
  })

  it('previews Hermes’s suggestion as it would sound, and only Keep applies it', async () => {
    gateway({
      ...base,
      proposal: { id: 'p1', brief: 'Walking bass', changes: [{ laneId: 'bass', notes: [{ ...NOTE, startMs: 500 }] }] }
    })
    render(<SongPane />)
    await screen.findByText('Walking bass')
    fireEvent.click(screen.getByRole('button', { name: en.preview }))
    await waitFor(() => expect(calls.engine!.play).toHaveBeenCalled())
    const [previewed] = calls.engine!.play.mock.calls[0]
    expect(previewed[0].notes[0].startMs).toBe(500)
    expect(posts('/apply')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: en.keep }))
    await waitFor(() => expect(posts('/apply')).toHaveLength(1))
    expect(posts('/apply')[0][1].body).toEqual({ proposalId: 'p1' })
  })
})

