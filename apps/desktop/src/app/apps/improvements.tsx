import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import {
  type AppImprovementState,
  decideSuggestion,
  getAppImprovements,
  getImprovementDefaults,
  type ImprovementSchedule,
  type ImprovementSettings,
  publishAppRevision,
  reviewAppDraft,
  runAppReview,
  saveAppImprovements,
  saveImprovementDefaults
} from '@/api/apps'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Switch } from '@/components/ui/switch'
import { notify, notifyError } from '@/store/notifications'

import { IMPROVEMENTS_COPY as c } from './improvements-copy'

const SCHEDULES = Object.keys(c.schedules) as ImprovementSchedule[]
const FIELD = 'h-7 rounded-md border border-(--ui-stroke-tertiary) bg-background px-2 text-xs'
type Fields = Pick<ImprovementSettings, 'enabled' | 'schedule' | 'token_budget'>

const fields = ({ enabled, schedule, token_budget }: ImprovementSettings): Fields => ({ enabled, schedule, token_budget })

function SettingsFields({ onChange, value }: { onChange: (next: Fields) => void; value: Fields }) {
  return (
    <div className="grid gap-2 text-xs">
      <label className="flex items-center justify-between gap-2">
        <span>{c.enabled}</span>
        <Switch checked={value.enabled} onCheckedChange={enabled => onChange({ ...value, enabled })} />
      </label>
      <label className="flex items-center justify-between gap-2">
        <span>{c.when}</span>
        <select
          aria-label={c.when}
          className={FIELD}
          disabled={!value.enabled}
          onChange={event => onChange({ ...value, schedule: event.target.value as ImprovementSchedule })}
          value={value.schedule}
        >
          {SCHEDULES.map(id => (
            <option key={id} value={id}>
              {c.schedules[id]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center justify-between gap-2">
        <span>{c.cap}</span>
        <input
          aria-label={c.cap}
          className={`${FIELD} w-24`}
          disabled={!value.enabled}
          max={100000}
          min={512}
          onChange={event => onChange({ ...value, token_budget: Number(event.target.value) })}
          step={500}
          type="number"
          value={value.token_budget}
        />
      </label>
    </div>
  )
}

/** Defaults every app inherits, shown above the Apps gallery. */
export function ImprovementDefaults({ profile }: { profile: null | string }) {
  const query = useQuery({ queryFn: () => getImprovementDefaults(profile), queryKey: ['apps-improvements', profile] })
  const [draft, setDraft] = useState<Fields | null>(null)
  const value = draft ?? (query.data ? fields(query.data.settings) : null)

  if (!value) {
    return null
  }

  const save = async () => {
    try {
      await saveImprovementDefaults(value, profile)
      setDraft(null)
      await query.refetch()
      notify({ kind: 'success', message: c.saved })
    } catch (error) {
      notifyError(error, c.title)
    }
  }

  return (
    <section
      aria-label={c.title}
      className="mx-4 mb-3 grid gap-2 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-chat-bubble-background) p-3"
    >
      <div>
        <div className="text-sm font-medium">{c.title}</div>
        <p className="text-xs text-muted-foreground">{c.intro}</p>
      </div>
      <SettingsFields onChange={setDraft} value={value} />
      <p className="text-[0.6875rem] text-(--ui-text-tertiary)">{c.autoOff}</p>
      <div>
        <Button disabled={!draft} onClick={() => void save()} size="xs" variant="outline">
          {c.save}
        </Button>
      </div>
    </section>
  )
}

/** One app: its schedule, the last review, and suggestions to approve or dismiss, then publish. */
export function AppImprovementsCard({ profile, slug }: { profile: null | string; slug: string }) {
  const queryClient = useQueryClient()
  const key = ['app-improvements', profile, slug]

  const state = useQuery({
    queryFn: () => getAppImprovements(slug, profile),
    queryKey: key,
    refetchInterval: q => (['queued', 'running'].includes(q.state.data?.request?.status ?? '') ? 3000 : false)
  })

  const [custom, setCustom] = useState<Fields | null>(null)
  const [busy, setBusy] = useState(false)
  const [publishing, setPublishing] = useState<null | string>(null)
  const data = state.data

  useEffect(() => setCustom(data?.override ? fields(data.settings) : null), [data?.override, data?.settings])

  if (!data) {
    return null
  }

  const act = async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true)

    try {
      const next = await action()

      if (next && typeof next === 'object' && 'suggestions' in next) {
        queryClient.setQueryData<AppImprovementState>(key, prev => (prev ? { ...prev, ...(next as object) } : prev))
      }

      await state.refetch()

      if (done) {
        notify({ kind: 'success', message: done })
      }
    } catch (error) {
      notifyError(error, c.title)
    } finally {
      setBusy(false)
    }
  }

  const reviewing = ['queued', 'running'].includes(data.request?.status ?? '')
  const pending = data.suggestions.filter(s => s.status === 'pending')
  const last = data.runs.at(-1)
  const applied = data.suggestions.some(s => s.status === 'applied')

  return (
    <div className="rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-chat-bubble-background) p-3 text-xs">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-[0.625rem] font-medium uppercase tracking-[0.08em] text-(--ui-text-tertiary)">{c.title}</div>
        <Button
          disabled={busy || reviewing}
          onClick={() => void act(() => runAppReview(slug, profile), c.started)}
          size="xs"
          variant="outline"
        >
          {reviewing ? c.running : c.runNow}
        </Button>
      </div>
      <label className="mb-2 flex items-center justify-between gap-2">
        <span>{c.ownSchedule}</span>
        <Switch
          checked={custom !== null}
          onCheckedChange={on =>
            on ? setCustom(fields(data.settings)) : void act(() => saveAppImprovements(slug, null, profile))
          }
        />
      </label>
      {custom ? (
        <div className="grid gap-2">
          <SettingsFields onChange={setCustom} value={custom} />
          <div>
            <Button
              disabled={busy}
              onClick={() => void act(() => saveAppImprovements(slug, custom, profile), c.savedApp)}
              size="xs"
              variant="outline"
            >
              {c.save}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground">
          {data.settings.enabled ? c.following(c.schedules[data.settings.schedule], data.settings.token_budget) : c.off}
        </p>
      )}
      {last && (
        <p className="mt-2" data-run-status={last.status}>
          {c.lastRun}: {c.runStatus[last.status] ?? last.status}
          {last.total_tokens ? ` · ${c.tokens(last.total_tokens, last.budget)}` : ''}
          {last.error ? ` · ${last.error}` : ''}
        </p>
      )}
      <div className="mt-2 grid gap-2">
        {pending.length === 0 ? (
          <p className="text-muted-foreground">{c.none}</p>
        ) : (
          pending.map(s => (
            <article className="rounded-md border border-(--ui-stroke-tertiary) p-2" data-suggestion={s.id} key={s.id}>
              <div className="font-medium">{s.title}</div>
              <p className="text-muted-foreground">{s.reason}</p>
              <ul className="mt-1 list-disc pl-4 text-(--ui-text-tertiary)">
                {Object.entries(s.evidence).map(([name, count]) => (
                  <li key={name}>
                    {name.replace(/^(top_interactions|errors):/, '')}: {count}
                  </li>
                ))}
              </ul>
              <details className="mt-1">
                <summary>{c.change(s.edit.path)}</summary>
                <pre className="whitespace-pre-wrap break-words rounded bg-(--ui-stroke-tertiary)/30 p-1.5">
                  - {s.edit.before}
                  {'\n'}+ {s.edit.after}
                </pre>
              </details>
              <div className="mt-1.5 flex gap-1.5">
                <Button
                  disabled={busy}
                  onClick={() => void act(() => decideSuggestion(slug, s.id, 'approve', profile), c.applied)}
                  size="xs"
                >
                  {c.approve}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => void act(() => decideSuggestion(slug, s.id, 'dismiss', profile))}
                  size="xs"
                  variant="outline"
                >
                  {c.dismiss}
                </Button>
              </div>
            </article>
          ))
        )}
      </div>
      {applied && (
        <div className="mt-2">
          <Button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const reviewed = await reviewAppDraft(slug, profile)
                setPublishing(reviewed.revision)
              })
            }
            size="xs"
            variant="outline"
          >
            {c.publish}
          </Button>
        </div>
      )}
      <ConfirmDialog
        confirmLabel={c.publish}
        description={c.publishBody}
        onClose={() => setPublishing(null)}
        onConfirm={async () => {
          const revision = publishing

          setPublishing(null)

          if (revision) {
            await act(async () => {
              const result = await publishAppRevision(slug, revision, 'Approved improvement', profile)
              await queryClient.invalidateQueries({ queryKey: ['app', profile, slug] })
              notify({ kind: 'success', message: c.published(result.app.current_version ?? 0) })
            })
          }
        }}
        open={publishing !== null}
        title={c.publishTitle}
      />
    </div>
  )
}

const TIP_KEY = (profile: null | string, slug: string) => `hermes.apps.installTip.${profile ?? 'default'}/${slug}`

/** A one-time, dismissible install nudge for a published app, and the instructions on demand. */
export function InstallCard({ profile, published, slug }: { profile: null | string; published: boolean; slug: string }) {
  const [tipHidden, setTipHidden] = useState(() => {
    try {
      return window.localStorage.getItem(TIP_KEY(profile, slug)) === 'dismissed'
    } catch {
      return false
    }
  })

  const [open, setOpen] = useState(false)

  const dismiss = () => {
    try {
      window.localStorage.setItem(TIP_KEY(profile, slug), 'dismissed')
    } catch {
      // Storage unavailable: the tip just shows again next time.
    }

    setTipHidden(true)
  }

  return (
    <div className="rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-chat-bubble-background) p-3 text-xs">
      {published && !tipHidden && !open ? (
        <div className="flex flex-wrap items-center gap-1.5" data-install-tip>
          <span className="w-full">{c.installTip}</span>
          <Button
            onClick={() => {
              setOpen(true)
              dismiss()
            }}
            size="xs"
            variant="outline"
          >
            {c.showMe}
          </Button>
          <Button onClick={dismiss} size="xs" variant="text">
            {c.notNow}
          </Button>
        </div>
      ) : (
        <Button onClick={() => setOpen(!open)} size="xs" variant="text">
          {c.installTitle}
        </Button>
      )}
      {open && (
        <div className="mt-1.5 grid gap-1 text-muted-foreground">
          <p>{c.installMac}</p>
          <p>{c.installPhone}</p>
        </div>
      )}
    </div>
  )
}
