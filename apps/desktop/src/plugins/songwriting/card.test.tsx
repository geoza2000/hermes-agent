import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { afterEach } from 'vitest'

const context = vi.hoisted(() => ({
  key: 'remote-a:musician:session-1',
  scope: { owner: { connectionId: 'remote-a', profile: 'musician' }, sessionId: 'session-1' },
  target: 'tile:one',
  surfaceId: 'surface-one'
}))

const calls = vi.hoisted(() => ({ submit: vi.fn((_text: string, _options: unknown) => true), api: vi.fn() }))
vi.mock('./scope', () => ({ useSongwritingScope: () => context }))
vi.mock('@/app/chat/composer/focus', () => ({ requestComposerSubmit: calls.submit }))
vi.mock('@/api/client', () => ({ hermesApiAs: calls.api }))
vi.mock('@hermes/plugin-sdk', async () => ({
  ...(await import('@/components/ui/button')),
  ...(await import('@/components/ui/select')),
  ...(await import('@/components/ui/segmented-control')),
  ...(await import('@/components/ui/error-state')),
  ...(await import('@/components/ui/loader')),
  ...(await import('@/components/ui/textarea')),
  usePluginI18n:
    () =>
    (key: string, ...args: unknown[]) => {
      const value = en[key as keyof typeof en]

      return typeof value === 'function' ? (value as (...args: unknown[]) => string)(...args) : (value ?? key)
    }
}))
vi.mock('@/lib/media', () => ({ downloadGatewayMediaFile: vi.fn().mockResolvedValue({ saved: true }) }))
import { SongwritingCard } from './card'
import { en } from './i18n'
import plugin from './plugin'

const empty = { schema: 1, id: 'song', title: 'Song', revision: 0, brief: '', tracks: [], captures: [] }

function noteOn() {
  const event = Object.assign(new Event('midimessage'), { data: new Uint8Array([144, 60, 100]) })
  // jsdom still uses epoch timestamps, unlike Chromium's monotonic Event.timeStamp.
  Object.defineProperty(event, 'timeStamp', { value: performance.now() })

  return event
}

function importTake(name = 'idea.wav') {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local-source')
  const file = new File(['real source bytes'], name, { type: 'audio/wav' })
  fireEvent.change(screen.getByLabelText('Import audio', { selector: 'input' }), { target: { files: [file] } })
}

const originalContext = { ...context }

afterEach(() => {
  cleanup()
  Object.assign(context, originalContext)
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('normal-chat songwriting card', () => {
  it.each([false, true])(
    'retains the save receipt and retries only verification, owner switch=%s',
    async switchOwner => {
      let saved = false
      let failVerification = true
      let rejectVerification!: (error: Error) => void

      const waiting = new Promise<never>((_resolve, reject) => {
        rejectVerification = reject
      })

      const savedProject = { ...empty, captures: [{ id: 'capture-a', kind: 'audio', path: '/real/idea.wav' }] }
      calls.api.mockImplementation(async (owner, request) => {
        if (owner.connectionId !== originalContext.scope.owner.connectionId) {
          return empty
        }

        if (request.path.endsWith('/audio')) {
          saved = true

          return { project: savedProject, capturePath: '/real/idea.wav' }
        }

        if (saved && failVerification) {
          return waiting
        }

        return saved ? savedProject : empty
      })
      const view = render(<SongwritingCard />)
      await screen.findByText('Revision 0')
      importTake()
      fireEvent.click(screen.getByLabelText(en.uploadConsent))
      fireEvent.click(screen.getByRole('button', { name: 'Save take' }))
      await waitFor(() => expect(calls.api.mock.calls.filter(([, r]) => r.method === 'POST')).toHaveLength(1))

      if (switchOwner) {
        context.key = 'other-owner'
        context.scope = { owner: { connectionId: 'other', profile: 'p' }, sessionId: 'other-session' }
        view.rerender(<SongwritingCard />)
      }

      rejectVerification(new Error('Verification unavailable'))

      if (switchOwner) {
        Object.assign(context, originalContext)
        view.rerender(<SongwritingCard />)
      }

      await screen.findByRole('button', { name: 'Retry save verification' })
      expect(screen.queryByLabelText(en.shareConsent)).toBeNull()
      expect(calls.submit).not.toHaveBeenCalled()
      failVerification = false
      fireEvent.click(screen.getByRole('button', { name: 'Retry save verification' }))
      await screen.findByLabelText(en.shareConsent)
      expect(calls.api.mock.calls.filter(([, r]) => r.method === 'POST')).toHaveLength(1)
    }
  )

  it.each(['brief', 'goal', 'revision'] as const)(
    'revokes sharing approval when the reviewed %s changes',
    async change => {
      let saved = false
      let revision = 0
      const savedPath = '/real/approved-source.wav'
      calls.api.mockImplementation(async (_owner, request) => {
        const project = { ...empty, revision, captures: saved ? [{ id: 'take', kind: 'audio', path: savedPath }] : [] }

        if (request.path.endsWith('/audio')) {
          saved = true

          return { project, capturePath: savedPath }
        }

        return project
      })
      render(<SongwritingCard />)
      await screen.findByText('Revision 0')
      importTake()
      fireEvent.click(screen.getByLabelText(en.uploadConsent))
      fireEvent.click(screen.getByRole('button', { name: 'Save take' }))
      await screen.findByLabelText(en.shareConsent)
      fireEvent.click(screen.getByLabelText(en.shareConsent))
      // Readback can expose consent before the operation's busy flag settles.
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Share with Hermes' }).hasAttribute('disabled')).toBe(false)
      )

      if (change === 'brief') {
        fireEvent.change(screen.getByLabelText('Song brief'), { target: { value: 'New instructions' } })
      }

      if (change === 'goal') {
        fireEvent.click(screen.getByRole('button', { name: 'One instrument' }))
      }

      if (change === 'revision') {
        revision++
        fireEvent.click(screen.getByRole('button', { name: 'Refresh song' }))
        await screen.findByText('Revision 1')
      }

      expect((screen.getByLabelText(en.shareConsent) as HTMLInputElement).checked).toBe(false)
      const share = screen.getByRole('button', { name: 'Share with Hermes' })
      expect(share.hasAttribute('disabled')).toBe(true)
      fireEvent.click(share)
      expect(calls.submit).not.toHaveBeenCalled()
    }
  )

  it('registers only an opt-in transcript directive, not a new destination', () => {
    const register = vi.fn()
    plugin.register({ i18n: { register: vi.fn() }, register } as never)
    expect(plugin.defaultEnabled).toBe(false)
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ area: 'transcript.directives', data: expect.objectContaining({ name: 'songwriting' }) })
    )
  })
  it('shows the local MIDI capture bounds before recording', async () => {
    calls.api.mockResolvedValue(empty)
    render(<SongwritingCard />)
    expect(
      screen.getByText('MIDI capture stops at 20,000 messages or 5 minutes; the partial take is kept.')
    ).toBeTruthy()
    await screen.findByText('Revision 0')
  })
  it('records actual MIDI, requires separate save and share approvals, and submits only to its containing chat', async () => {
    const input = Object.assign(new EventTarget(), {
      id: 'k',
      name: 'Real Keyboard',
      manufacturer: 'Maker',
      state: 'connected'
    })

    Object.defineProperty(navigator, 'requestMIDIAccess', {
      configurable: true,
      value: vi.fn().mockResolvedValue(Object.assign(new EventTarget(), { inputs: new Map([['k', input]]) }))
    })
    let saved = false
    calls.api.mockImplementation(async (_owner, request) => {
      if (request.method === 'POST') {
        saved = true

        return { project: empty, capturePath: '/real/take.json' }
      }

      return saved ? { ...empty, captures: [{ id: 'take', kind: 'midi', path: '/real/take.json' }] } : empty
    })
    render(<SongwritingCard />)
    expect(screen.getByRole('region', { name: 'Songwriting' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Find MIDI inputs' }))
    await screen.findByText('Real Keyboard')
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
    input.dispatchEvent(noteOn())
    fireEvent.click(screen.getByRole('button', { name: 'Stop & keep take' }))
    expect(screen.getByRole('button', { name: 'Save take' }).hasAttribute('disabled')).toBe(true)
    expect(calls.api.mock.calls.filter(([, r]) => r.method === 'POST')).toHaveLength(0)
    fireEvent.click(screen.getByLabelText(en.uploadConsent))
    fireEvent.click(screen.getByRole('button', { name: 'Save take' }))
    await screen.findByText('/real/take.json')
    expect(calls.submit).not.toHaveBeenCalled()
    await screen.findByLabelText(en.shareConsent)
    fireEvent.click(screen.getByLabelText(en.shareConsent))
    fireEvent.click(screen.getByRole('button', { name: 'Share with Hermes' }))
    expect(calls.submit).toHaveBeenCalledWith(expect.stringContaining('/real/take.json'), {
      target: 'tile:one',
      surfaceId: 'surface-one'
    })
    expect(calls.submit.mock.calls[0][0]).toContain('Real Keyboard')
    expect(navigator.requestMIDIAccess).toHaveBeenCalledWith({ sysex: false })
  })
  it('keeps an unsaved take after a gateway error and never uploads without consent', async () => {
    const input = Object.assign(new EventTarget(), {
      id: 'k',
      name: 'Real Keyboard',
      manufacturer: 'Maker',
      state: 'connected'
    })

    Object.defineProperty(navigator, 'requestMIDIAccess', {
      configurable: true,
      value: vi.fn().mockResolvedValue(Object.assign(new EventTarget(), { inputs: new Map([['k', input]]) }))
    })
    calls.api.mockImplementation(async (_owner, request) => {
      if (request.method === 'POST') {
        throw new Error('Gateway refused save')
      }

      return empty
    })
    render(<SongwritingCard />)
    fireEvent.click(screen.getByRole('button', { name: 'Find MIDI inputs' }))
    await screen.findByText('Real Keyboard')
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
    input.dispatchEvent(noteOn())
    fireEvent.click(screen.getByRole('button', { name: 'Stop & keep take' }))
    expect(calls.api.mock.calls.filter(([, r]) => r.method === 'POST')).toHaveLength(0)
    fireEvent.click(screen.getByLabelText(en.uploadConsent))
    fireEvent.click(screen.getByRole('button', { name: 'Save take' }))
    await screen.findByText('Error: Gateway refused save')
    expect(screen.getByText('Unsaved source on this device')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Download original MIDI' })).toBeTruthy()
    expect(calls.submit).not.toHaveBeenCalled()
  })
  it('hides and safely stops a partial take when the containing owner changes', async () => {
    const original = { ...context, scope: context.scope }

    const input = Object.assign(new EventTarget(), {
      id: 'k',
      name: 'Secret Keyboard',
      manufacturer: 'Maker',
      state: 'connected'
    })

    Object.defineProperty(navigator, 'requestMIDIAccess', {
      configurable: true,
      value: vi.fn().mockResolvedValue(Object.assign(new EventTarget(), { inputs: new Map([['k', input]]) }))
    })
    calls.api.mockResolvedValue(empty)
    const view = render(<SongwritingCard />)
    fireEvent.click(screen.getByRole('button', { name: 'Find MIDI inputs' }))
    await screen.findByText('Secret Keyboard')
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
    input.dispatchEvent(noteOn())
    context.key = 'owner-b'
    context.scope = { owner: { connectionId: 'b', profile: 'other' }, sessionId: 's-b' }
    view.rerender(<SongwritingCard />)
    expect(screen.queryByRole('button', { name: 'Stop & keep take' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save take' })).toBeNull()
    expect(screen.getByText(en.changed)).toBeTruthy()
    Object.assign(context, original)
    view.rerender(<SongwritingCard />)
    await screen.findByRole('button', { name: 'Save take' })
    expect(screen.getByText(/Secret Keyboard.*1 events/)).toBeTruthy()
    expect(calls.api.mock.calls.filter(([, r]) => r.method === 'POST')).toHaveLength(0)
  })
  it('imports a real local file without uploading until Save and verifies Reject against server truth', async () => {
    let rejected = false
    let saved = false

    const project = {
      ...empty,
      revision: 2,
      proposal: { id: 'proposal-1', baseRevision: 2, brief: 'Add bass', tracks: [] }
    }

    calls.api.mockImplementation(async (_owner, request) => {
      if (request.path.endsWith('/reject')) {
        rejected = true
      }

      if (request.path.endsWith('/audio')) {
        saved = true

        return { project, capturePath: '/real/original.wav' }
      }

      const current = rejected ? { ...project, proposal: undefined } : project

      return saved ? { ...current, captures: [{ id: 'take', kind: 'audio', path: '/real/original.wav' }] } : current
    })
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local-source')
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const view = render(<SongwritingCard />)
    await screen.findByRole('button', { name: 'Reject proposal' })
    fireEvent.click(screen.getByRole('button', { name: 'Reject proposal' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reject proposal' })).toBeNull())
    const file = new File(['real file bytes'], 'my-recording.wav', { type: 'audio/wav' })
    fireEvent.change(screen.getByLabelText('Import audio', { selector: 'input' }), { target: { files: [file] } })
    expect(screen.getByLabelText('Local audio preview').getAttribute('src')).toBe('blob:local-source')
    expect(calls.api.mock.calls.filter(([, r]) => r.path.endsWith('/audio'))).toHaveLength(0)
    fireEvent.click(screen.getByLabelText(en.uploadConsent))
    fireEvent.click(screen.getByRole('button', { name: 'Save take' }))
    await screen.findByText('/real/original.wav')
    expect(calls.api).toHaveBeenCalledWith(
      context.scope.owner,
      expect.objectContaining({ body: { name: 'my-recording.wav', mime: 'audio/wav', data: btoa('real file bytes') } })
    )
    view.unmount()
    expect(revoke).toHaveBeenCalledWith('blob:local-source')
    create.mockRestore()
    revoke.mockRestore()
  })
  it('shows named proposed tracks without saving them, then sends revision-scoped Apply/Reject/Undo', async () => {
    const project = {
      ...empty,
      revision: 3,
      proposal: {
        id: 'proposal-1',
        baseRevision: 3,
        brief: 'Add bass only',
        tracks: [{ id: 'bass', name: 'New bass', kind: 'midi', origin: 'generated', protected: false, notes: [] }]
      }
    }

    let applied = false
    calls.api.mockImplementation(async (_owner, request) => {
      if (request.path.endsWith('/apply')) {
        applied = true
      }

      return applied ? { ...project, revision: 4, proposal: undefined } : project
    })
    render(<SongwritingCard />)
    await screen.findByText(/New bass/)
    expect(calls.api.mock.calls.filter(([, r]) => r.method === 'POST')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Apply proposal' }))
    await waitFor(() =>
      expect(calls.api).toHaveBeenCalledWith(
        context.scope.owner,
        expect.objectContaining({ body: { proposalId: 'proposal-1', baseRevision: 3 } })
      )
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Undo last revision' }).hasAttribute('disabled')).toBe(false)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Undo last revision' }))
    await waitFor(() =>
      expect(calls.api).toHaveBeenCalledWith(
        context.scope.owner,
        expect.objectContaining({ body: { baseRevision: 4 } })
      )
    )
  })
})
