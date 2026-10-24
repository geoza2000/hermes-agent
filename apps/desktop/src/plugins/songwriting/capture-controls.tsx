import {
  Button,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'

import { AudioPlayer } from './audio-player'
import { useSongText } from './i18n'
import { downloadOriginalMidi, type PendingSource, type useSongCapture } from './use-capture'

interface CaptureControlsProps {
  capture: ReturnType<typeof useSongCapture>
  scopeKey: string
  disabled: boolean
}

export function CaptureControls({ capture: c, scopeKey, disabled }: CaptureControlsProps) {
  const t = useSongText()
  const pending = c.pending?.key === scopeKey ? c.pending : null

  return (
    <div className="grid min-w-0 gap-3">
      <SegmentedControl
        disabled={c.recording || c.starting}
        onChange={c.setSource}
        options={[
          { id: 'midi', label: t('midi') },
          { id: 'microphone', label: t('microphone') }
        ]}
        value={c.source}
      />
      {c.source === 'midi' ? (
        <div className="grid min-w-0 gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              disabled={c.recording || c.starting}
              onClick={() => void c.discover()}
              size="sm"
              variant="secondary"
            >
              {t('discover')}
            </Button>
            {c.inputs.length > 0 && (
              <Select disabled={c.recording || c.starting} onValueChange={c.setInputId} value={c.inputId}>
                <SelectTrigger aria-label={t('midiInput')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {c.inputs.map(input => (
                    <SelectItem key={input.id} value={input.id}>
                      {input.name || input.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <p className="text-(--ui-text-secondary)">{t('midiLimit')}</p>
        </div>
      ) : (
        <p className="text-(--ui-text-secondary)">{t('noAnalysis')}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {c.recording ? (
          <Button onClick={c.stop} size="sm">
            {t('stop')}
          </Button>
        ) : (
          <Button
            disabled={disabled || c.starting || Boolean(c.pending) || (c.source === 'midi' && !c.inputId)}
            onClick={() => void c.start()}
            size="sm"
          >
            {t('start')}
          </Button>
        )}
        {pending && (
          <Button disabled={disabled} onClick={c.retake} size="sm" variant="text">
            {t('retake')}
          </Button>
        )}
      </div>
      {c.recording && (
        <div className="flex flex-wrap items-center gap-2 text-(--ui-text-secondary)" role="status">
          <span>{t('recording')}</span>
          <span className="tabular-nums">{t('captureInfo', c.elapsed / 1000, c.events)}</span>
          {c.source === 'microphone' && <meter aria-label={t('micLevel')} max={1} min={0} value={c.level} />}
        </div>
      )}
      {pending && <PendingTakePreview pending={pending} />}
      {c.pending && !pending && <p role="status">{t('changed')}</p>}
      {c.notice && (
        <p className="text-(--ui-text-secondary)" role="status">
          {c.notice}
        </p>
      )}
    </div>
  )
}

interface PendingTakePreviewProps {
  pending: PendingSource
}

function PendingTakePreview({ pending }: PendingTakePreviewProps) {
  const t = useSongText()
  const take = pending.take
  const [preview, setPreview] = useState('')
  useEffect(() => {
    if (take.kind !== 'audio') {
      setPreview('')

      return
    }

    const url = URL.createObjectURL(take.blob)
    setPreview(url)

    return () => URL.revokeObjectURL(url)
  }, [take])

  return (
    <div className="grid min-w-0 gap-2">
      <p className="font-medium">{t(pending.savedPath ? 'saved' : 'localTake')}</p>
      <p className="break-words text-(--ui-text-secondary)">{pending.summary}</p>
      {preview && (
        <AudioPlayer
          aria-label={t('sourcePreview')}
          className="w-full min-w-0"
          controls
          preload="metadata"
          src={preview}
        />
      )}
      {take.kind === 'midi' && (
        <div>
          <Button onClick={() => downloadOriginalMidi(take)} size="sm" variant="text">
            {t('sourceDownload')}
          </Button>
        </div>
      )}
    </div>
  )
}
