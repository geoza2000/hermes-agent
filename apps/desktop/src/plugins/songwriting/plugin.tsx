import type { HermesPlugin, TranscriptDirectiveContribution } from '@hermes/plugin-sdk'

import { SongwritingCard } from './card'
import { SONGWRITING_LOCALES } from './i18n'

const plugin: HermesPlugin = {
  id: 'songwriting',
  name: 'Songwriting',
  defaultEnabled: false,
  description:
    'Record MIDI or microphone ideas and collaborate on editable songs inside normal chat. Requires the songwriting backend plugin.',
  register(ctx) {
    ctx.i18n.register(SONGWRITING_LOCALES)
    ctx.register({
      id: 'capture',
      area: 'transcript.directives',
      data: { name: 'songwriting', render: () => <SongwritingCard /> } satisfies TranscriptDirectiveContribution
    })
  }
}

export default plugin
