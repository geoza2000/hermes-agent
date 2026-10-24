import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { waitForChatReady } from '../../../tests-js/scripts/desktop-chat-smoke'
import { writeEnvFile, writeMockProviderConfig } from '../../../tests-js/scripts/mock-provider-config'
import { startMockServer } from '../../../tests-js/scripts/mock-server'

import { buildAppEnv, createSandbox, launchDesktop, type MockBackendFixture } from './fixtures'
import { expect, test } from './test'

// The test suite uses fixture-generated input only. It never opens hardware
// MIDI outputs, the system microphone or a paid inference endpoint.
// HERMES_SONGWRITING_SF2 points at a local copy of GeneralUser-GS v2.0.3 (sha256 9575028c…).
const SOUNDFONT = process.env.HERMES_SONGWRITING_SF2

async function setupSongwritingBackend(reply: string): Promise<MockBackendFixture> {
  const mock = await startMockServer({ replyForPrompt: () => reply })
  const sandbox = createSandbox('songwriting')
  // A native default-home boundary also isolates tests nested under a real
  // profile's scratch folder: ancestor profile detection must stop here.
  sandbox.hermesHome = path.join(sandbox.root, '.hermes')
  fs.mkdirSync(sandbox.hermesHome)
  writeMockProviderConfig(sandbox.hermesHome, mock.url, undefined, 'plugins:\n  enabled:\n    - songwriting\n')
  writeEnvFile(sandbox.hermesHome)
  // The real, hash-pinned instrument bank, seeded so the run never downloads 32 MB.
  const soundfonts = path.join(sandbox.hermesHome, 'plugin-data/songwriting/soundfonts')
  fs.mkdirSync(soundfonts, { recursive: true })
  fs.copyFileSync(SOUNDFONT!, path.join(soundfonts, 'GeneralUser-GS-2.0.3.sf2'))

  try {
    const { app, page } = await launchDesktop(buildAppEnv(sandbox))

    return {
      app,
      page,
      mock,
      mockUrl: mock.url,
      sandbox,
      cleanup: async () => {
        await app.close().catch(() => undefined)
        await mock.close()
        sandbox.cleanup()
      }
    }
  } catch (error) {
    await mock.close()
    sandbox.cleanup()
    throw error
  }
}

interface Lane {
  id: string
  name: string
  instrument: { program: number; drums: boolean }
  notes: { startMs: number; note: number }[]
  play: string
}

interface SongProject {
  id: string
  revision: number
  lanes: Lane[]
  proposal?: { id: string }
}

function hermesPython(fixture: MockBackendFixture, code: string, ...args: string[]) {
  const python = process.env.HERMES_DESKTOP_PYTHON
  expect(python, 'Use a dependency-complete isolated HERMES_DESKTOP_PYTHON').toBeTruthy()

  const result = spawnSync(python!, ['-c', code, ...args], {
    cwd: path.resolve(import.meta.dirname, '../../..'),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: fixture.sandbox.root,
      USERPROFILE: fixture.sandbox.root,
      HERMES_HOME: fixture.sandbox.hermesHome,
      PYTHONNOUSERSITE: '1',
      TMPDIR: process.env.TMPDIR ?? fixture.sandbox.root
    },
    encoding: 'utf8',
    timeout: 30_000
  })

  expect(result.status, result.stderr).toBe(0)

  return result.stdout
}

function readProject(fixture: MockBackendFixture, sessionId: string): SongProject {
  return JSON.parse(
    hermesPython(
      fixture,
      'import json,sys; from plugins.songwriting.storage import SongStore; print(json.dumps(SongStore(sys.argv[1]).read()))',
      sessionId
    )
  ) as SongProject
}

function songSessionId(fixture: MockBackendFixture): string {
  const ids = fs.readdirSync(path.join(fixture.sandbox.hermesHome, 'plugin-data/songwriting/sessions'))
  expect(ids).toHaveLength(1)

  return ids[0]
}

test('lanes: add a bass, record it from MIDI, hum a trumpet, and keep a Hermes rework', async ({ browserName }, testInfo) => {
  test.skip(!SOUNDFONT, 'Set HERMES_SONGWRITING_SF2 to the pinned GeneralUser GS file')
  test.setTimeout(240_000)
  expect(browserName).toBe('chromium')
  let fixture: MockBackendFixture | undefined

  try {
    fixture = await setupSongwritingBackend('Let’s write it in lanes.\n\n::songwriting')
    const { page, app } = fixture
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1600, 1100))
    await page.context().addInitScript(() => {
      const input = Object.assign(new EventTarget(), {
        id: 'songwriting-e2e-midi',
        name: 'Synthetic E2E keys',
        manufacturer: 'Test fixture',
        state: 'connected',
        connection: 'open',
        type: 'input'
      })

      const access = Object.assign(new EventTarget(), { inputs: new Map([[input.id, input]]), outputs: new Map() })
      Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => access })
      Object.defineProperty(window, '__songwritingTestInput', { value: input })
      // A 220 Hz "voice" (A3, MIDI 57) stands in for humming into the microphone.
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async () => {
          const context = new AudioContext()
          const destination = context.createMediaStreamDestination()
          const oscillator = context.createOscillator()
          const gain = context.createGain()
          gain.gain.value = 0.3
          oscillator.frequency.value = 220
          oscillator.connect(gain).connect(destination)
          oscillator.start()
          await context.resume()

          for (const track of destination.stream.getTracks()) {
            const stop = track.stop.bind(track)

            track.stop = () => {
              stop()
              oscillator.stop()
              void context.close()
            }
          }

          return destination.stream
        }
      })
      localStorage.setItem('hermes.desktop.pluginDecisions.v2', JSON.stringify({ songwriting: true }))
    })
    await page.reload()
    const composer = await waitForChatReady(page)
    await composer.fill('I want to write a song. This is a synthetic end-to-end test.')
    await composer.press('Enter')
    const open = page.getByRole('button', { name: 'Open in Songwriting', exact: true }).first()
    await expect(open).toBeVisible({ timeout: 60_000 })
    const noThanks = page.getByRole('button', { name: 'No thanks', exact: true })

    if (await noThanks.isVisible()) {
      await noThanks.click()
    }

    await open.click()
    await expect(page.getByText(/No lanes yet/)).toBeVisible({ timeout: 60_000 })

    const send = (bytes: number[]) =>
      page.evaluate(data => {
        const input = (window as unknown as { __songwritingTestInput: EventTarget }).__songwritingTestInput
        input.dispatchEvent(new MIDIMessageEvent('midimessage', { data: new Uint8Array(data) }))
      }, bytes)

    // A bass lane, recorded from the keyboard behind a count-in.
    await page.getByRole('button', { name: 'Add lane', exact: true }).click()
    await page.getByRole('button', { name: 'Bass', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Lane name' })).toHaveValue('Bass')
    const sessionId = songSessionId(fixture)
    await page.getByRole('button', { name: 'Record', exact: true }).click()
    await expect(page.getByText(/Recording ·/)).toBeVisible({ timeout: 10_000 })

    for (const note of [40, 43, 45, 47]) {
      await send([0x90, note, 100])
      await page.waitForTimeout(150)
      await send([0x80, note, 0])
    }

    await page.getByRole('button', { name: 'Stop recording', exact: true }).click()
    await expect.poll(() => readProject(fixture!, sessionId).lanes[0]?.notes.map(note => note.note)).toEqual([40, 43, 45, 47])

    // Hermes rewrites the bass as a suggestion; Preview plays it, Keep applies it.
    const bass = readProject(fixture, sessionId).lanes[0]
    hermesPython(
      fixture,
      'import json,sys; from plugins.songwriting.tool import handle; print(handle(json.loads(sys.argv[1]), session_id=sys.argv[2]))',
      JSON.stringify({
        action: 'propose',
        brief: 'Synthetic test: a walking bass.',
        changes: [{ laneId: bass.id, notes: [40, 42, 43, 45].map((note, index) => ({ startMs: index * 500, durationMs: 450, note, velocity: 95 })) }]
      }),
      sessionId
    )
    await expect(page.getByText('Synthetic test: a walking bass.')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    await page.waitForTimeout(600)
    await page.screenshot({ path: testInfo.outputPath('songwriting-suggestion.png') })
    await page.getByRole('button', { name: 'Keep', exact: true }).click()
    await expect.poll(() => readProject(fixture!, sessionId).lanes[0].notes.map(note => note.note)).toEqual([40, 42, 43, 45])

    // Hum into a trumpet lane: the voice becomes trumpet notes, the recording is kept.
    await page.getByRole('button', { name: 'Add lane', exact: true }).click()
    await page.getByRole('button', { name: 'Hum or sing → instrument', exact: true }).click()
    await page.getByRole('button', { name: 'Trumpet', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Lane name' }).nth(1)).toHaveValue('Trumpet')
    await page.getByRole('button', { name: 'Record', exact: true }).click()
    await expect(page.getByText('Recording from the microphone')).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(4_000)
    await page.getByRole('button', { name: 'Stop recording', exact: true }).click()
    await expect
      .poll(() => readProject(fixture!, sessionId).lanes[1]?.notes.map(note => note.note), { timeout: 30_000 })
      .toContain(57)
    const trumpet = readProject(fixture, sessionId).lanes[1]
    expect(trumpet.instrument.program).toBe(56)
    expect(trumpet.play).toBe('notes')
    await page.screenshot({ path: testInfo.outputPath('songwriting-lanes.png') })
    await testInfo.attach('hardware-boundary', {
      body: 'Synthetic MIDIMessageEvent input and an oscillator-backed MediaStream; real Desktop, real SpessaSynth with GeneralUser GS, real backend. No physical MIDI, microphone or listening test is claimed.',
      contentType: 'text/plain'
    })
  } finally {
    await fixture?.cleanup()
  }
})
