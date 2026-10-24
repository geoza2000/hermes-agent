import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as AppsApi from '@/api/apps'

const api = vi.hoisted(() => ({
  getImprovementDefaults: vi.fn(),
  saveImprovementDefaults: vi.fn(),
  getAppImprovements: vi.fn(),
  saveAppImprovements: vi.fn(),
  runAppReview: vi.fn(),
  decideSuggestion: vi.fn(),
  reviewAppDraft: vi.fn(),
  publishAppRevision: vi.fn(),
  notify: vi.fn(),
  notifyError: vi.fn()
}))

vi.mock('@/api/apps', async () => ({ ...(await vi.importActual<typeof AppsApi>('@/api/apps')), ...api }))
vi.mock('@/store/notifications', () => ({ notify: api.notify, notifyError: api.notifyError }))

import { AppImprovementsCard, ImprovementDefaults, InstallCard } from './improvements'

const defaults = { auto_apply: false, enabled: true, schedule: 'weekly', token_budget: 12000 }

const suggestion = {
  edit: { after: '15', before: '30', path: 'index.html' },
  evidence: { 'top_interactions:change: due-days': 9 },
  id: 's1',
  reason: 'You change it on almost every invoice.',
  status: 'pending',
  title: 'Default the due date to 15 days'
}

const state = (extra: object = {}) => ({
  override: null,
  request: null,
  runs: [{ at: 1_790_000_000, budget: 12000, id: 'r1', status: 'done', total_tokens: 3100 }],
  settings: defaults,
  suggestions: [suggestion],
  ...extra
})

function renderWith(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  api.getImprovementDefaults.mockResolvedValue({ settings: defaults })
  api.saveImprovementDefaults.mockResolvedValue({ settings: { ...defaults, schedule: 'daily' } })
  api.getAppImprovements.mockResolvedValue(state())
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ImprovementDefaults', () => {
  it('defaults to weekly on Sunday evening and saves a new schedule for every app', async () => {
    renderWith(<ImprovementDefaults profile="alpha" />)
    const select = (await screen.findByLabelText('When')) as HTMLSelectElement
    expect(select.value).toBe('weekly')
    expect(screen.getByText('Weekly, Sunday 20:00')).toBeTruthy()
    expect(screen.getByText(/Automatic changes are off/)).toBeTruthy()
    fireEvent.change(select, { target: { value: 'daily' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.saveImprovementDefaults).toHaveBeenCalledWith(
        { enabled: true, schedule: 'daily', token_budget: 12000 },
        'alpha'
      )
    )
  })
})

describe('AppImprovementsCard', () => {
  it('shows the evidence and token use, approves into the draft, then publishes only the reviewed revision', async () => {
    api.decideSuggestion.mockResolvedValue({ ...state(), suggestions: [{ ...suggestion, status: 'applied' }] })
    api.reviewAppDraft.mockResolvedValue({ expires_at: 0, path: '/apps-cap/x/', revision: 'a'.repeat(64) })
    api.publishAppRevision.mockResolvedValue({ app: { current_version: 3 } })
    renderWith(<AppImprovementsCard profile="alpha" slug="invoices" />)

    expect(await screen.findByText('Default the due date to 15 days')).toBeTruthy()
    expect(screen.getByText('change: due-days: 9')).toBeTruthy()
    expect(screen.getByText(/3,100 of 12,000 tokens/)).toBeTruthy()

    api.getAppImprovements.mockResolvedValue(state({ suggestions: [{ ...suggestion, status: 'applied' }] }))
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(api.decideSuggestion).toHaveBeenCalledWith('invoices', 's1', 'approve', 'alpha'))
    expect(await screen.findByText('No suggestions waiting.')).toBeTruthy()

    fireEvent.click(await screen.findByRole('button', { name: 'Publish draft' }))
    await waitFor(() => expect(api.reviewAppDraft).toHaveBeenCalledWith('invoices', 'alpha'))
    expect(api.publishAppRevision).not.toHaveBeenCalled()
    const confirm = (await screen.findAllByRole('button', { name: 'Publish draft' })).at(-1)!
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(api.publishAppRevision).toHaveBeenCalledWith('invoices', 'a'.repeat(64), 'Approved improvement', 'alpha')
    )
  })

  it('reports a run stopped at the token cap and starts a review on demand', async () => {
    api.getAppImprovements.mockResolvedValue(
      state({
        runs: [
          {
            at: 1,
            budget: 12000,
            error: 'The review used 50000 tokens, over the 12000 token cap, so its suggestions were discarded.',
            id: 'r2',
            status: 'budget_exhausted',
            total_tokens: 50000
          }
        ],
        suggestions: []
      })
    )
    api.runAppReview.mockResolvedValue({ request: { id: 'q', status: 'queued' } })
    renderWith(<AppImprovementsCard profile="alpha" slug="invoices" />)
    expect(await screen.findByText(/Stopped at the token cap/)).toBeTruthy()
    expect(screen.getByText(/suggestions were discarded/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Run review now' }))
    await waitFor(() => expect(api.runAppReview).toHaveBeenCalledWith('invoices', 'alpha'))
  })
})

describe('InstallCard', () => {
  it('nudges once for a published app and remembers Not now', () => {
    window.localStorage.clear()
    const { unmount } = renderWith(<InstallCard profile="alpha" published slug="invoices" />)
    expect(screen.getByText(/Install it and it opens like any other app/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByText(/Install it and it opens/)).toBeNull()
    unmount()
    renderWith(<InstallCard profile="alpha" published slug="invoices" />)
    expect(screen.queryByText(/Install it and it opens/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Install on this device' }))
    expect(screen.getByText(/Add to Home Screen/)).toBeTruthy()
  })
})
