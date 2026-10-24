import { useStore } from '@nanostores/react'
import type { ReactNode } from 'react'
import { useCallback, useMemo } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { SessionInfo } from '@/types/hermes'

import type { SidebarSessionGroup } from '../chat/sidebar/projects/workspace-groups'

import { useAppsCopy } from './copy'
import { $sidebarAppsGroupByApp, useAppSessionGroups } from './sidebar-groups'

const APPS_SOURCE = 'apps'

/** The sidebar's Apps section extras: per-app groups and the "Group by app" header toggle.
 *  Both are no-ops for every other messaging section. */
export function useAppsSidebarSection(sections: { sessions: SessionInfo[]; sourceId: string }[], buttonClassName: string) {
  const copy = useAppsCopy()
  const enabled = useStore($sidebarAppsGroupByApp)
  const appsSessions = useMemo(() => sections.find(section => section.sourceId === APPS_SOURCE)?.sessions ?? [], [sections])
  const groups = useAppSessionGroups(appsSessions, copy.otherApps)

  /** Groups limited to the rows the section's cap lets through. */
  const groupsFor = useCallback(
    (sourceId: string, shown: SessionInfo[]): SidebarSessionGroup[] | undefined => {
      if (sourceId !== APPS_SOURCE || !groups) {
        return undefined
      }

      const ids = new Set(shown.map(session => session.id))

      return groups
        .map(group => ({ ...group, sessions: group.sessions.filter(session => ids.has(session.id)) }))
        .filter(group => group.sessions.length > 0)
    },
    [groups]
  )

  const toggle: ReactNode = (
    <Tip label={copy.groupByApp}>
      <Button
        aria-label={copy.groupByApp}
        aria-pressed={enabled}
        className={cn(buttonClassName, enabled && 'text-foreground')}
        onClick={event => {
          event.stopPropagation()
          $sidebarAppsGroupByApp.set(!enabled)
        }}
        size="icon-xs"
        variant="ghost"
      >
        <Codicon name="list-tree" size="0.75rem" />
      </Button>
    </Tip>
  )

  const headerActionFor = (sourceId: string) => (sourceId === APPS_SOURCE ? toggle : undefined)

  return { groupsFor, headerActionFor }
}
