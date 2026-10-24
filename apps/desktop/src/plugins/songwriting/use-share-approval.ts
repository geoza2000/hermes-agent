import { useCallback, useEffect, useRef, useState } from 'react'

import type { SongGoal, SongScope } from './api'

interface ShareSnapshot {
  key: string
  scope: SongScope | null
  savedPath?: string
  brief: string
  goal: SongGoal
  revision?: number
}

/** Approval authorizes one reviewed message, not subsequent edits or revisions. */
export function useShareApproval(snapshot: ShareSnapshot) {
  const signature =
    snapshot.scope && snapshot.savedPath && snapshot.revision !== undefined
      ? JSON.stringify([
          snapshot.key,
          snapshot.scope.owner.connectionId,
          snapshot.scope.owner.profile,
          snapshot.scope.sessionId,
          snapshot.savedPath,
          snapshot.brief,
          snapshot.goal,
          snapshot.revision
        ])
      : null

  const [approvedSignature, setApprovedSignature] = useState<string | null>(null)
  const live = useRef({ signature, approval: null as string | null })
  live.current.signature = signature

  const setApproved = useCallback((checked: boolean) => {
    live.current.approval = checked ? live.current.signature : null
    setApprovedSignature(live.current.approval)
  }, [])

  useEffect(() => setApproved(false), [signature, setApproved])

  const isApproved = useCallback(
    () => live.current.approval !== null && live.current.approval === live.current.signature,
    []
  )

  return { approved: signature !== null && approvedSignature === signature, setApproved, isApproved }
}
