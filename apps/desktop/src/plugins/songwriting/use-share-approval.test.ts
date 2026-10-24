import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'

import { useShareApproval } from './use-share-approval'

type Snapshot = Parameters<typeof useShareApproval>[0]

const original: Snapshot = {
  key: 'owner-a:session-a:surface-a',
  scope: { owner: { connectionId: 'a', profile: 'p' }, sessionId: 's' },
  savedPath: '/saved/a.json',
  brief: 'Keep the melody',
  goal: 'layer',
  revision: 1
}

const changes: [string, Partial<Snapshot>][] = [
  ['surface identity', { key: 'another-surface' }],
  ['connection', { scope: { owner: { connectionId: 'b', profile: 'p' }, sessionId: 's' } }],
  ['profile', { scope: { owner: { connectionId: 'a', profile: 'other' }, sessionId: 's' } }],
  ['session', { scope: { owner: { connectionId: 'a', profile: 'p' }, sessionId: 'other' } }],
  ['source', { savedPath: '/saved/b.json' }],
  ['brief', { brief: 'Replace the melody' }],
  ['goal', { goal: 'fullsong' }],
  ['revision', { revision: 2 }]
]

it.each(changes)(
  'invalidates both the checkbox and a previously captured action guard on changed %s',
  (_name, change) => {
    const hook = renderHook(snapshot => useShareApproval(snapshot), { initialProps: original })
    act(() => hook.result.current.setApproved(true))
    const guard = hook.result.current.isApproved
    expect(guard()).toBe(true)
    hook.rerender({ ...original, ...change })
    expect(hook.result.current.approved).toBe(false)
    expect(guard()).toBe(false)
    hook.rerender(original)
    expect(guard()).toBe(false)
  }
)

it('does not approve before the current project revision is known', () => {
  const hook = renderHook(() => useShareApproval({ ...original, revision: undefined }))
  act(() => hook.result.current.setApproved(true))
  expect(hook.result.current.approved).toBe(false)
  expect(hook.result.current.isApproved()).toBe(false)
})

it('retains approval across an equivalent owner wrapper', () => {
  const hook = renderHook(snapshot => useShareApproval(snapshot), { initialProps: original })
  act(() => hook.result.current.setApproved(true))
  hook.rerender({ ...original, scope: { ...original.scope!, owner: { ...original.scope!.owner } } })
  expect(hook.result.current.approved).toBe(true)
  expect(hook.result.current.isApproved()).toBe(true)
})
