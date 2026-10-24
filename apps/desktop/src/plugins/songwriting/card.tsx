/* eslint-disable no-restricted-imports -- First-party submit must target the containing surface, and widgets reuse the canonical shell. */
import { Button, ErrorState, Loader, SegmentedControl, Textarea } from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'

import { requestComposerSubmit } from '@/app/chat/composer/focus'
import { WIDGET_SHELL_CLASS } from '@/components/chat/widget-shell'

import { type SongGoal, sourcePrompt } from './api'
import { CaptureControls } from './capture-controls'
import { useSongText } from './i18n'
import { ProjectReview, RevisionActions } from './project-review'
import { saveAndVerifySource } from './save-source'
import { useSongwritingScope } from './scope'
import { type PendingSource, useSongCapture } from './use-capture'
import { useSongProject } from './use-project'
import { useShareApproval } from './use-share-approval'

export function SongwritingCard() {
  const t = useSongText()
  const context = useSongwritingScope()
  const { key, scope, target, surfaceId } = context
  const server = useSongProject(key, scope)
  const capture = useSongCapture(key, scope)
  const [goal, setGoal] = useState<SongGoal>('fullsong')
  const [brief, setBrief] = useState('')
  const [uploadApproved, setUploadApproved] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const [briefEdited, setBriefEdited] = useState(false)
  const pending = capture.pending?.key === key ? capture.pending : null

  const {
    approved: shareApproved,
    setApproved: setShareApproved,
    isApproved
  } = useShareApproval({
    key,
    scope,
    savedPath: pending?.savedPath,
    brief,
    goal,
    revision: server.project?.revision
  })

  useEffect(() => {
    setBrief('')
    setBriefEdited(false)
    setUploadApproved(false)
    setShareApproved(false)
    setError('')
    setNotice('')
  }, [key, setShareApproved])
  useEffect(() => {
    if (server.project && !briefEdited) {
      setBrief(server.project.brief)
    }
  }, [server.project, briefEdited])
  useEffect(() => {
    setUploadApproved(false)
    setShareApproved(false)
    setNotice('')
  }, [pending?.take, pending?.savedPath, setShareApproved])

  const save = () => {
    if (!pending?.scope || (!pending.savedPath && !uploadApproved) || pending.verified) {
      return
    }

    const source = pending
    void server.run(async api => {
      const project = await saveAndVerifySource({
        api,
        source,
        onReceipt: receipt =>
          capture.setPending(current =>
            current?.take === source.take && current.key === source.key ? receipt : current
          ),
        missingMessage: t('verificationMissing')
      })

      if (server.isCurrent()) {
        server.setProject(project)
      }
    })
  }

  const share = () => {
    if (!pending?.savedPath || !pending.verified || !isApproved() || !surfaceId || !scope || server.busy) {
      return
    }

    const ok = requestComposerSubmit(sourcePrompt(pending.savedPath, pending.summary, goal, brief), {
      target,
      surfaceId
    })

    setError(ok ? '' : t('submitUnavailable'))

    if (ok) {
      setNotice(t('shared'))
      setShareApproved(false)
    }
  }

  const importFile = async (file?: File) => {
    setError('')

    if (!file) {
      return
    }

    if (!file.type.startsWith('audio/')) {
      setError(t('notAudio'))

      return
    }

    if (file.size > 20 * 1024 * 1024) {
      setError(t('tooLarge'))

      return
    }

    capture.setPending({
      key,
      scope,
      take: { kind: 'audio', blob: file, name: file.name, durationMs: 0 },
      summary: t('importedSummary', file.name, file.size)
    })
  }

  const revisionAction = (kind: 'apply' | 'reject' | 'undo') => {
    const project = server.project

    if (!project) {
      return
    }

    void server.run(async api => {
      if (kind === 'apply' && project.proposal) {
        await api.apply(project.proposal.id, project.proposal.baseRevision)
      }

      if (kind === 'reject' && project.proposal) {
        await api.reject(project.proposal.id)
      }

      if (kind === 'undo') {
        await api.undo(project.revision)
      }

      const verified = await api.project()

      if (server.isCurrent()) {
        server.setProject(verified)
      }
    })
  }

  const failure = error || server.error || capture.error

  return (
    <section aria-label={t('title')} className="my-3 grid min-w-0 gap-3 text-sm">
      <div className={`${WIDGET_SHELL_CLASS} grid min-w-0 gap-5`}>
        <header className="grid gap-2">
          <h3 className="font-semibold">{t('title')}</h3>
          <p className="text-(--ui-text-secondary)">{t('intro')}</p>
        </header>
        <div className="grid gap-2">
          <span className="font-medium">{t('goal')}</span>
          <SegmentedControl
            onChange={setGoal}
            options={(['fullsong', 'oneinstrument', 'layer'] as const).map(id => ({ id, label: t(id) }))}
            value={goal}
          />
        </div>
        <CaptureControls capture={capture} disabled={server.busy} scopeKey={key} />
        <div className="grid gap-2">
          <label className="font-medium" htmlFor={`song-brief-${surfaceId}`}>
            {t('brief')}
          </label>
          <Textarea
            aria-label={t('brief')}
            id={`song-brief-${surfaceId}`}
            onChange={event => {
              setBriefEdited(true)
              setBrief(event.target.value)
            }}
            placeholder={t('briefHint')}
            value={brief}
          />
        </div>
        <SourceReview
          onShareApproval={setShareApproved}
          onUploadApproval={setUploadApproved}
          pending={pending}
          shareApproved={shareApproved}
          uploadApproved={uploadApproved}
        />
        {!scope && <p role="status">{t('sessionRequired')}</p>}
        <ProjectReview scope={scope} scopeKey={key} server={server} />
        <p className="text-(--ui-text-tertiary)">{t('engine')}</p>
        <p className="text-(--ui-text-tertiary)">{t('separation')}</p>
        {server.busy && <Loader label={t('busy')} />}
        {failure && (
          <div role="alert">
            <ErrorState description={failure} title={t('failed')} />
            <p className="mt-2 text-(--ui-text-secondary)">{t('backendHint')}</p>
          </div>
        )}
        {notice && <p role="status">{notice}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        <TakeActions
          busy={server.busy}
          hasScope={Boolean(scope)}
          hasSurface={Boolean(surfaceId)}
          onSave={save}
          onShare={share}
          pending={pending}
          shareApproved={shareApproved}
          uploadApproved={uploadApproved}
        />
        <Button
          disabled={
            server.busy ||
            capture.recording ||
            capture.starting ||
            Boolean(capture.pending && !capture.pending.savedPath)
          }
          onClick={() => fileInput.current?.click()}
          size="sm"
          variant="secondary"
        >
          {t('import')}
        </Button>
        <input
          accept="audio/*"
          aria-label={t('import')}
          className="hidden"
          onChange={event => {
            void importFile(event.target.files?.[0])
            event.target.value = ''
          }}
          ref={fileInput}
          type="file"
        />
        <RevisionActions onAction={revisionAction} scope={scope} server={server} />
      </div>
    </section>
  )
}

interface TakeActionsProps {
  pending: PendingSource | null
  busy: boolean
  hasScope: boolean
  hasSurface: boolean
  uploadApproved: boolean
  shareApproved: boolean
  onSave: () => void
  onShare: () => void
}

function TakeActions({
  pending,
  busy,
  hasScope,
  hasSurface,
  uploadApproved,
  shareApproved,
  onSave,
  onShare
}: TakeActionsProps) {
  const t = useSongText()

  if (!pending) {
    return null
  }

  if (!pending.savedPath) {
    return (
      <Button disabled={busy || !hasScope || !uploadApproved} onClick={onSave} size="sm">
        {t('save')}
      </Button>
    )
  }

  if (!pending.verified) {
    return (
      <Button disabled={busy || !hasScope} onClick={onSave} size="sm">
        {t('verifySave')}
      </Button>
    )
  }

  return (
    <Button disabled={busy || !hasScope || !hasSurface || !shareApproved} onClick={onShare} size="sm">
      {t('share')}
    </Button>
  )
}

interface SourceReviewProps {
  pending: PendingSource | null
  uploadApproved: boolean
  shareApproved: boolean
  onUploadApproval: (approved: boolean) => void
  onShareApproval: (approved: boolean) => void
}

function SourceReview({
  pending,
  uploadApproved,
  shareApproved,
  onUploadApproval,
  onShareApproval
}: SourceReviewProps) {
  const t = useSongText()

  if (!pending) {
    return null
  }

  return (
    <div className="grid min-w-0 gap-3">
      <h4 className="font-medium">{t('reviewing')}</h4>
      <p className="text-(--ui-text-secondary)">{t('privacy')}</p>
      {pending.savedPath ? (
        <>
          <p className="break-all font-mono text-xs">{pending.savedPath}</p>
          {pending.verified ? (
            <label className="flex items-start gap-2">
              <input checked={shareApproved} onChange={e => onShareApproval(e.target.checked)} type="checkbox" />
              {t('shareConsent')}
            </label>
          ) : (
            <p role="status">{t('verificationPending')}</p>
          )}
        </>
      ) : (
        <>
          <p className="text-(--ui-text-secondary)">{t('saveFirst')}</p>
          <label className="flex items-start gap-2">
            <input checked={uploadApproved} onChange={e => onUploadApproval(e.target.checked)} type="checkbox" />
            {t('uploadConsent')}
          </label>
        </>
      )}
    </div>
  )
}
