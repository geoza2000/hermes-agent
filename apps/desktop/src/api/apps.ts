// Hermes Apps owner API (`hermes_cli/web_routers/apps.py`). Profile-scoped like every
// settings call: an app belongs to one profile on one gateway.

import { hermesApi, profileScoped } from './client'

export type AppVisibility = 'private' | 'public'

export interface AppVersion {
  number: number
  published_at: number
  note: string
}

export interface HermesAppSummary {
  slug: string
  name: string
  icon: string
  description: string
  visibility: AppVisibility
  telemetry: { enabled: boolean; capture_values: boolean }
  current_version: null | number
  versions: AppVersion[]
  created_at: number
  updated_at: number
  profile: string
  /** Signed-in entry (`/apps/<profile>/<slug>/`): the stable address a browser or PWA keeps. */
  entry_path: string
  /** Present only while the owner has made the app public. */
  public_path: null | string
}

export interface AppInsights {
  days: number
  total_events: number
  public_events: number
  sessions: number
  by_type: Record<string, number>
  top_interactions: { label: string; count: number }[]
  errors: { target: string; count: number }[]
  per_day: Record<string, number>
}

export interface HermesAppDetail {
  app: HermesAppSummary
  insights: AppInsights
  data_keys: number
}

export interface AppLink {
  /** `/apps-cap/<token>/` — join with the connection's base URL. */
  path: string
  expires_at: number
  mode: 'live' | 'preview'
}

export type AppJobStatus = 'done' | 'failed' | 'needs_input' | 'queued' | 'running'

/** One request an app handed to Hermes (`hermes_cli/apps_jobs.py` public view). */
export interface AppJob {
  id: string
  status: AppJobStatus
  created_at: number
  updated_at: number
  prompt: string
  files: { name: string; size: number }[]
  session_id: null | string
  steps: { at: number; text: string }[]
  question: null | { ask_id: string; questions: { qid: string; question: string }[] }
  result: null | { text: string; json: unknown }
  error: null | string
  turns: number
}

export interface AppSettingsPatch {
  name?: string
  icon?: string
  description?: string
  visibility?: AppVisibility
  telemetry?: Partial<HermesAppSummary['telemetry']>
}

const appPath = (slug: string, suffix = '') => `/api/apps/${encodeURIComponent(slug)}${suffix}`

export function listApps(profile?: null | string): Promise<{ apps: HermesAppSummary[]; profile: string }> {
  return hermesApi({ ...profileScoped(profile), path: '/api/apps' })
}

export function getApp(slug: string, profile?: null | string): Promise<HermesAppDetail> {
  return hermesApi({ ...profileScoped(profile), path: appPath(slug) })
}

export function updateApp(slug: string, patch: AppSettingsPatch, profile?: null | string): Promise<{ app: HermesAppSummary }> {
  return hermesApi({ ...profileScoped(profile), path: appPath(slug), method: 'PATCH', body: patch })
}

export function rollbackApp(slug: string, version: number, profile?: null | string): Promise<{ app: HermesAppSummary }> {
  return hermesApi({ ...profileScoped(profile), path: appPath(slug, '/rollback'), method: 'POST', body: { version } })
}

export function mintAppLink(slug: string, options: { preview?: boolean } = {}, profile?: null | string): Promise<AppLink> {
  return hermesApi({ ...profileScoped(profile), path: appPath(slug, '/link'), method: 'POST', body: { preview: Boolean(options.preview) } })
}

export function listAppJobs(slug: string, profile?: null | string): Promise<{ jobs: AppJob[] }> {
  return hermesApi({ ...profileScoped(profile), path: appPath(slug, '/jobs') })
}

export function clearAppTelemetry(slug: string, profile?: null | string): Promise<{ removed_files: number }> {
  return hermesApi({ ...profileScoped(profile), path: appPath(slug, '/telemetry/clear'), method: 'POST' })
}

/** Absolute URL for a server path on the connected gateway. Returns null when the base is not http(s). */
export function gatewayUrl(baseUrl: null | string | undefined, path: string): null | string {
  if (!baseUrl) {
    return null
  }

  try {
    // Relative join keeps a reverse-proxy sub-path on the base.
    const url = new URL(path.replace(/^\/+/, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)

    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}
