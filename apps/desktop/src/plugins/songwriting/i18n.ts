import { usePluginI18n } from '@hermes/plugin-sdk'

export const en = {
  title: 'Songwriting',
  noChat: 'Open a chat to work on its song. Each chat has its own song.',
  openPane: 'Open in Songwriting',
  cardHint: 'Your lanes are in the Songwriting pane. Ask me to add lanes, change instruments or rework a part.',

  instrumentsTitle: 'Get the instruments',
  instrumentsBody: (name: string, megabytes: number) =>
    `Lanes play real sampled instruments from ${name} (${megabytes} MB, a one-time download to this profile).`,
  instrumentsInstall: 'Download instruments',
  instrumentsInstalling: 'Downloading instruments…',
  instrumentsLoading: (percent: number) => `Loading instruments… ${percent}%`,
  instrumentsChecking: 'Checking instruments…',
  instrumentsFailed: 'Instruments unavailable',
  retry: 'Try again',

  play: 'Play',
  stop: 'Stop',
  record: 'Record',
  stopRecording: 'Stop recording',
  rewind: 'Back to start',
  tempo: 'Tempo',
  metronome: 'Metronome',
  midiInput: 'MIDI keyboard',
  undo: 'Undo',
  songTitle: 'Song title',
  recordingMidi: (events: number) => `Recording · ${events} MIDI events`,
  recordingMic: 'Recording from the microphone',
  selectLaneToRecord: 'Select a lane to record onto.',

  addLane: 'Add lane',
  addMidi: 'Play an instrument (MIDI)',
  addVoice: 'Hum or sing → instrument',
  addAudio: 'Audio recording',
  empty: 'No lanes yet. Add one, or ask Hermes in the chat, e.g. “add a bass lane, I’ll play it on my keyboard”.',

  instrument: 'Instrument',
  laneName: 'Lane name',
  drumKit: 'Drum kit',
  mute: 'M',
  muteLabel: (name: string) => `Mute ${name}`,
  solo: 'S',
  soloLabel: (name: string) => `Solo ${name}`,
  volumeLabel: (name: string) => `${name} volume`,
  delete: 'Delete lane',
  importAudio: 'Import audio file',
  hearVoice: 'Hear voice',
  hearInstrument: 'Hear instrument',
  sourceMidi: 'MIDI',
  sourceVoice: 'Voice → instrument',
  sourceAudio: 'Audio',
  sourceHermes: 'Hermes',
  selectedHint: 'Your keyboard plays the selected lane, Record records onto it, and “this lane” in the chat means it.',
  noNotesHeard: 'No notes were heard in that take. Hum a little louder, one note at a time.',

  suggestion: 'Hermes suggests',
  preview: 'Preview',
  keep: 'Keep',
  discard: 'Discard',

  outdatedTitle: 'Restart Hermes to update songwriting',
  outdatedBody:
    'This chat’s gateway is still running an older songwriting backend. Restart it to use lanes; your chats and recordings are kept.',
  restartGateway: 'Restart gateway',

  failed: 'Songwriting could not complete that',
  dismiss: 'Dismiss',
  backendHint: 'If this keeps happening, enable the songwriting plugin for this profile and start a new chat.'
}
export const SONGWRITING_LOCALES = { en }

export function useSongText() {
  return usePluginI18n('songwriting')
}
