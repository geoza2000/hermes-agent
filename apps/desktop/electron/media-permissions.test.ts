import type { Session, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import { installMediaPermissions } from './media-permissions'

type RequestHandler = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>
type CheckHandler = NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>

const renderer = 'http://127.0.0.1:5174/'
const mainUrl = `${renderer}?win=session#/chat`
const mainFrame = { isMainFrame: true, requestingUrl: mainUrl }

function contents(type = 'window', url = mainUrl) {
  return { getType: () => type, getURL: () => url } as WebContents
}

function handlers(url = renderer) {
  const session = {
    setPermissionRequestHandler: vi.fn<Session['setPermissionRequestHandler']>(),
    setPermissionCheckHandler: vi.fn<Session['setPermissionCheckHandler']>()
  }

  installMediaPermissions(session, url)
  const request = session.setPermissionRequestHandler.mock.calls[0][0]!
  const check = session.setPermissionCheckHandler.mock.calls[0][0]!

  return {
    request: (requester: WebContents | null, permission: string, details?: unknown) => {
      const callback = vi.fn()
      request(
        requester!,
        permission as Parameters<RequestHandler>[1],
        callback,
        details as Parameters<RequestHandler>[3]
      )
      expect(callback).toHaveBeenCalledTimes(1)

      return callback.mock.calls[0][0]
    },
    check: (requester: WebContents | null, permission: string, details?: unknown) =>
      check(requester, permission as Parameters<CheckHandler>[1], renderer, details as Parameters<CheckHandler>[3])
  }
}

describe('installed default-session permission hooks', () => {
  it.each([
    ['trusted main frame', contents(), 'midi', mainFrame, true],
    ['own-origin iframe', contents(), 'midi', { ...mainFrame, isMainFrame: false }, false],
    ['guest', contents('webview'), 'midi', mainFrame, false],
    ['missing requester', null, 'midi', mainFrame, false],
    ['missing metadata', contents(), 'midi', undefined, false],
    ['missing frame identity', contents(), 'midi', { requestingUrl: mainUrl }, false],
    ['missing requesting URL', contents(), 'midi', { isMainFrame: true }, false],
    ['opaque frame', contents(), 'midi', { ...mainFrame, requestingUrl: 'about:blank' }, false],
    ['external frame', contents(), 'midi', { ...mainFrame, requestingUrl: 'https://evil.example/' }, false],
    ['other app path', contents('window', `${renderer}artifact.html`), 'midi', mainFrame, false],
    ['other frame path', contents(), 'midi', { ...mainFrame, requestingUrl: `${renderer}artifact.html` }, false]
  ])('applies the same MIDI boundary in request and check: %s', (_name, requester, permission, details, allowed) => {
    const hooks = handlers()
    expect(hooks.request(requester, permission, details)).toBe(allowed)
    expect(hooks.check(requester, permission, details)).toBe(allowed)
  })

  // Electron 44 sends a non-sysex requestMIDIAccess to the request hook as `midiSysex`.
  it.each([
    ['trusted main frame', contents(), mainFrame, true],
    ['own-origin iframe', contents(), { ...mainFrame, isMainFrame: false }, false],
    ['guest', contents('webview'), mainFrame, false],
    ['external frame', contents(), { ...mainFrame, requestingUrl: 'https://evil.example/' }, false],
    ['other app path', contents('window', `${renderer}artifact.html`), mainFrame, false]
  ])('grants the request hook\'s midiSysex only to the same main frame: %s', (_name, requester, details, allowed) => {
    const hooks = handlers()
    expect(hooks.request(requester, 'midiSysex', details)).toBe(allowed)
    expect(hooks.check(requester, 'midiSysex', details)).toBe(false)
  })

  it('allows the packaged renderer main frame in both hooks', () => {
    const hooks = handlers('file:///app/index.html')
    const url = 'file:///app/index.html?win=session#/chat'
    const requester = contents('window', url)
    const details = { isMainFrame: true, requestingUrl: url }
    expect(hooks.request(requester, 'midi', details)).toBe(true)
    expect(hooks.request(requester, 'midiSysex', details)).toBe(true)
    expect(hooks.check(requester, 'midi', details)).toBe(true)
  })

  it('preserves media metadata refinement only in the request hook', () => {
    const hooks = handlers()
    expect(hooks.request(contents(), 'media', { mediaTypes: ['audio'] })).toBe(true)
    expect(hooks.request(contents(), 'media', { mediaTypes: ['unknown'] })).toBe(false)
    expect(hooks.check(contents(), 'media', { mediaType: 'unknown' })).toBe(true)
    expect(hooks.request(contents(), 'geolocation')).toBe(false)
    expect(hooks.check(contents(), 'geolocation')).toBe(false)
  })

  it('preserves exact Hub clipboard writes and denies guest reads in both hooks', () => {
    const hooks = handlers()
    const hub = contents('window', 'https://hermes-agent.nousresearch.com/docs/skills')
    expect(hooks.request(hub, 'clipboard-sanitized-write')).toBe(true)
    expect(hooks.check(hub, 'clipboard-sanitized-write')).toBe(true)
    expect(hooks.request(contents(), 'clipboard-sanitized-write')).toBe(false)
    expect(hooks.check(contents(), 'clipboard-sanitized-write')).toBe(false)
    expect(hooks.request(hub, 'clipboard-read')).toBe(false)
    expect(hooks.check(hub, 'clipboard-read')).toBe(false)
  })
})
