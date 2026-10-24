// @vitest-environment jsdom
// Executes the real Hermes Apps runtime (hermes_cli/data/apps_sdk.js) the way an app page loads
// it, against a scripted server, to prove the app → Hermes session handoff contract.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

const SDK = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'hermes_cli', 'data', 'apps_sdk.js'), 'utf8')
const BASE = '/apps-cap/token.sig/'

interface HermesRuntime {
  viewer: string
  session: {
    available: boolean
    run: (request: object, options?: object) => Promise<{ status: string; result: { json: unknown } }>
    start: (request: object) => Promise<unknown>
  }
  ui: { question: (ask: object) => Promise<Record<string, unknown>> }
}

type Route = (init: RequestInit | undefined) => unknown

function loadRuntime(routes: Record<string, Route>, { owner = true } = {}) {
  const calls: { body: unknown; method: string; url: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ body: init?.body, method, url })
    const handler = routes[`${method} ${url}`] as Route | undefined
    const payload = handler ? handler(init) : {}

    return new Response(JSON.stringify(payload), { status: handler ? 200 : 404 })
  }))
  const script = document.createElement('script')
  Object.assign(script.dataset, {
    hermesBase: BASE,
    hermesData: owner ? '1' : '0',
    hermesTelemetry: '0',
    hermesValues: '0',
    hermesViewer: owner ? 'owner' : 'public'
  })
  Object.defineProperty(document, 'currentScript', { configurable: true, value: script })
   
  ;(0, eval)(SDK)

  return { calls, hermes: (window as unknown as { hermes: HermesRuntime }).hermes }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const job = (status: string, extra: object = {}) => ({ session: { id: 'abcdefabcdef', status, updated_at: Math.random(), steps: [], ...extra } })

describe('hermes.session', () => {
  it('uploads files with the prompt, answers a question and resolves with the JSON result', async () => {
    const states = [
      job('running'),
      job('needs_input', { question: { ask_id: 'a1', questions: [{ qid: 'q0', question: 'Supplier?', choices: ['Acme', 'Northwind'] }] } }),
      job('done', { result: { text: 'ok', json: { supplier: 'Northwind' } } })
    ]

    const { calls, hermes } = loadRuntime({
      [`POST ${BASE}_hermes/sessions`]: () => job('queued'),
      [`GET ${BASE}_hermes/sessions/abcdefabcdef`]: () => states.shift() ?? states.at(-1),
      [`POST ${BASE}_hermes/sessions/abcdefabcdef/answer`]: () => job('running')
    })

    const updates: string[] = []
    const onQuestion = vi.fn(async () => ({ q0: 'Northwind' }))
    const file = new File(['%PDF'], 'inv.pdf', { type: 'application/pdf' })

    const done = await hermes.session.run(
      { context: { currency: 'EUR' }, files: [file], prompt: 'Process' },
      { interval: 1, onQuestion, onUpdate: (j: { status: string }) => updates.push(j.status) }
    )

    expect(done.status).toBe('done')
    expect(done.result.json).toEqual({ supplier: 'Northwind' })
    const created = calls[0].body as FormData
    expect(created).toBeInstanceOf(FormData)
    expect(created.get('prompt')).toBe('Process')
    expect(JSON.parse(String(created.get('context')))).toEqual({ currency: 'EUR' })
    expect((created.get('files') as File).name).toBe('inv.pdf')
    expect(onQuestion).toHaveBeenCalledTimes(1)
    const answer = calls.find(c => c.url.endsWith('/answer'))!
    expect(JSON.parse(String(answer.body))).toEqual({ answers: { q0: 'Northwind' } })
    expect(updates).toContain('needs_input')
    expect(calls.every(c => c.url.startsWith(BASE))).toBe(true)
  })

  it('is unavailable to public viewers and never calls the server', async () => {
    const { calls, hermes } = loadRuntime({}, { owner: false })
    expect(hermes.session.available).toBe(false)
    await expect(hermes.session.start({ prompt: 'x' })).rejects.toThrow(/owner/)
    expect(calls.filter(c => c.url.includes('_hermes/sessions'))).toHaveLength(0)
  })

  it('surfaces the server error message', async () => {
    const { hermes } = loadRuntime({})
    await expect(hermes.session.start({ prompt: 'x' })).rejects.toThrow(/404/)
  })
})

describe('hermes.ui.question', () => {
  it('renders choices plus a free-text answer and resolves with answers keyed by question id', async () => {
    const { hermes } = loadRuntime({})

    const pending = hermes.ui.question({
      ask_id: 'a1',
      questions: [
        { choices: ['Acme', 'Northwind'], qid: 'q0', question: 'Supplier?' },
        { qid: 'q1', question: 'Anything else?' }
      ]
    })

    const dialog = document.querySelector('[role=dialog]')!
    expect(dialog.textContent).toContain('Supplier?')
    ;(dialog.querySelector('input[value="Northwind"]') as HTMLInputElement).checked = true

    const inputs = dialog.querySelectorAll('input:not([type])')

    ;(inputs[1] as HTMLInputElement).value = 'Mark it paid'
    dialog.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))

    await expect(pending).resolves.toEqual({ q0: 'Northwind', q1: 'Mark it paid' })
    expect(document.querySelector('[role=dialog]')).toBeNull()
  })
})
