import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'

import { type AppSessionIndex, getAppSessionIndex } from '@/api/apps'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { $activeGatewayProfile } from '@/store/profile'
import type { SessionInfo } from '@/types/hermes'

import type { SidebarSessionGroup } from '../chat/sidebar/projects/workspace-groups'

/** The sidebar's Apps section: one collapsible group per app (on by default). */
export const $sidebarAppsGroupByApp = persistentAtom('hermes.sidebar.appsGroupByApp', true, Codecs.bool)

export const OTHER_APP_GROUP = '__other__'
const REFRESH_MS = 30_000

/** Group `apps` sessions by the app that started them. Sessions the index doesn't know yet
 *  (just created, or from a removed app) collect in a trailing "Other" group. */
export function buildAppSessionGroups(
  sessions: SessionInfo[],
  index: AppSessionIndex | null,
  otherLabel: string
): SidebarSessionGroup[] {
  const groups = new Map<string, SidebarSessionGroup>()

  for (const session of sessions) {
    const slug = index?.sessions[session.id] ?? index?.sessions[session._lineage_root_id ?? ''] ?? OTHER_APP_GROUP
    const app = slug === OTHER_APP_GROUP ? null : index?.apps[slug]
    const label = app ? [app.icon, app.name].filter(Boolean).join(' ') : otherLabel

    const group = groups.get(slug) ?? { id: `apps:${slug}`, label, mode: 'source' as const, path: null, sessions: [], sourceId: 'apps' }

    group.sessions.push(session)
    groups.set(slug, group)
  }

  return [...groups.entries()]
    .sort(([a, ga], [b, gb]) => Number(a === OTHER_APP_GROUP) - Number(b === OTHER_APP_GROUP) || ga.label.localeCompare(gb.label))
    .map(([, group]) => group)
}

/** Groups for the Apps section, or undefined when grouping is off or there is nothing to group. */
export function useAppSessionGroups(sessions: SessionInfo[], otherLabel: string): SidebarSessionGroup[] | undefined {
  const enabled = useStore($sidebarAppsGroupByApp)
  const profile = useStore($activeGatewayProfile)
  const [index, setIndex] = useState<AppSessionIndex | null>(null)
  const active = enabled && sessions.length > 0
  // Refetch when a session the index hasn't seen appears (a new app request).
  const unknown = sessions.filter(session => !index?.sessions[session.id]).length

  useEffect(() => {
    if (!active) {
      return
    }

    let cancelled = false

    const load = () =>
      getAppSessionIndex(profile)
        .then(next => !cancelled && setIndex(next))
        .catch(() => undefined)

    void load()
    const timer = window.setInterval(load, REFRESH_MS)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [active, profile, unknown])

  return useMemo(
    () => (active ? buildAppSessionGroups(sessions, index, otherLabel) : undefined),
    [active, sessions, index, otherLabel]
  )
}
