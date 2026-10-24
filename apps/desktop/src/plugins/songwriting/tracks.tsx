/* eslint-disable no-restricted-imports -- Native download must retain the original gateway owner, not the active SDK composer. */
import { Button } from '@hermes/plugin-sdk'
import { useState } from 'react'

import { downloadGatewayMediaFile } from '@/lib/media'

import type { createSongwritingApi, SongProject, SongScope } from './api'
import { loadPlayback, selectedTrackIds } from './api'
import { AudioPlayer } from './audio-player'
import { useSongText } from './i18n'

interface TrackListProps {
  project: SongProject
  scope: SongScope
  busy: boolean
  run: (fn: (api: ReturnType<typeof createSongwritingApi>) => Promise<void>) => Promise<void>
  isCurrent: () => boolean
}

export function TrackList({ project, scope, busy, run, isCurrent }: TrackListProps) {
  const t = useSongText()
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [muted, setMuted] = useState<Record<string, boolean>>({})
  const [solo, setSolo] = useState<Record<string, boolean>>({})
  const [loop, setLoop] = useState(false)
  const [players, setPlayers] = useState<Record<string, string>>({})
  const [mix, setMix] = useState<{ signature: string; url: string } | null>(null)
  const [notice, setNotice] = useState('')
  const ids = selectedTrackIds(project.tracks, selected, muted, solo)
  const soloing = project.tracks.some(track => solo[track.id])
  const signature = JSON.stringify([project.revision, ids])

  const toggle = (setter: typeof setMuted, id: string, value: boolean) =>
    setter(current => ({ ...current, [id]: value }))

  const prepare = (id: string) =>
    run(async api => {
      const result = await api.render([id])
      const url = await loadPlayback(result.path, scope.owner)

      if (isCurrent()) {
        setPlayers(current => ({ ...current, [id]: url }))
      }
    })

  const renderMix = () =>
    run(async api => {
      const rendered = await api.render(ids)
      const url = await loadPlayback(rendered.path, scope.owner)

      if (isCurrent()) {
        setMix({ signature, url })
      }
    })

  const exportMix = () =>
    run(async api => {
      const rendered = await api.export(ids)

      // Download is tied to this operation's owner even if the foreground changes.
      if (!isCurrent()) {
        return
      }

      const result = await downloadGatewayMediaFile(rendered.path, {
        owner: scope.owner,
        sessionId: scope.sessionId,
        suggestedName: 'song.wav'
      })

      if (isCurrent()) {
        setNotice(t(result.saved ? 'savedExport' : 'exportCanceled'))
      }
    })

  if (!project.tracks.length) {
    return <p className="text-(--ui-text-secondary)">{t('empty')}</p>
  }

  return (
    <div className="grid min-w-0 gap-4">
      <h4 className="font-medium">{t('tracks')}</h4>
      {project.tracks.map(track => (
        <div className="grid min-w-0 gap-2" key={track.id}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{track.name}</span>
            <span className="text-(--ui-text-tertiary)">
              {t(track.kind === 'audio' ? 'kindAudio' : 'kindMidi')} ·{' '}
              {t(
                {
                  recorded: 'originRecorded',
                  generated: 'originGenerated',
                  imported: 'originImported',
                  separated: 'originSeparated'
                }[track.origin]
              )}
            </span>
            {track.protected && <span className="text-(--ui-text-secondary)">{t('protected')}</span>}
            {track.muted && <span className="text-(--ui-text-secondary)">{t('savedMuted')}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1">
              <input
                aria-label={t('selected', track.name)}
                checked={selected[track.id] !== false}
                onChange={e => toggle(setSelected, track.id, e.target.checked)}
                type="checkbox"
              />
              {t('selected', track.name)}
            </label>
            <Button
              aria-label={t('muted', track.name)}
              aria-pressed={muted[track.id] ?? track.muted ?? false}
              disabled={track.muted === true}
              onClick={() => toggle(setMuted, track.id, !(muted[track.id] ?? track.muted))}
              size="xs"
              variant="ghost"
            >
              {t('muted', track.name)}
            </Button>
            <Button
              aria-label={t('solo', track.name)}
              aria-pressed={solo[track.id] ?? false}
              onClick={() => toggle(setSolo, track.id, !solo[track.id])}
              size="xs"
              variant="ghost"
            >
              {t('solo', track.name)}
            </Button>
            <Button
              disabled={busy || track.muted === true}
              onClick={() => void prepare(track.id)}
              size="xs"
              variant="secondary"
            >
              {t('play', track.name)}
            </Button>
          </div>
          {players[track.id] && (
            <AudioPlayer
              aria-label={track.name}
              className="w-full min-w-0"
              controls
              key={`${project.revision}:${track.id}`}
              loop={loop}
              muted={Boolean((muted[track.id] ?? track.muted) || (soloing && !solo[track.id]))}
              preload="metadata"
              src={players[track.id]}
            />
          )}
        </div>
      ))}
      <p className="text-(--ui-text-secondary)">{t('mixScope')}</p>
      <label className="flex items-center gap-2">
        <input checked={loop} onChange={e => setLoop(e.target.checked)} type="checkbox" />
        {t('loop')}
      </label>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !ids.length} onClick={() => void renderMix()} size="sm" variant="secondary">
          {t('mix')}
        </Button>
        <Button disabled={busy || !ids.length} onClick={() => void exportMix()} size="sm">
          {t('export')}
        </Button>
      </div>
      {!ids.length && <p role="status">{t('noSelection')}</p>}
      {mix?.signature === signature && (
        <AudioPlayer
          aria-label={t('mixPreview')}
          className="w-full min-w-0"
          controls
          loop={loop}
          preload="metadata"
          src={mix.url}
        />
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  )
}
