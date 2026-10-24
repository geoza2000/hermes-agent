/* eslint-disable no-restricted-imports -- First-party transcript cards need containing session/tile identity, absent from public directive props. */
import { useStore } from '@nanostores/react'

import { $apiRequestScope, resolveOwnerNow } from '@/api/client'
import { useComposerScope, useComposerSurfaceId } from '@/app/chat/composer/scope'
import { useSessionView } from '@/app/chat/session-view'
import { knownOwnerForSession } from '@/store/session-states'

export function useSongwritingScope() {
  const view = useSessionView()
  const stored = useStore(view.$storedId)
  const runtime = useStore(view.$runtimeId)
  const composer = useComposerScope()
  const surfaceId = useComposerSurfaceId()
  useStore($apiRequestScope)
  const known = knownOwnerForSession(stored ?? runtime)
  const route = typeof known === 'object' && known ? known : null

  const owner = resolveOwnerNow({
    connectionId: composer.connectionId ?? route?.connectionId,
    profile:
      composer.profile ?? route?.targetProfile ?? route?.profile ?? (typeof known === 'string' ? known : undefined)
  })

  const sessionId = stored ?? runtime

  return {
    key: JSON.stringify([owner.connectionId, owner.profile, sessionId, composer.target, surfaceId]),
    scope: sessionId ? { owner, sessionId } : null,
    target: composer.target,
    surfaceId
  }
}
