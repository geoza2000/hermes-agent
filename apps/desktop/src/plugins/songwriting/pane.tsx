import {
  Button,
  ErrorState,
  host,
  Input,
  Loader,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@hermes/plugin-sdk'
import { useEffect, useMemo, useState } from 'react'

import { type Lane, type LaneSource, lanesWithSuggestion, songLengthMs, type SongNote } from './api'
import { COMMON_INSTRUMENTS, type Instrument } from './gm'
import { useSongText } from './i18n'
import { Lanes } from './lanes'
import { type EngineState, useEngine } from './use-engine'
import { importAudio, useMidiInput, useRecorder } from './use-recording'
import { useSong } from './use-song'

/** The song for the focused chat, as lanes: the GarageBand-style surface beside the conversation. */
export function SongPane() {
  const t = useSongText()
  const song = useSong()
  const { project, run } = song
  const sound = useEngine(song.scope, song.api, project?.lanes)
  const [metronome, setMetronome] = useState(true)
  const [previewing, setPreviewing] = useState(false)
  const ready = sound.state.phase === 'ready'
  const selected = project?.lanes.find(lane => lane.id === project.selectedLaneId) ?? null
  const midi = useMidiInput(ready ? sound.engine.current : null, selected?.id ?? null)

  const recorder = useRecorder(
    { api: song.api, sound, lanes: project?.lanes ?? [], tempo: project?.tempo ?? 100, metronome, run, setError: song.setError },
    midi.input
  )

  const suggested = useMemo(() => {
    const notes: Record<string, SongNote[]> = {}

    for (const change of project?.proposal?.changes ?? []) {
      if (change.notes && project?.lanes.some(lane => lane.id === change.laneId)) {
        notes[change.laneId] = change.notes
      }
    }

    return notes
  }, [project])

  // Playback ends by itself after the last note; a recording runs until you stop it.
  const endMs = project ? songLengthMs(previewing && project.proposal ? lanesWithSuggestion(project.lanes, project.proposal) : project.lanes) : 0
  const { playing, positionMs, stop: stopSound } = sound
  useEffect(() => {
    if (playing && !recorder.recording && positionMs > endMs + 800) {
      stopSound()
      setPreviewing(false)
    }
  }, [playing, positionMs, endMs, recorder.recording, stopSound])

  if (!song.scope) {
    return <Centered>{t('noChat')}</Centered>
  }

  if (song.outdated) {
    return <OutdatedBackend />
  }

  if (!ready) {
    return <InstrumentsGate onInstall={() => void sound.install()} state={sound.state} />
  }

  if (!project) {
    return song.error ? <Failure message={song.error} /> : <Centered><Loader label={t('title')} /></Centered>
  }

  const lengthMs = songLengthMs(project.lanes)

  const play = (lanes: readonly Lane[]) =>
    void sound.play(lanes, { fromMs: sound.positionMs, tempo: project.tempo, metronome, countInBars: 0 })

  const stop = () => {
    recorder.stop()
    sound.stop()
    setPreviewing(false)
  }

  const addLane = (source: Exclude<LaneSource, 'hermes'>, name: string, instrument: Instrument) =>
    void run(api => api.addLane({ source, name, instrument }), result => result.project)

  return (
    <div className="grid h-full min-h-0 min-w-0 grid-rows-[auto_auto_minmax(0,1fr)] text-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-(--ui-stroke-secondary) px-3 py-2">
        {sound.playing ? (
          <Button onClick={stop} size="sm">
            {recorder.recording ? t('stopRecording') : t('stop')}
          </Button>
        ) : (
          <>
            <Button disabled={!project.lanes.length} onClick={() => play(project.lanes)} size="sm">
              {t('play')}
            </Button>
            <Button
              disabled={!selected || song.busy}
              onClick={() => selected && void recorder.start(selected, sound.positionMs)}
              size="sm"
              title={selected ? undefined : t('selectLaneToRecord')}
              variant="secondary"
            >
              <span aria-hidden className="mr-1.5 inline-block size-2 rounded-full bg-red-500" />
              {t('record')}
            </Button>
          </>
        )}
        <Button disabled={sound.playing} onClick={() => sound.setPositionMs(0)} size="sm" title={t('rewind')} variant="ghost">
          ⏮
        </Button>
        <span className="w-14 text-xs tabular-nums text-(--ui-text-secondary)">{clock(sound.positionMs)}</span>
        <label className="flex items-center gap-1 text-xs text-(--ui-text-secondary)">
          {t('tempo')}
          <Input
            aria-label={t('tempo')}
            className="h-7 w-14 text-xs"
            defaultValue={project.tempo}
            disabled={sound.playing}
            key={project.tempo}
            max={240}
            min={40}
            onBlur={event => {
              const tempo = Number.parseInt(event.target.value, 10)

              if (tempo >= 40 && tempo <= 240 && tempo !== project.tempo) {
                void run(api => api.settings({ tempo }))
              }
            }}
            type="number"
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-(--ui-text-secondary)">
          <input checked={metronome} onChange={event => setMetronome(event.target.checked)} type="checkbox" />
          {t('metronome')}
        </label>
        {midi.inputs.length > 1 && (
          <Select onValueChange={midi.setInputId} value={midi.inputId}>
            <SelectTrigger aria-label={t('midiInput')} className="h-7 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {midi.inputs.map(input => (
                <SelectItem key={input.id} value={input.id}>
                  {input.name || input.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <span className="flex-1" />
        <Button disabled={song.busy || sound.playing} onClick={() => void run(api => api.undo())} size="sm" variant="ghost">
          {t('undo')}
        </Button>
        <AddLane disabled={song.busy || sound.playing} onAdd={addLane} />
      </div>
      <div className="grid gap-2 px-3 py-2 empty:hidden">
        {recorder.recording && (
          <p className="text-xs text-red-500" role="status">
            {recorder.recording.kind === 'midi' ? t('recordingMidi', recorder.recording.events) : t('recordingMic')}
          </p>
        )}
        {midi.notice && !recorder.recording && selected?.source === 'midi' && (
          <p className="text-xs text-(--ui-text-secondary)">{midi.notice}</p>
        )}
        {project.proposal && (
          <div className="grid gap-2 rounded-md border border-(--ui-stroke-secondary) p-2">
            <span className="text-xs font-semibold">{t('suggestion')}</span>
            <p className="max-h-24 overflow-y-auto text-xs whitespace-pre-wrap text-(--ui-text-secondary)">{project.proposal.brief}</p>
            <div className="flex gap-2">
              <Button
                disabled={sound.playing && !previewing}
                onClick={() => {
                  if (previewing && sound.playing) {
                    stop()

                    return
                  }

                  setPreviewing(true)
                  play(lanesWithSuggestion(project.lanes, project.proposal!))
                }}
                size="sm"
                variant="secondary"
              >
                {previewing && sound.playing ? t('stop') : t('preview')}
              </Button>
              <Button
                disabled={song.busy}
                onClick={() => {
                  stop()
                  void run(api => api.apply(project.proposal!.id))
                }}
                size="sm"
              >
                {t('keep')}
              </Button>
              <Button disabled={song.busy} onClick={() => void run(api => api.reject(project.proposal!.id))} size="sm" variant="ghost">
                {t('discard')}
              </Button>
            </div>
          </div>
        )}
        {song.error && <Failure message={song.error} onDismiss={() => song.setError('')} />}
      </div>
      {project.lanes.length ? (
        <Lanes
          busy={song.busy}
          lanes={project.lanes}
          lengthMs={lengthMs}
          onDelete={laneId => void run(api => api.deleteLane(laneId))}
          onImport={(lane, file) =>
            sound.engine.current &&
            void importAudio(sound.engine.current, lane, file, sound.positionMs, run).catch(err => song.setError(String(err)))
          }
          onSeek={ms => !sound.playing && sound.setPositionMs(ms)}
          onSelect={laneId => void run(api => api.settings({ selectedLaneId: laneId }))}
          onUpdate={(laneId, update) => void run(api => api.updateLane(laneId, update))}
          positionMs={sound.positionMs}
          recordingLaneId={recorder.recording?.laneId ?? null}
          selectedId={project.selectedLaneId}
          suggested={suggested}
          tempo={project.tempo}
        />
      ) : (
        <Centered>{t('empty')}</Centered>
      )}
    </div>
  )
}

function AddLane({ disabled, onAdd }: { disabled: boolean; onAdd: (source: Exclude<LaneSource, 'hermes'>, name: string, instrument: Instrument) => void }) {
  const t = useSongText()
  const [open, setOpen] = useState(false)
  const [source, setSource] = useState<'midi' | 'voice'>('midi')

  const pick = (kind: Exclude<LaneSource, 'hermes'>, name: string, instrument: Instrument) => {
    setOpen(false)
    onAdd(kind, name, instrument)
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button disabled={disabled} size="sm">
          {t('addLane')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="grid w-72 gap-2 p-3 text-sm">
        <div className="flex gap-1">
          {(['midi', 'voice'] as const).map(kind => (
            <Button key={kind} onClick={() => setSource(kind)} size="xs" variant={source === kind ? 'chip' : 'ghost'}>
              {kind === 'midi' ? t('addMidi') : t('addVoice')}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-1">
          {COMMON_INSTRUMENTS.filter(item => source === 'midi' || !item.instrument.drums).map(item => (
            <Button key={item.label} onClick={() => pick(source, item.label, item.instrument)} size="xs" variant="outline">
              {item.label}
            </Button>
          ))}
        </div>
        <Button onClick={() => pick('audio', t('addAudio'), { program: 0, drums: false })} size="xs" variant="ghost">
          {t('addAudio')}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

function OutdatedBackend() {
  const t = useSongText()
  const [restarting, setRestarting] = useState(false)

  return (
    <Centered>
      <div className="grid max-w-sm gap-3 text-center">
        <h3 className="text-base font-semibold">{t('outdatedTitle')}</h3>
        <p>{t('outdatedBody')}</p>
        <div>
          <Button
            disabled={restarting}
            onClick={() => {
              setRestarting(true)
              void host.restartGateway().finally(() => setRestarting(false))
            }}
          >
            {t('restartGateway')}
          </Button>
        </div>
      </div>
    </Centered>
  )
}

function InstrumentsGate({ state, onInstall }: { state: EngineState; onInstall: () => void }) {
  const t = useSongText()

  if (state.phase === 'missing') {
    return (
      <Centered>
        <div className="grid max-w-sm gap-3 text-center">
          <h3 className="text-base font-semibold">{t('instrumentsTitle')}</h3>
          <p className="text-(--ui-text-secondary)">{t('instrumentsBody', state.status.name, Math.round(state.status.size / 1e6))}</p>
          <p className="text-xs text-(--ui-text-tertiary)">{state.status.license}</p>
          <div>
            <Button onClick={onInstall}>{t('instrumentsInstall')}</Button>
          </div>
        </div>
      </Centered>
    )
  }

  if (state.phase === 'failed') {
    return (
      <Centered>
        <div className="grid max-w-sm gap-3">
          <ErrorState description={state.message} title={t('instrumentsFailed')} />
          <Button onClick={onInstall} variant="secondary">
            {t('retry')}
          </Button>
        </div>
      </Centered>
    )
  }

  const label =
    state.phase === 'loading'
      ? t('instrumentsLoading', Math.round(state.progress * 100))
      : state.phase === 'installing'
        ? t('instrumentsInstalling')
        : t('instrumentsChecking')

  return (
    <Centered>
      <Loader label={label} />
    </Centered>
  )
}

function Failure({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  const t = useSongText()

  return (
    <div className="flex items-start gap-2 rounded-md border border-red-500/40 p-2 text-xs" role="alert">
      <div className="grid min-w-0 flex-1 gap-1">
        <span className="font-semibold">{t('failed')}</span>
        <span className="break-words text-(--ui-text-secondary)">{message}</span>
      </div>
      {onDismiss && (
        <Button aria-label={t('dismiss')} onClick={onDismiss} size="micro" variant="ghost">
          ×
        </Button>
      )}
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-items-center p-6 text-center text-(--ui-text-secondary)">{children}</div>
}

function clock(ms: number) {
  const seconds = ms / 1000

  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`
}
