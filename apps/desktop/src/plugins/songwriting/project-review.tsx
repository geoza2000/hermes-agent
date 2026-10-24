import { Button } from '@hermes/plugin-sdk'

import type { SongProject, SongScope } from './api'
import { useSongText } from './i18n'
import { TrackList } from './tracks'
import type { useSongProject } from './use-project'

interface ProjectControlsProps {
  server: ReturnType<typeof useSongProject>
  scope: SongScope | null
}

interface ProjectReviewProps extends ProjectControlsProps {
  scopeKey: string
}

export function ProjectReview({ server, scope, scopeKey }: ProjectReviewProps) {
  const t = useSongText()
  const project = server.project

  if (!project) {
    return null
  }

  return (
    <>
      <p className="text-(--ui-text-tertiary)">{t('revision', project.revision)}</p>
      {scope && (
        <TrackList
          busy={server.busy}
          isCurrent={server.isCurrent}
          key={`${scopeKey}:${project.revision}`}
          project={project}
          run={server.run}
          scope={scope}
        />
      )}
      {project.proposal && <Proposal project={project} />}
    </>
  )
}

interface RevisionActionsProps extends ProjectControlsProps {
  onAction: (kind: 'apply' | 'reject' | 'undo') => void
}

export function RevisionActions({ server, scope, onAction }: RevisionActionsProps) {
  const t = useSongText()

  return (
    <>
      <Button disabled={server.busy || !scope} onClick={() => void server.refresh()} size="sm" variant="text">
        {t('refresh')}
      </Button>
      {server.project?.proposal && (
        <>
          <Button disabled={server.busy} onClick={() => onAction('apply')} size="sm">
            {t('apply')}
          </Button>
          <Button disabled={server.busy} onClick={() => onAction('reject')} size="sm" variant="secondary">
            {t('reject')}
          </Button>
        </>
      )}
      {Boolean(server.project?.revision) && (
        <Button disabled={server.busy} onClick={() => onAction('undo')} size="sm" variant="text">
          {t('undo')}
        </Button>
      )}
    </>
  )
}

interface ProposalProps {
  project: SongProject
}

function Proposal({ project }: ProposalProps) {
  const t = useSongText()
  const proposal = project.proposal

  if (!proposal) {
    return null
  }

  return (
    <div className="grid min-w-0 gap-2">
      <h4 className="font-medium">{t('proposal')}</h4>
      <p className="text-(--ui-text-secondary)">{t('baseRevision', proposal.baseRevision)}</p>
      <p className="whitespace-pre-wrap break-words">{proposal.brief}</p>
      {proposal.tracks.map(track => {
        const current = project.tracks.find(item => item.id === track.id)

        const change = !current
          ? 'added'
          : JSON.stringify(track) === JSON.stringify(current)
            ? 'unchanged'
            : 'changedTrack'

        return (
          <details key={track.id}>
            <summary>
              {track.name} · {t(change)} · {t('notes', track.notes?.length ?? 0)}
            </summary>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
              {JSON.stringify(
                { instrument: track.instrument, protected: track.protected, notes: track.notes, path: track.path },
                null,
                2
              )}
            </pre>
          </details>
        )
      })}
      {project.tracks
        .filter(track => !proposal.tracks.some(item => item.id === track.id))
        .map(track => (
          <p key={track.id}>
            {track.name} · {t('removed')}
          </p>
        ))}
      <p className="text-(--ui-text-tertiary)">{t('compareUnavailable')}</p>
    </div>
  )
}
