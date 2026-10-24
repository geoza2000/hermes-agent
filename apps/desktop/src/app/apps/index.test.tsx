import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as AppsApi from '@/api/apps'

const mocks = vi.hoisted(() => ({
  listApps: vi.fn(),
  getApp: vi.fn(),
  mintAppLink: vi.fn(),
  updateApp: vi.fn(),
  rollbackApp: vi.fn(),
  clearAppTelemetry: vi.fn(),
  listAppJobs: vi.fn(),
  openSession: vi.fn(),
  notify: vi.fn(),
  notifyError: vi.fn()
}))

vi.mock('@/api/apps', async () => {
  const actual = await vi.importActual<typeof AppsApi>('@/api/apps')

  return {
    ...actual,
    listApps: (profile?: string) => mocks.listApps(profile),
    getApp: (slug: string, profile?: string) => mocks.getApp(slug, profile),
    mintAppLink: (slug: string, options: unknown, profile?: string) => mocks.mintAppLink(slug, options, profile),
    updateApp: (slug: string, patch: unknown, profile?: string) => mocks.updateApp(slug, patch, profile),
    rollbackApp: (slug: string, version: number, profile?: string) => mocks.rollbackApp(slug, version, profile),
    clearAppTelemetry: (slug: string, profile?: string) => mocks.clearAppTelemetry(slug, profile),
    listAppJobs: (slug: string, profile?: string) => mocks.listAppJobs(slug, profile)
  }
})

vi.mock('@/store/profile', async () => {
  const { atom } = await import('nanostores')

  return {
    $activeGatewayProfile: atom('alpha'),
    normalizeProfileKey: (value: string | null | undefined) => String(value ?? '').trim() || 'default'
  }
})

vi.mock('@/store/session', async () => {
  const { atom } = await import('nanostores')

  return { $connection: atom({ baseUrl: 'http://127.0.0.1:9119', mode: 'local' }) }
})

vi.mock('@/store/notifications', () => ({ notify: mocks.notify, notifyError: mocks.notifyError }))
vi.mock('../open-session', () => ({ openSessionFromPicker: (id: string) => mocks.openSession(id) }))
vi.mock('@/sdk/composer', () => ({ composerHost: { setDraft: vi.fn(async () => true), focus: vi.fn() } }))

import { gatewayUrl, type HermesAppSummary } from '@/api/apps'

import { AppsView } from './index'

const invoices: HermesAppSummary = {
  slug: 'invoices',
  name: 'Invoices',
  icon: '🧾',
  description: 'Invoice records',
  visibility: 'private',
  telemetry: { enabled: true, capture_values: false },
  current_version: 2,
  versions: [
    { number: 1, published_at: 1_790_000_000, note: 'first' },
    { number: 2, published_at: 1_790_100_000, note: 'VAT' }
  ],
  created_at: 1_790_000_000,
  updated_at: 1_790_100_000,
  profile: 'alpha',
  entry_path: '/apps/alpha/invoices/',
  public_path: null
}

const insights = {
  days: 7,
  total_events: 4,
  public_events: 0,
  sessions: 1,
  by_type: { click: 3, error: 1 },
  top_interactions: [{ label: 'click: button: New invoice', count: 3 }],
  errors: [{ target: 'TypeError: x', count: 1 }],
  per_day: {}
}

function renderView(route = '/apps') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <AppsView />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  mocks.listApps.mockResolvedValue({ apps: [invoices], profile: 'alpha' })
  mocks.getApp.mockResolvedValue({ app: invoices, insights, data_keys: 1 })
  mocks.mintAppLink.mockResolvedValue({ path: '/apps-cap/tok.sig/', expires_at: 0, mode: 'live' })
  mocks.updateApp.mockResolvedValue({ app: { ...invoices, visibility: 'public' } })
  mocks.listAppJobs.mockResolvedValue({ jobs: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('AppsView', () => {
  it('lists the profile’s apps and shows the empty-state guidance when there are none', async () => {
    renderView()
    expect(await screen.findByText('Invoices')).toBeTruthy()
    expect(mocks.listApps).toHaveBeenCalledWith('alpha')

    cleanup()
    mocks.listApps.mockResolvedValue({ apps: [], profile: 'alpha' })
    renderView()
    expect(await screen.findByText('No apps yet')).toBeTruthy()
  })

  it('opens an app in a sandboxed frame at a signed link on the connected gateway', async () => {
    renderView()
    fireEvent.click(await screen.findByText('Invoices'))

    const frame = (await screen.findByTitle('Invoices')) as HTMLIFrameElement
    expect(frame.getAttribute('src')).toBe('http://127.0.0.1:9119/apps-cap/tok.sig/')
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(mocks.mintAppLink).toHaveBeenCalledWith('invoices', { preview: false }, 'alpha')
    expect(screen.getByText('click: button: New invoice')).toBeTruthy()
  })

  it('asks before making an app public and only then patches visibility', async () => {
    renderView('/apps?app=invoices')
    fireEvent.click(await screen.findByRole('button', { name: 'Make public' }))
    expect(mocks.updateApp).not.toHaveBeenCalled()

    const confirm = (await screen.findAllByRole('button', { name: 'Make public' })).at(-1)!
    fireEvent.click(confirm)
    await waitFor(() => expect(mocks.updateApp).toHaveBeenCalledWith('invoices', { visibility: 'public' }, 'alpha'))
  })

  it('restores an earlier version from the versions list', async () => {
    mocks.rollbackApp.mockResolvedValue({ app: { ...invoices, current_version: 1 } })
    renderView('/apps?app=invoices')
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(mocks.rollbackApp).toHaveBeenCalledWith('invoices', 1, 'alpha'))
  })
})

describe('Hermes sessions card', () => {
  it('lists the app’s session requests with their state and opens the Hermes session', async () => {
    mocks.listAppJobs.mockResolvedValue({
      jobs: [
        {
          id: 'abc123abc123',
          status: 'needs_input',
          created_at: 1_790_200_000,
          updated_at: 1_790_200_010,
          prompt: 'Process invoice',
          files: [{ name: 'inv.pdf', size: 10 }],
          session_id: 'sess-apps-1',
          steps: [{ at: 1_790_200_010, text: 'Waiting for your answer' }],
          question: { ask_id: 'a1', questions: [{ qid: 'q0', question: 'Which supplier?' }] },
          result: null,
          error: null,
          turns: 1
        }
      ]
    })
    renderView('/apps?app=invoices')
    expect(await screen.findByText('Process invoice')).toBeTruthy()
    expect(screen.getByText('Needs your answer')).toBeTruthy()
    expect(screen.getByText('Waiting for your answer')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open session' }))
    expect(mocks.openSession).toHaveBeenCalledWith('sess-apps-1')
    expect(mocks.listAppJobs).toHaveBeenCalledWith('invoices', 'alpha')
  })

  it('shows the empty state when the app has not used Hermes yet', async () => {
    renderView('/apps?app=invoices')
    expect(await screen.findByText('This app hasn’t sent anything to Hermes yet.')).toBeTruthy()
  })
})

describe('gatewayUrl', () => {
  it('joins server paths onto the connection base, keeping a proxy sub-path', () => {
    expect(gatewayUrl('http://127.0.0.1:9119', '/apps-cap/t/')).toBe('http://127.0.0.1:9119/apps-cap/t/')
    expect(gatewayUrl('https://host.example/hermes', '/apps-cap/t/')).toBe('https://host.example/hermes/apps-cap/t/')
    expect(gatewayUrl(null, '/apps-cap/t/')).toBeNull()
    expect(gatewayUrl('file:///x', '/apps-cap/t/')).toBeNull()
  })
})
