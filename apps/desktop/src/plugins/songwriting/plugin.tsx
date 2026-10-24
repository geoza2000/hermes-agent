import { Button, type HermesPlugin, host, type TranscriptDirectiveContribution } from '@hermes/plugin-sdk'

import { SONGWRITING_LOCALES, useSongText } from './i18n'
import { SongPane } from './pane'

const PANE_ID = 'songwriting:lanes'

/** The `::songwriting` marker in a reply: a pointer to the pane, opened only when clicked. */
function OpenSongwriting() {
  const t = useSongText()

  return (
    <div className="my-2 flex flex-wrap items-center gap-3 text-sm">
      <Button onClick={() => host.revealPane(PANE_ID)} size="sm">
        {t('openPane')}
      </Button>
      <span className="text-(--ui-text-secondary)">{t('cardHint')}</span>
    </div>
  )
}

const plugin: HermesPlugin = {
  id: 'songwriting',
  name: 'Songwriting',
  defaultEnabled: false,
  description:
    'Write songs in lanes beside the chat: play MIDI, hum a part and hear it as an instrument, and let Hermes add or rework lanes. Requires the songwriting backend plugin.',
  register(ctx) {
    ctx.i18n.register(SONGWRITING_LOCALES)
    ctx.register({
      id: 'lanes',
      area: 'panes',
      title: 'Songwriting',
      data: {
        placement: 'main',
        dock: { pane: 'workspace', pos: 'right' },
        width: '620px',
        tabTitleText: () => 'Songwriting'
      },
      render: () => <SongPane />
    })
    ctx.register({
      id: 'open',
      area: 'transcript.directives',
      data: { name: 'songwriting', render: () => <OpenSongwriting /> } satisfies TranscriptDirectiveContribution
    })
  }
}

export default plugin
