import { useEffect, useRef, useState } from 'react'

import { createSongwritingApi, type SongProject, type SongScope } from './api'

export function useSongProject(key: string, scope: SongScope | null) {
  const [cached, setCached] = useState<{ key: string; project: SongProject } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const live = useRef({ key, epoch: 0, serial: 0, mounted: true, busy: false })

  if (live.current.key !== key) {
    live.current.key = key
    live.current.epoch++
  }

  const epoch = live.current.epoch
  const currentScope = () => live.current.mounted && live.current.epoch === epoch
  const api = scope ? createSongwritingApi(scope) : null

  const setProject = (project: SongProject) => {
    if (currentScope()) {
      setCached({ key, project })
    }
  }

  const run = async (action: (api: ReturnType<typeof createSongwritingApi>) => Promise<void>) => {
    if (!api || live.current.busy) {
      return
    }

    const serial = ++live.current.serial
    const current = () => live.current.mounted && key === live.current.key && serial === live.current.serial
    live.current.busy = true
    setBusy(true)
    setError('')

    try {
      await action(api)
    } catch (err) {
      if (current()) {
        setError(String(err))
      }
    } finally {
      if (current()) {
        live.current.busy = false
        setBusy(false)
      }
    }
  }

  useEffect(() => {
    live.current.mounted = true
    live.current.busy = false
    setBusy(false)
    setError('')
    const serial = ++live.current.serial
    let active = true

    if (scope) {
      setBusy(true)
      live.current.busy = true
      createSongwritingApi(scope)
        .project()
        .then(project => {
          if (active && serial === live.current.serial) {
            setCached({ key, project })
          }
        })
        .catch(err => {
          if (active) {
            setError(String(err))
          }
        })
        .finally(() => {
          if (active && serial === live.current.serial) {
            setBusy(false)
            live.current.busy = false
          }
        })
    }

    return () => {
      active = false
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Teardown invalidates the current in-flight operation.
      live.current.serial++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key encodes the entire owner/session/surface; scope is an ephemeral wrapper.
  }, [key])
  useEffect(
    () => () => {
      live.current.mounted = false
      live.current.serial++
    },
    []
  )

  return {
    project: cached?.key === key ? cached.project : null,
    busy,
    error,
    run,
    api,
    isCurrent: currentScope,
    setProject,
    refresh: () =>
      run(async api => {
        const project = await api.project()

        if (key === live.current.key) {
          setProject(project)
        }
      })
  }
}
