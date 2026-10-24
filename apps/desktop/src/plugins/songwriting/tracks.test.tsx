/* eslint-disable no-restricted-imports -- Exercise the real owner-pinned REST and native-download boundaries. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { hermesApiAs } from '@/api/client'
import { downloadGatewayMediaFile } from '@/lib/media'

import { createSongwritingApi } from './api'
import { AudioPlayer } from './audio-player'
import { en } from './i18n'
import { TrackList } from './tracks'
vi.mock('@/api/client', () => ({ hermesApiAs: vi.fn() }))
vi.mock('@/lib/media', () => ({ downloadGatewayMediaFile: vi.fn().mockResolvedValue({ saved: true }) }))
vi.mock('@hermes/plugin-sdk', async () => ({
  ...(await import('@/components/ui/button')),
  usePluginI18n:
    () =>
    (key: string, ...args: unknown[]) => {
      const value = en[key as keyof typeof en]

      return typeof value === 'function' ? (value as (...args: unknown[]) => string)(...args) : (value ?? key)
    }
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
const scope = { owner: { connectionId: 'original-gateway', profile: 'musician' }, sessionId: 'session-1' }

const project = {
  schema: 1 as const,
  id: 'song',
  title: 'Song',
  revision: 3,
  brief: '',
  captures: [],
  tracks: [
    {
      id: 'voice',
      name: 'Original voice',
      kind: 'audio' as const,
      origin: 'imported' as const,
      protected: true,
      path: '/source.wav'
    },
    { id: 'bass', name: 'Bass', kind: 'midi' as const, origin: 'generated' as const, protected: false, notes: [] }
  ]
}

it('pauses and releases an audio element when its source or owner unmounts', () => {
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  const view = render(<AudioPlayer aria-label="actual render" src="data:audio/wav;base64,AAAA" />)
  Object.defineProperty(screen.getByLabelText('actual render'), 'paused', { value: false })
  view.unmount()
  expect(pause).toHaveBeenCalledTimes(1)
  pause.mockRestore()
})

it('prepares real owner-pinned track playback, loops and exports exactly the soloed audible selection', async () => {
  vi.mocked(hermesApiAs).mockImplementation(async (_owner, request) => {
    if (request.path.startsWith('/api/fs/')) {
      return { dataUrl: 'data:audio/wav;base64,AAAA' } as never
    }

    return { path: '/rendered.wav', mime: 'audio/wav', durationMs: 1000 } as never
  })
  const run = (fn: (api: ReturnType<typeof createSongwritingApi>) => Promise<void>) => fn(createSongwritingApi(scope))
  render(<TrackList busy={false} isCurrent={() => true} project={project} run={run} scope={scope} />)
  fireEvent.click(screen.getByRole('button', { name: 'Prepare playback: Original voice' }))
  await waitFor(() =>
    expect(screen.getByLabelText('Original voice').getAttribute('src')).toBe('data:audio/wav;base64,AAAA')
  )
  fireEvent.click(screen.getByLabelText('Loop playback'))
  expect(screen.getByLabelText('Original voice').hasAttribute('loop')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Solo Bass' }))
  expect((screen.getByLabelText('Original voice') as HTMLAudioElement).muted).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Export WAV' }))
  await waitFor(() =>
    expect(downloadGatewayMediaFile).toHaveBeenCalledWith('/rendered.wav', {
      owner: scope.owner,
      sessionId: scope.sessionId,
      suggestedName: 'song.wav'
    })
  )
  expect(hermesApiAs).toHaveBeenCalledWith(scope.owner, {
    path: '/api/plugins/songwriting/sessions/session-1/export',
    method: 'POST',
    body: { trackIds: ['bass'] }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Mute Bass' }))
  expect(screen.getByRole('button', { name: 'Export WAV' }).hasAttribute('disabled')).toBe(true)
})
