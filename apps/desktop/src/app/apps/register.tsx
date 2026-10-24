// Registers the Apps page, its sidebar row and its ⌘K entry through the same contribution
// areas plugins use, so the shell's nav/route tables stay untouched. Imported once by the
// contrib controller. Labels re-register on locale change (registration is not reactive).

import { lazy, Suspense } from 'react'

import { PALETTE_AREA, type PaletteContribution } from '@/app/command-palette/contrib'
import { registry } from '@/contrib/registry'
import { getRuntimeI18nLocale, subscribeRuntimeI18nLocale } from '@/i18n/runtime'

import { type RouteContribution, ROUTES_AREA, SIDEBAR_NAV_AREA, type SidebarNavContribution, syncWorkspaceRoute } from '../routes'

import { appsCopyFor } from './copy'

export const APPS_ROUTE = '/apps'

const AppsView = lazy(async () => ({ default: (await import('./index')).AppsView }))

function openApps() {
  window.location.hash = `#${APPS_ROUTE}`
  syncWorkspaceRoute(APPS_ROUTE)
}

function registerLabels(): () => void {
  const copy = appsCopyFor(getRuntimeI18nLocale())

  return registry.registerMany([
    {
      id: 'apps.nav',
      area: SIDEBAR_NAV_AREA,
      order: 40,
      data: { codicon: 'window', label: copy.nav, path: APPS_ROUTE } satisfies SidebarNavContribution
    },
    {
      id: 'apps.open',
      area: PALETTE_AREA,
      data: {
        id: 'apps.open',
        label: copy.title,
        keywords: ['apps', 'mini apps', 'pwa', 'tools'],
        run: openApps
      } satisfies PaletteContribution
    }
  ])
}

let registered = false

export function registerAppsSurface(): void {
  if (registered) {
    return
  }

  registered = true
  registry.register({
    id: 'apps.page',
    area: ROUTES_AREA,
    title: 'Apps',
    data: { path: APPS_ROUTE } satisfies RouteContribution,
    render: () => (
      <Suspense fallback={null}>
        <AppsView />
      </Suspense>
    )
  })

  let disposeLabels = registerLabels()

  subscribeRuntimeI18nLocale(() => {
    disposeLabels()
    disposeLabels = registerLabels()
  })
}
