import { describe, expect, it } from 'vitest'

import { isSongwritingMidiPermission } from './songwriting-midi-permission'

const renderer = 'http://127.0.0.1:5174/'
const main = { type: 'window', url: `${renderer}?win=session#/chat` }
const request = { isMainFrame: true, requestingUrl: main.url }

describe('songwriting MIDI boundary (request and check)', () => {
  it('allows non-sysex MIDI only in the exact app main frame', () => {
    expect(isSongwritingMidiPermission('midi', main, request, renderer)).toBe(true)
    expect(
      isSongwritingMidiPermission(
        'midi',
        { type: 'window', url: 'file:///app/index.html#/chat' },
        { isMainFrame: true, requestingUrl: 'file:///app/index.html#/chat' },
        'file:///app/index.html'
      )
    ).toBe(true)
  })
  it('denies own-origin iframes, guests, opaque frames, missing metadata and sysex', () => {
    for (const details of [
      undefined,
      { ...request, isMainFrame: false },
      { ...request, requestingUrl: 'about:blank' }
    ]) {
      expect(isSongwritingMidiPermission('midi', main, details, renderer)).toBe(false)
    }

    expect(isSongwritingMidiPermission('midiSysex', main, request, renderer)).toBe(false)
    expect(isSongwritingMidiPermission('midi', { ...main, type: 'webview' }, request, renderer)).toBe(false)
    expect(isSongwritingMidiPermission('midi', { ...main, url: `${renderer}artifact.html` }, request, renderer)).toBe(
      false
    )
    expect(
      isSongwritingMidiPermission('midi', main, { ...request, requestingUrl: 'https://evil.example/' }, renderer)
    ).toBe(false)
    expect(isSongwritingMidiPermission('midi', null, request, renderer)).toBe(false)
  })
})
