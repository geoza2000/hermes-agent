import { Button, Input } from '@hermes/plugin-sdk'
import { useRef, useState } from 'react'

import type { Lane, LaneUpdate, SongNote } from './api'
import { useSongText } from './i18n'
import { InstrumentPicker } from './instrument-picker'

export const LANE_HEIGHT = 100
const RULER_HEIGHT = 22
const PX_PER_SECOND = 48
const LANE_COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#e03131', '#5f3dc4']

const SOURCE_LABEL = { midi: 'sourceMidi', voice: 'sourceVoice', audio: 'sourceAudio', hermes: 'sourceHermes' } as const

export function laneColor(index: number) {
  return LANE_COLORS[index % LANE_COLORS.length]
}

interface LanesProps {
  lanes: readonly Lane[]
  suggested: Readonly<Record<string, SongNote[]>>
  selectedId: string | null
  tempo: number
  lengthMs: number
  positionMs: number
  busy: boolean
  recordingLaneId: string | null
  onSelect: (laneId: string) => void
  onUpdate: (laneId: string, update: LaneUpdate) => void
  onDelete: (laneId: string) => void
  onImport: (lane: Lane, file: File) => void
  onSeek: (ms: number) => void
}

export function Lanes(props: LanesProps) {
  const { lanes, tempo, lengthMs, positionMs, onSeek } = props
  const width = Math.max(30_000, lengthMs + 8_000) * (PX_PER_SECOND / 1000)
  const barMs = (4 * 60_000) / tempo

  return (
    <div className="grid min-h-0 min-w-0 grid-cols-[13.5rem_minmax(0,1fr)] overflow-y-auto">
      <div className="border-r border-(--ui-stroke-secondary)">
        <div style={{ height: RULER_HEIGHT }} />
        {lanes.map((lane, index) => (
          <LaneHeader {...props} color={laneColor(index)} key={`${lane.id}:${lane.name}`} lane={lane} />
        ))}
      </div>
      <div className="relative min-w-0 overflow-x-auto">
        <div className="relative" style={{ width }}>
          <Ruler barMs={barMs} onSeek={onSeek} width={width} />
          {lanes.map((lane, index) => (
            <LaneTimeline
              color={laneColor(index)}
              key={lane.id}
              lane={lane}
              selected={lane.id === props.selectedId}
              suggested={props.suggested[lane.id]}
              width={width}
            />
          ))}
          <div
            aria-hidden
            className="pointer-events-none absolute top-0 bottom-0 w-px bg-(--ui-text-primary)"
            style={{ left: (positionMs / 1000) * PX_PER_SECOND }}
          />
        </div>
      </div>
    </div>
  )
}

function Ruler({ barMs, width, onSeek }: { barMs: number; width: number; onSeek: (ms: number) => void }) {
  const bars = Math.ceil((width / PX_PER_SECOND) * 1000 / barMs)

  return (
    <div
      className="relative cursor-pointer border-b border-(--ui-stroke-secondary) text-[0.625rem] text-(--ui-text-tertiary) select-none"
      onClick={event => {
        const box = event.currentTarget.getBoundingClientRect()
        onSeek(Math.max(0, ((event.clientX - box.left) / PX_PER_SECOND) * 1000))
      }}
      style={{ height: RULER_HEIGHT }}
    >
      {Array.from({ length: bars }, (_, bar) => (
        <span
          className="absolute top-0 h-full border-l border-(--ui-stroke-secondary) pl-1 leading-[22px]"
          key={bar}
          style={{ left: ((bar * barMs) / 1000) * PX_PER_SECOND }}
        >
          {bar + 1}
        </span>
      ))}
    </div>
  )
}

interface LaneHeaderProps extends LanesProps {
  lane: Lane
  color: string
}

function LaneHeader({ lane, color, selectedId, busy, recordingLaneId, onSelect, onUpdate, onDelete, onImport }: LaneHeaderProps) {
  const t = useSongText()
  const [name, setName] = useState(lane.name)
  const file = useRef<HTMLInputElement>(null)
  const selected = lane.id === selectedId
  const canSwitch = Boolean(lane.audio) && lane.notes.length > 0

  return (
    <div
      aria-selected={selected}
      className={`grid content-start gap-1.5 overflow-hidden border-b border-(--ui-stroke-secondary) px-2 py-2 ${selected ? 'bg-(--ui-bg-quaternary)' : ''}`}
      onClick={() => !selected && onSelect(lane.id)}
      role="option"
      style={{ height: LANE_HEIGHT, boxShadow: `inset 3px 0 0 ${color}` }}
    >
      <div className="flex min-w-0 items-center gap-1">
        {recordingLaneId === lane.id && <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-red-500" />}
        <Input
          aria-label={t('laneName')}
          className="h-6 min-w-0 flex-1 border-none bg-transparent px-1 text-xs font-medium shadow-none"
          onBlur={() => name.trim() && name !== lane.name && onUpdate(lane.id, { name: name.trim() })}
          onChange={event => setName(event.target.value)}
          value={name}
        />
        <span className="shrink-0 text-[0.625rem] text-(--ui-text-tertiary)">{t(SOURCE_LABEL[lane.source])}</span>
      </div>
      <InstrumentPicker
        disabled={busy}
        label={t('instrument')}
        onChange={instrument => onUpdate(lane.id, { instrument })}
        value={lane.instrument}
      />
      <div className="flex items-center gap-1">
        <Toggle label={t('muteLabel', lane.name)} on={lane.muted} onClick={() => onUpdate(lane.id, { muted: !lane.muted })} text={t('mute')} />
        <Toggle label={t('soloLabel', lane.name)} on={lane.solo} onClick={() => onUpdate(lane.id, { solo: !lane.solo })} text={t('solo')} />
        <input
          aria-label={t('volumeLabel', lane.name)}
          className="h-1 min-w-0 flex-1 accent-current"
          max={1}
          min={0}
          onChange={event => onUpdate(lane.id, { volume: Number(event.target.value) })}
          step={0.05}
          type="range"
          value={lane.volume}
        />
        {canSwitch && (
          <Button
            onClick={() => onUpdate(lane.id, { play: lane.play === 'notes' ? 'audio' : 'notes' })}
            size="micro"
            variant="ghost"
          >
            {lane.play === 'notes' ? t('hearVoice') : t('hearInstrument')}
          </Button>
        )}
        {lane.source !== 'midi' && lane.source !== 'hermes' && (
          <>
            <Button disabled={busy} onClick={() => file.current?.click()} size="micro" title={t('importAudio')} variant="ghost">
              ⤓
            </Button>
            <input
              accept="audio/*"
              aria-label={t('importAudio')}
              className="hidden"
              onChange={event => {
                const chosen = event.target.files?.[0]
                event.target.value = ''

                if (chosen) {
                  onImport(lane, chosen)
                }
              }}
              ref={file}
              type="file"
            />
          </>
        )}
        <Button disabled={busy} onClick={() => onDelete(lane.id)} size="micro" title={t('delete')} variant="ghost">
          ×
        </Button>
      </div>
    </div>
  )
}

function Toggle({ on, text, label, onClick }: { on: boolean; text: string; label: string; onClick: () => void }) {
  return (
    <button
      aria-label={label}
      aria-pressed={on}
      className={`grid size-5 place-items-center rounded text-[0.625rem] font-bold ${
        on ? 'bg-(--ui-text-primary) text-(--ui-bg-elevated)' : 'border border-(--ui-stroke-secondary) text-(--ui-text-secondary)'
      }`}
      onClick={event => {
        event.stopPropagation()
        onClick()
      }}
      type="button"
    >
      {text}
    </button>
  )
}

interface LaneTimelineProps {
  lane: Lane
  color: string
  width: number
  selected: boolean
  suggested?: SongNote[]
}

function LaneTimeline({ lane, color, width, selected, suggested }: LaneTimelineProps) {
  const pitches = [...lane.notes, ...(suggested ?? [])].map(note => note.note)
  const low = Math.min(...pitches, 60) - 1
  const high = Math.max(...pitches, 72) + 1
  const y = (note: number) => 6 + ((high - note) / (high - low)) * (LANE_HEIGHT - 16)
  const x = (ms: number) => (ms / 1000) * PX_PER_SECOND
  const quiet = lane.play === 'audio'

  return (
    <svg
      className={`block box-border border-b border-(--ui-stroke-secondary) ${selected ? 'bg-(--ui-bg-quaternary)' : ''}`}
      height={LANE_HEIGHT}
      width={width}
    >
      {lane.audio && (
        <rect
          fill={color}
          height={LANE_HEIGHT - 12}
          opacity={quiet ? 0.35 : 0.12}
          rx={4}
          width={Math.max(2, x(lane.audio.durationMs))}
          x={x(lane.audio.startMs)}
          y={6}
        />
      )}
      {lane.notes.map((note, index) => (
        <rect
          fill={color}
          height={4}
          key={index}
          opacity={quiet ? 0.35 : 0.95}
          rx={1}
          width={Math.max(2, x(note.durationMs))}
          x={x(note.startMs)}
          y={y(note.note)}
        />
      ))}
      {suggested?.map((note, index) => (
        <rect
          fill="none"
          height={5}
          key={`s${index}`}
          rx={1}
          stroke="currentColor"
          strokeDasharray="2 1"
          width={Math.max(2, x(note.durationMs))}
          x={x(note.startMs)}
          y={y(note.note) - 0.5}
        />
      ))}
    </svg>
  )
}
