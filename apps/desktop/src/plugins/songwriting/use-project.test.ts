/* eslint-disable no-restricted-imports -- Exercise the real owner-pinned API boundary. */
import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { useSongProject } from './use-project'

vi.mock('@/api/client', () => ({ hermesApiAs: vi.fn() }))
import { hermesApiAs } from '@/api/client'

const project = (revision: number) => ({
  schema: 1 as const,
  id: 'song',
  title: 'Song',
  brief: '',
  revision,
  tracks: [],
  captures: []
})

const scope = { owner: { connectionId: 'a', profile: 'p' }, sessionId: 's' }

it('does not publish a late operation after its owner changed away and back', async () => {
  vi.mocked(hermesApiAs).mockResolvedValue(project(1))
  const hook = renderHook(({ key }) => useSongProject(key, scope), { initialProps: { key: 'a' } })
  await waitFor(() => expect(hook.result.current.busy).toBe(false))
  let resolve!: () => void

  const delayed = new Promise<void>(done => {
    resolve = done
  })

  const old = hook.result.current
  let operation!: Promise<void>
  act(() => {
    operation = old.run(async () => {
      await delayed

      if (old.isCurrent()) {
        old.setProject(project(99))
      }
    })
  })
  hook.rerender({ key: 'b' })
  await waitFor(() => expect(hook.result.current.busy).toBe(false))
  hook.rerender({ key: 'a' })
  await waitFor(() => expect(hook.result.current.busy).toBe(false))
  await act(async () => {
    resolve()
    await operation
  })
  expect(hook.result.current.project?.revision).toBe(1)
})
