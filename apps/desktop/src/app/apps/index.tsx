import { useStore } from '@nanostores/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'

import {
  type AppInsights,
  type AppJob,
  clearAppTelemetry,
  gatewayUrl,
  getApp,
  type HermesAppSummary,
  listAppJobs,
  listApps,
  mintAppLink,
  rollbackApp,
  updateApp
} from '@/api/apps'
import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { RowButton } from '@/components/ui/row-button'
import { SandboxedFrame } from '@/components/ui/sandboxed-frame'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { composerHost } from '@/sdk/composer'
import { notify, notifyError } from '@/store/notifications'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { $connection } from '@/store/session'

import { openSessionFromPicker } from '../open-session'
import { PageSearchShell } from '../page-search-shell'
import { NEW_CHAT_ROUTE } from '../routes'

import { type AppsCopy, useAppsCopy } from './copy'

// Links last 12 h server-side; refresh well before that so a long-open page never shows a dead frame.
const LINK_STALE_MS = 6 * 60 * 60 * 1000

type PreviewMode = 'draft' | 'live'

function useAppsScope() {
  const profile = normalizeProfileKey(useStore($activeGatewayProfile))
  const connection = useStore($connection)

  return { baseUrl: connection?.baseUrl ?? null, isRemote: connection?.mode === 'remote', profile }
}

export function AppsView() {
  const copy = useAppsCopy()
  const { profile } = useAppsScope()
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const selected = params.get('app')

  const apps = useQuery({ queryFn: () => listApps(profile), queryKey: ['apps', profile] })

  const select = useCallback(
    (slug: null | string) =>
      setParams(
        current => {
          const next = new URLSearchParams(current)
          slug ? next.set('app', slug) : next.delete('app')

          return next
        },
        { replace: false }
      ),
    [setParams]
  )

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const rows = apps.data?.apps ?? []

    return needle ? rows.filter(app => `${app.name} ${app.description} ${app.slug}`.toLowerCase().includes(needle)) : rows
  }, [apps.data, query])

  if (selected) {
    return <AppDetail copy={copy} onBack={() => select(null)} slug={selected} />
  }

  return (
    <PageSearchShell
      onSearchChange={setQuery}
      searchHidden={!apps.data?.apps.length}
      searchPlaceholder={copy.search}
      searchValue={query}
    >
      <AppsGallery
        apps={visible}
        copy={copy}
        error={apps.error}
        filtered={Boolean(query.trim())}
        loading={apps.isPending}
        onOpen={select}
      />
    </PageSearchShell>
  )
}

interface AppsGalleryProps {
  apps: HermesAppSummary[]
  copy: AppsCopy
  error: unknown
  filtered: boolean
  loading: boolean
  onOpen: (slug: string) => void
}

function AppsGallery({ apps, copy, error, filtered, loading, onOpen }: AppsGalleryProps) {
  if (loading) {
    return <PageLoader label={copy.loading} />
  }

  if (error || apps.length === 0) {
    const title = error ? copy.loadFailed : filtered ? copy.noMatch : copy.emptyTitle

    return (
      <div className="grid h-full place-items-center px-6 text-center">
        <div className="max-w-sm">
          <div className="text-sm font-medium">{title}</div>
          {!error && !filtered && <div className="mt-1 text-xs text-muted-foreground">{copy.emptyBody}</div>}
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2 px-3 pb-3">
        {apps.map(app => (
          <AppCard app={app} copy={copy} key={app.slug} onOpen={onOpen} />
        ))}
      </div>
    </div>
  )
}

function AppCard({ app, copy, onOpen }: { app: HermesAppSummary; copy: AppsCopy; onOpen: (slug: string) => void }) {
  return (
    <RowButton
      className="flex flex-col gap-2 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-chat-bubble-background) p-3 text-left transition-colors hover:bg-(--ui-control-hover-background)"
      data-app={app.slug}
      onClick={() => onOpen(app.slug)}
    >
      <div aria-hidden className="grid size-9 place-items-center rounded-lg bg-(--ui-bg-tertiary) text-lg">
        {app.icon}
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{app.name}</div>
        {app.description && <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{app.description}</div>}
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-1">
        <Pill>{app.current_version ? copy.version(app.current_version) : copy.draftOnly}</Pill>
        <Pill tone={app.visibility === 'public' ? 'accent' : 'muted'}>
          {app.visibility === 'public' ? copy.public : copy.private}
        </Pill>
      </div>
    </RowButton>
  )
}

function Pill({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'accent' | 'muted' }) {
  return (
    <span
      className={cn(
        'rounded-full px-1.5 py-px text-[0.625rem] font-medium',
        tone === 'accent' ? 'bg-(--theme-accent-soft) text-(--ui-text-accent,currentColor)' : 'bg-(--ui-bg-tertiary) text-(--ui-text-tertiary)'
      )}
    >
      {children}
    </span>
  )
}

// ── detail ──────────────────────────────────────────────────────────────────────────────────────

function useAppMutations(slug: string, profile: null | string, copy: AppsCopy) {
  const queryClient = useQueryClient()

  const refresh = useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['apps', profile] }),
        queryClient.invalidateQueries({ queryKey: ['app', profile, slug] })
      ]),
    [profile, queryClient, slug]
  )

  const run = useCallback(
    async (action: () => Promise<unknown>, done?: string) => {
      try {
        await action()

        if (done) {
          notify({ kind: 'success', message: done })
        }
      } catch (error) {
        notifyError(error, copy.saveFailed)
      } finally {
        await refresh()
      }
    },
    [copy.saveFailed, refresh]
  )

  return { refresh, run }
}

function AppDetail({ copy, onBack, slug }: { copy: AppsCopy; onBack: () => void; slug: string }) {
  const { baseUrl, isRemote, profile } = useAppsScope()
  const navigate = useNavigate()
  const detail = useQuery({ queryFn: () => getApp(slug, profile), queryKey: ['app', profile, slug] })
  const app = detail.data?.app
  const [mode, setMode] = useState<PreviewMode>('live')
  const effectiveMode: PreviewMode = app && !app.current_version ? 'draft' : mode
  const { run } = useAppMutations(slug, profile, copy)

  const link = useQuery({
    enabled: Boolean(app),
    queryFn: () => mintAppLink(slug, { preview: effectiveMode === 'draft' }, profile),
    queryKey: ['app-link', profile, slug, effectiveMode, app?.current_version ?? 0],
    staleTime: LINK_STALE_MS
  })

  const openInBrowser = useCallback(async () => {
    try {
      const fresh = await mintAppLink(slug, { preview: effectiveMode === 'draft' }, profile)
      const url = gatewayUrl(baseUrl, fresh.path)

      if (url) {
        await window.hermesDesktop?.openExternal?.(url)
      }
    } catch (error) {
      notifyError(error, copy.saveFailed)
    }
  }, [baseUrl, copy.saveFailed, effectiveMode, profile, slug])

  const copyPhoneLink = useCallback(async () => {
    try {
      const url = gatewayUrl(baseUrl, (await mintAppLink(slug, {}, profile)).path)

      if (url) {
        await navigator.clipboard.writeText(url)
        notify({ kind: 'success', message: copy.linkCopied })
      }
    } catch (error) {
      notifyError(error, copy.saveFailed)
    }
  }, [baseUrl, copy, profile, slug])

  const iterate = useCallback(() => {
    if (!app) {
      return
    }

    navigate(NEW_CHAT_ROUTE)
    void composerHost.setDraft(null, copy.iteratePrompt(app.name, app.slug)).then(() => composerHost.focus(null))
  }, [app, copy, navigate])

  if (detail.isPending) {
    return <PageLoader label={copy.loading} />
  }

  if (!app) {
    return (
      <div className="grid h-full place-items-center px-6 text-center text-sm">
        <div>
          <div className="font-medium">{copy.loadFailed}</div>
          <Button className="mt-2" onClick={onBack} size="sm" variant="outline">
            {copy.back}
          </Button>
        </div>
      </div>
    )
  }

  const frameUrl = link.data ? gatewayUrl(baseUrl, link.data.path) : null

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 px-4 pb-2 pt-[calc(var(--titlebar-height)+0.5rem)]">
        <Button onClick={onBack} size="sm" variant="ghost">
          ← {copy.back}
        </Button>
        <span aria-hidden className="text-lg">
          {app.icon}
        </span>
        <h1 className="truncate text-sm font-semibold">{app.name}</h1>
        <Pill>{app.current_version ? copy.version(app.current_version) : copy.draftOnly}</Pill>
        <Pill tone={app.visibility === 'public' ? 'accent' : 'muted'}>
          {app.visibility === 'public' ? copy.public : copy.private}
        </Pill>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button onClick={() => void openInBrowser()} size="sm" variant="outline">
            {copy.openInBrowser}
          </Button>
          {isRemote && (
            <Button onClick={() => void copyPhoneLink()} size="sm" variant="outline">
              {copy.copyPhoneLink}
            </Button>
          )}
          <Button onClick={iterate} size="sm">
            {copy.iterate}
          </Button>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_20rem] gap-3 px-4 pb-4 max-[900px]:grid-cols-1">
        <div className="flex min-h-[20rem] flex-col overflow-hidden rounded-lg border border-(--ui-stroke-tertiary) bg-background">
          <div className="flex items-center gap-2 border-b border-(--ui-stroke-tertiary) px-2 py-1.5 text-xs text-(--ui-text-tertiary)">
            <span>{copy.preview}</span>
            <SegmentedControl
              disabled={!app.current_version}
              onChange={setMode}
              options={[
                { id: 'live', label: copy.previewLive },
                { id: 'draft', label: copy.previewDraft }
              ]}
              value={effectiveMode}
            />
            {!app.current_version && <span className="truncate">{copy.notPublished}</span>}
          </div>
          {frameUrl ? (
            <SandboxedFrame
              className="min-h-0 flex-1 bg-white"
              sandbox="allow-scripts allow-forms allow-downloads"
              src={frameUrl}
              title={app.name}
            />
          ) : (
            <div className="grid flex-1 place-items-center p-6 text-center text-xs text-muted-foreground">
              {link.isPending ? copy.loading : copy.frameUnavailable}
            </div>
          )}
        </div>
        <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          <RunsCard copy={copy} profile={profile} slug={app.slug} />
          {/* Apps are personal for now: the public switch only appears to turn an already-public app back off. */}
          {app.visibility === 'public' && (
            <SharingCard app={app} baseUrl={baseUrl} copy={copy} profile={profile} run={run} />
          )}
          <UsageCard app={app} copy={copy} insights={detail.data?.insights} profile={profile} run={run} />
          <VersionsCard app={app} copy={copy} profile={profile} run={run} />
        </aside>
      </div>
    </section>
  )
}

type Run = (action: () => Promise<unknown>, done?: string) => Promise<void>

interface CardProps {
  app: HermesAppSummary
  copy: AppsCopy
  profile: null | string
  run: Run
}

function Card({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <div className="rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-chat-bubble-background) p-3">
      <div className="mb-2 text-[0.625rem] font-medium uppercase tracking-[0.08em] text-(--ui-text-tertiary)">{title}</div>
      {children}
    </div>
  )
}

function SharingCard({ app, baseUrl, copy, profile, run }: CardProps & { baseUrl: null | string }) {
  const [confirming, setConfirming] = useState(false)
  const isPublic = app.visibility === 'public'
  const publicUrl = app.public_path ? gatewayUrl(baseUrl, app.public_path) : null

  const setVisibility = (visibility: 'private' | 'public') => run(() => updateApp(app.slug, { visibility }, profile))

  return (
    <Card title={copy.sharing}>
      <p className="text-xs text-muted-foreground">{isPublic ? copy.sharingPublic : copy.sharingPrivate}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button
          onClick={() => (isPublic ? void setVisibility('private') : setConfirming(true))}
          size="xs"
          variant="outline"
        >
          {isPublic ? copy.makePrivate : copy.makePublic}
        </Button>
        {publicUrl && (
          <Button
            onClick={() => void navigator.clipboard.writeText(publicUrl).then(() => notify({ kind: 'success', message: copy.copyPublicLink }))}
            size="xs"
            variant="outline"
          >
            {copy.copyPublicLink}
          </Button>
        )}
      </div>
      <ConfirmDialog
        confirmLabel={copy.makePublic}
        description={copy.confirmPublic}
        onClose={() => setConfirming(false)}
        onConfirm={() => setVisibility('public')}
        open={confirming}
        title={copy.makePublic}
      />
    </Card>
  )
}

function UsageCard({ app, copy, insights, profile, run }: CardProps & { insights?: AppInsights }) {
  const telemetry = app.telemetry

  const setTelemetry = (patch: Partial<HermesAppSummary['telemetry']>) =>
    run(() => updateApp(app.slug, { telemetry: patch }, profile))

  return (
    <Card title={copy.usage}>
      <label className="flex items-center justify-between gap-2 text-xs">
        <span>{copy.usageEnabled}</span>
        <Switch checked={telemetry.enabled} onCheckedChange={enabled => void setTelemetry({ enabled })} />
      </label>
      <label className="mt-2 flex items-center justify-between gap-2 text-xs">
        <span>{copy.usageValues}</span>
        <Switch
          checked={telemetry.capture_values}
          disabled={!telemetry.enabled}
          onCheckedChange={capture_values => void setTelemetry({ capture_values })}
        />
      </label>
      <p className="mt-1 text-[0.625rem] text-(--ui-text-tertiary)">{copy.usageValuesHint}</p>
      <InsightsSummary copy={copy} insights={insights} />
      {insights && insights.total_events > 0 && (
        <Button
          className="mt-2"
          onClick={() => void run(() => clearAppTelemetry(app.slug, profile), copy.usageCleared)}
          size="xs"
          variant="ghost"
        >
          {copy.clearUsage}
        </Button>
      )}
    </Card>
  )
}

function InsightsSummary({ copy, insights }: { copy: AppsCopy; insights?: AppInsights }) {
  if (!insights || insights.total_events === 0) {
    return <p className="mt-2 text-xs text-muted-foreground">{copy.noUsage}</p>
  }

  return (
    <div className="mt-2 space-y-2 text-xs">
      <p className="text-muted-foreground">{copy.usageSummary(insights.total_events, insights.sessions, insights.days)}</p>
      {insights.top_interactions.length > 0 && (
        <CountList label={copy.topInteractions} rows={insights.top_interactions.slice(0, 5).map(r => [r.label, r.count])} />
      )}
      {insights.errors.length > 0 && <CountList label={copy.errors} rows={insights.errors.map(r => [r.target, r.count])} />}
    </div>
  )
}

function CountList({ label, rows }: { label: string; rows: [string, number][] }) {
  return (
    <div>
      <div className="mb-0.5 font-medium">{label}</div>
      <ul className="space-y-0.5">
        {rows.map(([name, count]) => (
          <li className="flex justify-between gap-2" key={name}>
            <span className="truncate text-muted-foreground">{name}</span>
            <span className="tabular-nums">{count}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function VersionsCard({ app, copy, profile, run }: CardProps) {
  const versions = [...app.versions].sort((a, b) => b.number - a.number)

  if (versions.length === 0) {
    return null
  }

  return (
    <Card title={copy.versions}>
      <ul className="space-y-1.5 text-xs">
        {versions.map(version => (
          <li className="flex items-start justify-between gap-2" key={version.number}>
            <div className="min-w-0">
              <div className="font-medium">
                {copy.version(version.number)}
                <span className="ml-1.5 font-normal text-(--ui-text-tertiary)">
                  {new Date(version.published_at * 1000).toLocaleDateString()}
                </span>
              </div>
              {version.note && <div className="truncate text-muted-foreground">{version.note}</div>}
            </div>
            {version.number === app.current_version ? (
              <Pill tone="accent">{copy.current}</Pill>
            ) : (
              <Button
                onClick={() => void run(() => rollbackApp(app.slug, version.number, profile), copy.restored(version.number))}
                size="xs"
                variant="outline"
              >
                {copy.restore}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}

const ACTIVE_JOB = new Set<AppJob['status']>(['needs_input', 'queued', 'running'])
const NEEDS_YOU = new Set<AppJob['status']>(['failed', 'needs_input', 'waiting'])

/** Requests this app handed to Hermes. Each runs as an `apps` session, grouped under Apps in the sidebar. */
function RunsCard({ copy, profile, slug }: { copy: AppsCopy; profile: null | string; slug: string }) {
  const navigate = useNavigate()

  const jobs = useQuery({
    queryFn: () => listAppJobs(slug, profile),
    queryKey: ['app-jobs', profile, slug],
    refetchInterval: query => (query.state.data?.jobs.some(job => ACTIVE_JOB.has(job.status)) ? 3000 : false)
  })

  const rows = jobs.data?.jobs.slice(0, 6) ?? []

  return (
    <Card title={copy.runs}>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{copy.noRuns}</p>
      ) : (
        <ul className="space-y-2 text-xs">
          {rows.map(job => (
            <li className="flex items-start justify-between gap-2" data-job={job.id} key={job.id}>
              <div className="min-w-0">
                <div className="truncate font-medium">
                  {job.prompt || job.files.map(file => file.name).join(', ') || job.id}
                </div>
                <div className="truncate text-(--ui-text-tertiary)">
                  {job.error || job.steps.at(-1)?.text || new Date(job.created_at * 1000).toLocaleString()}
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Pill tone={NEEDS_YOU.has(job.status) ? 'accent' : 'muted'}>
                  {copy.runStatus[job.status]}
                </Pill>
                {job.session_id && (
                  <Button
                    onClick={() => void openSessionFromPicker(job.session_id!, navigate)}
                    size="xs"
                    variant="text"
                  >
                    {copy.openSession}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
