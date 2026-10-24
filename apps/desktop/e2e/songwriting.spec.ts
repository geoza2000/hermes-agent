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

async function setupSongwritingBackend(reply: string): Promise<MockBackendFixture> {
  const mock = await startMockServer({ replyForPrompt: () => reply })
  const sandbox = createSandbox('songwriting')
  // A native default-home boundary also isolates tests nested under a real
  // profile's scratch folder: ancestor profile detection must stop here.
  sandbox.hermesHome = path.join(sandbox.root, '.hermes')
  fs.mkdirSync(sandbox.hermesHome)
  writeMockProviderConfig(sandbox.hermesHome, mock.url, undefined, 'plugins:\n  enabled:\n    - songwriting\n')
  writeEnvFile(sandbox.hermesHome)

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

// Desktop REST travels through native IPC, not page HTTP responses. Verify
// persisted state and exported bytes rather than waiting for renderer fetches.
interface SongProject {
  id: string
  revision: number
  tracks: { protected: boolean; kind: string; path?: string }[]
}

function readFixtureProject(fixture: MockBackendFixture, sessionId: string): SongProject {
  const python = process.env.HERMES_DESKTOP_PYTHON
  expect(python, 'Use a dependency-complete isolated HERMES_DESKTOP_PYTHON').toBeTruthy()

  const result = spawnSync(
    python!,
    [
      '-c',
      'import json,sys; from plugins.songwriting.storage import SongStore; print(json.dumps(SongStore(sys.argv[1]).read()))',
      sessionId
    ],
    {
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
    }
  )

  expect(result.status, result.stderr).toBe(0)

  return JSON.parse(result.stdout) as SongProject
}

test('synthetic MIDI reaches the real songwriting backend and produces a protected in-chat WAV', async ({
  browserName
}, testInfo) => {
  test.setTimeout(180_000)
  expect(browserName).toBe('chromium')
  let fixture: MockBackendFixture | undefined

  try {
    fixture = await setupSongwritingBackend('Let’s capture the idea in this conversation.\n\n::songwriting')
    const { page, app } = fixture
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 1100))
    await page.context().addInitScript(() => {
      const input = new EventTarget() as EventTarget & {
        id: string
        name: string
        manufacturer: string
        state: string
        connection: string
        open: () => Promise<unknown>
        close: () => Promise<unknown>
      }

      Object.assign(input, {
        id: 'songwriting-e2e-midi',
        name: 'Synthetic E2E keys',
        manufacturer: 'Test fixture',
        state: 'connected',
        connection: 'open',
        open: async () => input,
        close: async () => input
      })
      const access = Object.assign(new EventTarget(), { inputs: new Map([[input.id, input]]) })
      Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => access })
      Object.defineProperty(window, '__songwritingTestInput', { value: input })
      localStorage.setItem('hermes.desktop.pluginDecisions.v2', JSON.stringify({ songwriting: true }))
    })
    await page.reload()
    const composer = await waitForChatReady(page)
    await composer.fill('I want to write a song from MIDI. This is a synthetic end-to-end test.')
    await composer.press('Enter')
    const card = page.getByRole('region', { name: 'Songwriting' }).first()
    await expect(card).toBeVisible({ timeout: 60_000 })
    const noThanks = page.getByRole('button', { name: 'No thanks', exact: true })

    if (await noThanks.isVisible()) {
      await noThanks.click()
    }

    await card.getByRole('button', { name: 'Find MIDI inputs', exact: true }).click()
    await expect(card.getByRole('button', { name: 'Start recording', exact: true })).toBeEnabled()
    await card.getByRole('button', { name: 'Start recording', exact: true }).click()
    await page.evaluate(() => {
      const input = (window as unknown as { __songwritingTestInput: EventTarget }).__songwritingTestInput
      input.dispatchEvent(new MIDIMessageEvent('midimessage', { data: new Uint8Array([0x90, 60, 90]) }))
      input.dispatchEvent(new MIDIMessageEvent('midimessage', { data: new Uint8Array([0xb0, 64, 127]) }))
    })
    await page.waitForTimeout(80)
    await page.evaluate(() => {
      const input = (window as unknown as { __songwritingTestInput: EventTarget }).__songwritingTestInput
      input.dispatchEvent(new MIDIMessageEvent('midimessage', { data: new Uint8Array([0x80, 60, 0]) }))
      input.dispatchEvent(new MIDIMessageEvent('midimessage', { data: new Uint8Array([0xb0, 64, 0]) }))
    })
    await page.screenshot({ path: testInfo.outputPath('songwriting-capture.png'), fullPage: true })
    await card.getByRole('button', { name: 'Stop & keep take', exact: true }).click()
    await expect(card.getByText(/Synthetic E2E keys.*4 events/)).toBeVisible()
    await expect(card.getByRole('button', { name: 'Save take', exact: true })).toBeDisabled()
    await card.getByRole('checkbox', { name: /I approve sending this take/ }).check()
    await card.getByRole('button', { name: 'Save take', exact: true }).click()
    const capturePath = await card.locator('p.font-mono').innerText()
    const saved = { capturePath, project: readFixtureProject(fixture, path.basename(path.dirname(capturePath))) }
    expect(saved.capturePath.startsWith(fixture.sandbox.root + path.sep)).toBe(true)
    const raw = JSON.parse(fs.readFileSync(saved.capturePath, 'utf8'))
    expect(raw.device.name).toBe('Synthetic E2E keys')
    expect(raw.events.map((event: { data: number[] }) => event.data)).toEqual([
      [0x90, 60, 90],
      [0xb0, 64, 127],
      [0x80, 60, 0],
      [0xb0, 64, 0]
    ])
    expect(saved.project.tracks[0].protected).toBe(true)
    await expect(card.getByRole('button', { name: 'Share with Hermes', exact: true })).toBeDisabled()
    await card.getByRole('checkbox', { name: /I approve sharing this saved source/ }).check()
    await card.getByRole('button', { name: 'Share with Hermes', exact: true }).click()
    await expect
      .poll(() =>
        fixture!.mock.receivedPrompts.some(
          prompt => prompt.includes('Synthetic E2E keys') && prompt.includes(saved.capturePath)
        )
      )
      .toBe(true)

    // The inference response and score below are explicitly synthetic fixtures;
    // capture, tool proposal validation, human Apply and rendering are real.
    const proposalPayload = {
      action: 'propose',
      baseRevision: saved.project.revision,
      brief: 'Synthetic test: add a separate keys part and keep the source untouched.',
      tracks: [
        {
          id: 'test-keys',
          name: 'Fixture keys',
          kind: 'midi',
          origin: 'generated',
          protected: false,
          instrument: 'piano',
          notes: [{ startMs: 0, durationMs: 400, note: 64, velocity: 65 }]
        }
      ]
    }

    const python = process.env.HERMES_DESKTOP_PYTHON
    expect(python, 'Use a dependency-complete isolated HERMES_DESKTOP_PYTHON').toBeTruthy()

    const proposal = spawnSync(
      python!,
      [
        '-c',
        'import json,sys; from plugins.songwriting.tool import handle; print(handle(json.loads(sys.argv[1]), session_id=sys.argv[2]))',
        JSON.stringify(proposalPayload),
        (saved.project as typeof saved.project & { id: string }).id
      ],
      {
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
      }
    )

    expect(proposal.status, proposal.stderr).toBe(0)
    expect(JSON.parse(proposal.stdout).proposal.tracks[0].id).toBe('test-keys')
    await card.getByRole('button', { name: 'Refresh song', exact: true }).click()
    await expect(card.getByRole('heading', { name: 'Proposed changes' })).toBeVisible()
    await card.getByRole('button', { name: 'Apply proposal', exact: true }).click()
    await expect(card.getByText('Revision 2', { exact: true })).toBeVisible()
    expect(readFixtureProject(fixture, saved.project.id).tracks).toHaveLength(2)
    expect(JSON.parse(fs.readFileSync(saved.capturePath, 'utf8'))).toEqual(raw)
    await card.getByRole('button', { name: 'Preview selected mix', exact: true }).click()
    await expect(card.locator('audio').last()).toBeVisible()
    const playbackSource = await card.locator('audio').last().getAttribute('src')
    expect(playbackSource).toMatch(/^data:audio\/[^;,]+;base64,/)
    const wav = Buffer.from(playbackSource!.split(',')[1], 'base64')
    expect(wav.subarray(0, 4).toString()).toBe('RIFF')
    expect(wav.subarray(8, 12).toString()).toBe('WAVE')
    expect(wav.length).toBeGreaterThan(44)
    expect(wav.readUInt32LE(40)).toBeGreaterThan(0)
    await expect(card.locator('audio').last()).toBeVisible()
    const exportPath = path.join(fixture.sandbox.root, 'exported-fixture.wav')
    // Only the OS dialog selection is faked: the authenticated download and
    // saved bytes still use the actual Desktop bridge and backend export.
    await fixture.app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    }, exportPath)
    await card.getByRole('button', { name: 'Export WAV', exact: true }).click()
    await expect.poll(() => fs.existsSync(exportPath)).toBe(true)
    const exported = fs.readFileSync(exportPath)
    expect(exported.subarray(0, 4).toString()).toBe('RIFF')
    expect(exported.length).toBeGreaterThan(44)
    expect(exported.equals(wav)).toBe(true)
    await expect(card.getByText('WAV exported', { exact: true })).toBeVisible()
    await card.getByRole('heading', { name: 'Tracks', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('songwriting-real-chat.png'), fullPage: true })
    await testInfo.attach('real-rendered-fixture.wav', { body: wav, contentType: 'audio/wav' })
    await testInfo.attach('hardware-boundary', {
      body: 'Synthetic standard MIDIMessageEvent input; actual Desktop, configured mock inference and real backend/WAV render. No physical MIDI, microphone, paid inference or musical audition is claimed.',
      contentType: 'text/plain'
    })
    expect(await page.locator('[data-slot="composer-root"]').count()).toBeGreaterThan(0)
    expect(await card.locator('a[href*="studio"], nav').count()).toBe(0)
  } finally {
    await fixture?.cleanup()
  }
})

test('microphone fallback records generated test audio without touching a physical microphone', async ({
  browserName
}, testInfo) => {
  test.setTimeout(180_000)
  expect(browserName).toBe('chromium')
  let fixture: MockBackendFixture | undefined

  try {
    fixture = await setupSongwritingBackend('Use the microphone sampler in this conversation.\n\n::songwriting')
    const { page } = fixture
    await page.context().addInitScript(() => {
      localStorage.setItem('hermes.desktop.pluginDecisions.v2', JSON.stringify({ songwriting: true }))
      Object.defineProperty(navigator, 'requestMIDIAccess', {
        configurable: true,
        value: async () => Object.assign(new EventTarget(), { inputs: new Map() })
      })
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async () => {
          const context = new AudioContext()
          const destination = context.createMediaStreamDestination()
          const oscillator = context.createOscillator()
          const gain = context.createGain()
          gain.gain.value = 0.1
          oscillator.frequency.value = 220
          oscillator.connect(gain).connect(destination)
          oscillator.start()
          await context.resume()

          for (const track of destination.stream.getTracks()) {
            const originalStop = track.stop.bind(track)

            track.stop = () => {
              originalStop()
              oscillator.stop()
              void context.close()
            }
          }

          return destination.stream
        }
      })
    })
    await page.reload()
    const composer = await waitForChatReady(page)
    await composer.fill('I want to sample an idea. This test uses generated audio, not a physical microphone.')
    await composer.press('Enter')
    const card = page.getByRole('region', { name: 'Songwriting' }).first()
    await expect(card).toBeVisible({ timeout: 60_000 })
    await card.getByRole('button', { name: 'Find MIDI inputs', exact: true }).click()
    await expect(card.getByText(/No MIDI inputs found/)).toBeVisible()
    await card.getByRole('button', { name: 'Microphone', exact: true }).click()
    await card.getByRole('button', { name: 'Start recording', exact: true }).click()
    await expect(card.getByRole('meter', { name: 'Microphone input level' })).toBeVisible()
    await page.waitForTimeout(400)
    await card.getByRole('button', { name: 'Stop & keep take', exact: true }).click()
    await expect(card.locator('audio').first()).toBeVisible()
    await card.getByRole('checkbox', { name: /I approve sending this take/ }).check()
    await card.getByRole('button', { name: 'Save take', exact: true }).click()
    const capturePath = await card.locator('p.font-mono').innerText()
    const saved = { capturePath, project: readFixtureProject(fixture, path.basename(path.dirname(capturePath))) }
    expect(fs.statSync(saved.capturePath).size).toBeGreaterThan(100)
    const track = saved.project.tracks[0]
    expect(track.kind).toBe('audio')
    expect(track.protected).toBe(true)
    expect(track.path).toBeTruthy()
    const pcm = fs.readFileSync(track.path!)
    expect(pcm.subarray(0, 4).toString()).toBe('RIFF')
    expect(pcm.length).toBeGreaterThan(44)
    await testInfo.attach('capture-boundary', {
      body: 'Actual Chromium MediaRecorder and backend decoder, with an oscillator-backed synthetic MediaStream. No physical microphone or musical transcription.',
      contentType: 'text/plain'
    })
  } finally {
    await fixture?.cleanup()
  }
})
