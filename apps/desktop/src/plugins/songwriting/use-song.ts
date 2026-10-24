import { host } from '@hermes/plugin-sdk'
import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { createSongwritingApi, type SongProject, type SongScope, type SongwritingApi } from './api'

const POLL_MS = 1500

/** A gateway still running songwriting 0.1 answers with `tracks`, not lanes. */
export function isLanesSong(value: unknown): value is SongProject {
  return Boolean(value) && (value as SongProject).schema === 2 && Array.isArray((value as SongProject).lanes)
}

/** The song for whichever chat is focused. Hermes edits it from the chat, so the pane polls
 *  the (local, cheap) project read and swaps in a new copy only when its revision moves. */
export function useSong() {
  const sessionId = useStore(host.state.focusedStoredSessionId)
  const owner = useStore(host.state.focusedSessionOwner)

  const scope: SongScope | null = useMemo(
    () =>
      sessionId && owner
        ? { sessionId, owner: { connectionId: owner.connectionId || null, profile: owner.profile || null } }
        : null,
    [sessionId, owner]
  )

  const key = scope ? JSON.stringify([scope.owner.connectionId, scope.owner.profile, scope.sessionId]) : ''
  const api = useMemo(() => (scope ? createSongwritingApi(scope) : null), [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const [project, setProject] = useState<SongProject | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [outdated, setOutdated] = useState(false)
  const current = useRef(key)
  current.current = key

  const adopt = useCallback(
    (forKey: string, next: unknown) => {
      if (forKey !== current.current) {
        return
      }

      setOutdated(!isLanesSong(next))

      if (isLanesSong(next)) {
        setProject(previous =>
          previous && previous.revision === next.revision && previous.proposal?.id === next.proposal?.id ? previous : next
        )
      }
    },
    []
  )

  useEffect(() => {
    setProject(null)
    setError('')
    setOutdated(false)

    if (!api) {
      return
    }

    const forKey = key
    let alive = true

    const load = () =>
      api
        .project()
        .then(next => alive && adopt(forKey, next))
        .catch(err => alive && setError(String(err)))

    void load()
    const timer = setInterval(load, POLL_MS)

    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [api, key, adopt])

  /** Run a write; its returned project becomes the pane's copy. Errors show once, in the pane. */
  const run = useCallback(
    async <T>(action: (api: SongwritingApi) => Promise<T>, pick?: (result: T) => SongProject): Promise<T | undefined> => {
      if (!api) {
        return undefined
      }

      const forKey = key
      setBusy(true)
      setError('')

      try {
        const result = await action(api)
        const next = pick ? pick(result) : (result as unknown as SongProject)

        if (next && typeof next === 'object' && 'schema' in next) {
          adopt(forKey, next)
        }

        return result
      } catch (err) {
        if (forKey === current.current) {
          setError(String(err instanceof Error ? err.message : err))
        }

        return undefined
      } finally {
        if (forKey === current.current) {
          setBusy(false)
        }
      }
    },
    [api, key, adopt]
  )

  return { scope, key, api, project, error, busy, outdated, run, setError }
}
