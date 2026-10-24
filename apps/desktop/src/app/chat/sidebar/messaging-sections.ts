import { normalizeSessionSource, sessionSourceLabel } from '@/lib/session-source'
import { messagingTotalsKey } from '@/store/profile'
import type { SessionInfo } from '@/types/hermes'

import { sessionRecency as sessionTime } from './projects'

export interface MessagingSection {
  sourceId: string
  label: string
  sessions: SessionInfo[]
  total: number
  hasMore: boolean
}

/** Each messaging platform is its own self-managed section: split the separately-fetched
 *  messaging slice by source, newest platform first, rows within a platform by recency.
 *  Per-platform totals (when a "load more" has resolved them) drive the count + whether
 *  more remain on disk. */
export function buildMessagingSections(
  visibleMessagingSessions: SessionInfo[],
  isPinnedSession: (session: SessionInfo) => boolean,
  messagingPlatformTotals: Record<string, number>,
  messagingTruncated: boolean,
  messagingProfile: Parameters<typeof messagingTotalsKey>[0]
): MessagingSection[] {
  if (!visibleMessagingSessions.length) {
    return []
  }

  const bySource = new Map<string, SessionInfo[]>()
  // Rows this platform owns that the Pinned section is showing instead. The
  // backend's per-platform total counts them, so discount it or "load more"
  // promises rows that will never appear.
  const pinnedBySource = new Map<string, number>()

  for (const session of visibleMessagingSessions) {
    const sourceId = normalizeSessionSource(session.source)

    if (!sourceId) {
      continue
    }

    if (isPinnedSession(session)) {
      pinnedBySource.set(sourceId, (pinnedBySource.get(sourceId) ?? 0) + 1)

      continue
    }

    const list = bySource.get(sourceId) ?? []
    list.push(session)
    bySource.set(sourceId, list)
  }

  return [...bySource.entries()]
    .map(([sourceId, list]) => {
      const ordered = [...list].sort((a, b) => sessionTime(b) - sessionTime(a))
      const known = messagingPlatformTotals[messagingTotalsKey(messagingProfile, sourceId)]
      const unpinnedKnown = known == null ? null : Math.max(0, known - (pinnedBySource.get(sourceId) ?? 0))
      const total = Math.max(ordered.length, unpinnedKnown ?? 0)

      return {
        // Known exact total → more exist iff total exceeds loaded; otherwise
        // the seed fetch was capped, so assume more until a per-platform load
        // resolves the count.
        hasMore: unpinnedKnown != null ? unpinnedKnown > ordered.length : messagingTruncated,
        label: sessionSourceLabel(sourceId) ?? sourceId,
        sessions: ordered,
        sourceId,
        total
      }
    })
    .sort((a, b) => sessionTime(b.sessions[0]) - sessionTime(a.sessions[0]))
}
