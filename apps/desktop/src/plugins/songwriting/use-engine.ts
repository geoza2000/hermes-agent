import { useCallback, useEffect, useRef, useState } from 'react'

import { createSoundFontApi, type Lane, type SongScope, type SongwritingApi, type SoundFontStatus } from './api'
import { type PlayOptions, SongEngine } from './engine'
import { loadSoundFont } from './soundfont-cache'

export type EngineState =
  | { phase: 'checking' }
  | { phase: 'missing'; status: SoundFontStatus }
  | { phase: 'installing' }
  | { phase: 'loading'; progress: number }
  | { phase: 'ready' }
  | { phase: 'failed'; message: string }

/** The pane's single sound engine: gated on the instrument bank, then kept in step with the lanes. */
export function useEngine(scope: SongScope | null, api: SongwritingApi | null, lanes: readonly Lane[] | undefined) {
  const [state, setState] = useState<EngineState>({ phase: 'checking' })
  const engine = useRef<SongEngine | null>(null)
  const [playing, setPlaying] = useState(false)
  const [positionMs, setPositionMs] = useState(0)
  const owner = scope?.owner
  const ownerKey = owner ? JSON.stringify(owner) : ''

  const start = useCallback(async (status: SoundFontStatus) => {
    if (!owner) {
      return
    }

    setState({ phase: 'loading', progress: 0 })

    try {
      const bank = await loadSoundFont(createSoundFontApi(owner), status, progress =>
        setState({ phase: 'loading', progress })
      )

      engine.current ??= await SongEngine.create(bank)
      setState({ phase: 'ready' })
    } catch (err) {
      setState({ phase: 'failed', message: String(err instanceof Error ? err.message : err) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ownerKey encodes owner.
  }, [ownerKey])

  useEffect(() => {
    if (!owner || engine.current) {
      return
    }

    let alive = true
    createSoundFontApi(owner)
      .status()
      .then(status => {
        if (!alive) {
          return
        }

        if (status.installed) {
          void start(status)
        } else {
          setState({ phase: 'missing', status })
        }
      })
      .catch(err => alive && setState({ phase: 'failed', message: String(err) }))

    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ownerKey encodes owner.
  }, [ownerKey, start])

  useEffect(() => () => engine.current?.close(), [])

  /** The user's explicit consent: download the pinned bank to the gateway, then load it. */
  const install = useCallback(async () => {
    if (!owner) {
      return
    }

    setState({ phase: 'installing' })

    try {
      await start(await createSoundFontApi(owner).install())
    } catch (err) {
      setState({ phase: 'failed', message: String(err instanceof Error ? err.message : err) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ownerKey encodes owner.
  }, [ownerKey, start])

  // Instruments and the mix follow the lanes live, including while playing.
  const ready = state.phase === 'ready'
  useEffect(() => {
    if (ready && lanes) {
      engine.current?.setLanes(lanes)
    }
  }, [ready, lanes])

  // Recorded lanes need their audio decoded before they can play.
  useEffect(() => {
    if (!ready || !lanes || !api) {
      return
    }

    for (const lane of lanes) {
      if (lane.audio) {
        const captureId = lane.audio.captureId
        void engine.current?.loadRecording(captureId, () => api.recording(captureId)).catch(() => undefined)
      }
    }
  }, [ready, lanes, api])

  useEffect(() => {
    if (!playing) {
      return
    }

    let frame = 0

    const tick = () => {
      const position = engine.current?.positionMs

      if (position !== null && position !== undefined) {
        setPositionMs(position)
      }

      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)

    return () => cancelAnimationFrame(frame)
  }, [playing])

  const play = useCallback(async (playLanes: readonly Lane[], options: PlayOptions) => {
    const current = engine.current

    if (!current) {
      return null
    }

    await current.resume()
    setPositionMs(options.fromMs)
    setPlaying(true)

    return current.play(playLanes, options)
  }, [])

  const stop = useCallback(() => {
    engine.current?.stop()
    setPlaying(false)
  }, [])

  return { state, install, engine, playing, positionMs, setPositionMs, play, stop }
}
