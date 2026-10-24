import { type Dispatch, type SetStateAction, useCallback, useState } from 'react'

import type { PendingSource } from './use-capture'

/** Async completion stays with its original owner, even after another take is kept. */
export function usePendingSources(key: string) {
  const [sources, setSources] = useState<Record<string, PendingSource>>({})
  const pending = sources[key] ?? Object.values(sources)[0] ?? null

  const setPending: Dispatch<SetStateAction<PendingSource | null>> = useCallback(
    action => {
      setSources(current => {
        const selected = current[key] ?? Object.values(current)[0] ?? null
        const next = typeof action === 'function' ? action(selected) : action

        if (next === selected) {
          return current
        }

        if (next) {
          return { ...current, [next.key]: next }
        }

        if (!selected) {
          return current
        }

        const rest = { ...current }
        delete rest[selected.key]

        return rest
      })
    },
    [key]
  )

  return { pending, setPending }
}
