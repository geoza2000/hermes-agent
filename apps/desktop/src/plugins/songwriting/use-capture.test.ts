import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { startMicrophoneCapture } from './capture'
import { useSongCapture } from './use-capture'
vi.mock('./capture', () => ({ startMidiCapture: vi.fn(), startMicrophoneCapture: vi.fn() }))
vi.mock('./i18n', () => ({ useSongText: () => (key: string) => key }))

it.each(['stop', 'unmount'] as const)(
  'does not let delayed owner A completion steal owner B capture: %s',
  async end => {
    const completions: Parameters<typeof startMicrophoneCapture>[0][] = []
    const stops = [vi.fn(), vi.fn()]
    vi.mocked(startMicrophoneCapture).mockImplementation(async options => {
      const stop = stops[completions.length]
      completions.push(options)

      return { stop }
    })

    const hook = renderHook(
      ({ key }) => useSongCapture(key, { owner: { connectionId: key, profile: 'p' }, sessionId: 's' }),
      { initialProps: { key: 'a' } }
    )

    act(() => hook.result.current.setSource('microphone'))
    await act(async () => hook.result.current.start())
    hook.rerender({ key: 'b' })
    expect(stops[0]).toHaveBeenCalledWith('ownership changed')
    await act(async () => hook.result.current.start())
    const takeA = { kind: 'audio' as const, blob: new Blob(['a']), name: 'a.webm', durationMs: 10 }
    act(() => completions[1].onLevel(0.7))
    act(() => completions[0].onLevel(0.2))
    expect(hook.result.current.level).toBe(0.7)
    act(() => completions[0].onKeep(takeA, 'ownership changed'))
    expect(hook.result.current.recording).toBe(true)
    expect(hook.result.current.pending?.key).toBe('a')

    if (end === 'unmount') {
      hook.unmount()
      expect(stops[1]).toHaveBeenCalledWith('closed')
    } else {
      act(() => hook.result.current.stop())
      expect(stops[1]).toHaveBeenCalledTimes(1)
      act(() => completions[1].onKeep({ ...takeA, name: 'b.webm' }, 'stopped'))
      expect(hook.result.current.pending?.key).toBe('b')
      hook.rerender({ key: 'a' })
      expect(hook.result.current.pending?.take).toBe(takeA)
      hook.unmount()
    }
  }
)

it('keeps a microphone permission request owned until its stream resolves and releases it after a switch', async () => {
  let resolve!: (handle: { stop: (reason?: string) => void }) => void
  vi.mocked(startMicrophoneCapture).mockReturnValue(
    new Promise(done => {
      resolve = done
    })
  )

  const hook = renderHook(
    ({ key }) => useSongCapture(key, { owner: { connectionId: key, profile: 'p' }, sessionId: 's' }),
    { initialProps: { key: 'a' } }
  )

  act(() => hook.result.current.setSource('microphone'))
  let start!: Promise<void>
  act(() => {
    start = hook.result.current.start()
  })
  expect(hook.result.current.starting).toBe(true)
  hook.rerender({ key: 'b' })
  expect(hook.result.current.starting).toBe(true)
  const stop = vi.fn()
  await act(async () => {
    resolve({ stop })
    await start
  })
  expect(stop).toHaveBeenCalledWith('ownership changed')
  expect(hook.result.current.recording).toBe(false)
  expect(hook.result.current.starting).toBe(false)
})
