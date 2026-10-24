import { usePluginI18n } from '@hermes/plugin-sdk'

export const en = {
  title: 'Songwriting',
  intro:
    'Capture an idea here, then ask Hermes to propose editable instrumental parts. Your recordings stay on this device until you save them.',
  midi: 'MIDI',
  microphone: 'Microphone',
  discover: 'Find MIDI inputs',
  midiInput: 'MIDI input',
  noMidi: 'No MIDI inputs found. Connect a device and scan again, or use the microphone.',
  unsupportedMidi: 'Web MIDI is unavailable. Use the microphone or import audio.',
  fullsong: 'Full song',
  oneinstrument: 'One instrument',
  layer: 'Add a layer',
  goal: 'Requested scope',
  start: 'Start recording',
  stop: 'Stop & keep take',
  save: 'Save take',
  retake: 'Retake',
  share: 'Share with Hermes',
  refresh: 'Refresh song',
  import: 'Import audio',
  export: 'Export WAV',
  brief: 'Song brief',
  briefHint: 'Describe the mood, tempo, instruments and what must stay untouched.',
  uploadConsent: 'I approve sending this take to this conversation’s gateway (an upload if the gateway is remote).',
  shareConsent: 'I approve sharing this saved source and brief with my configured Hermes model.',
  privacy:
    'Saving transfers the source to the owning gateway, not the model. Sharing is a separate action. No automatic transcription, music recognition or external music provider.',
  reviewing: 'Review source before sharing',
  localTake: 'Unsaved source on this device',
  saved: 'Saved source',
  verificationPending:
    'The gateway saved this source, but verification is still required before sharing. Retry verification; do not upload it again.',
  verifySave: 'Retry save verification',
  verificationMissing: 'The saved source is not present in the gateway project. Retry verification before sharing.',
  captureInfo: (seconds: number, events: number) => `${seconds.toFixed(1)} s · ${events} MIDI events`,
  midiSummary: (name: string, seconds: number, events: number, notes: number, channels: string) =>
    `${name} · ${seconds.toFixed(1)} s · ${events} events · ${notes} note-ons · channels ${channels || '—'} · key not inferred`,
  audioSummary: (name: string, seconds: number, bytes: number) =>
    `${name} · ${seconds.toFixed(1)} s · ${bytes} bytes · audio not transcribed or analyzed`,
  ended: (reason: string) => `Take kept (${reason}).`,
  disconnected: 'Input disconnected; the partial take is kept.',
  limit: 'Capture limit reached; the partial take is kept.',
  midiLimit: 'MIDI capture stops at 20,000 messages or 5 minutes; the partial take is kept.',
  micLevel: 'Microphone input level',
  recording: 'Recording locally',
  busy: 'Working',
  failed: 'Songwriting could not complete the action',
  sessionRequired: 'Send a message in this conversation before saving a song.',
  changed: 'A take is held for its original conversation. Return there to save it; it will not be sent to this chat.',
  empty: 'No saved tracks yet. Record or import a source, then share an approved brief with Hermes.',
  tracks: 'Tracks',
  savedMuted: 'Muted in this saved revision; ask Hermes to propose unmuting it.',
  protected: 'Protected original',
  selected: (name: string) => `Include ${name} in mix`,
  muted: (name: string) => `Mute ${name}`,
  solo: (name: string) => `Solo ${name}`,
  play: (name: string) => `Prepare playback: ${name}`,
  loop: 'Loop playback',
  mix: 'Preview selected mix',
  mixScope:
    'Preview and WAV export use only checked, unmuted tracks; solo narrows that selection. Originals remain untouched.',
  noSelection: 'Select at least one unmuted track.',
  proposal: 'Proposed changes',
  baseRevision: (revision: number) => `Based on revision ${revision}`,
  apply: 'Apply proposal',
  reject: 'Reject proposal',
  undo: 'Undo last revision',
  compareUnavailable:
    'Audio A/B preview of unapplied proposals is not supported in this build. Review the named score changes before applying; Undo restores the previous revision.',
  notes: (count: number) => `${count} notes`,
  removed: 'Removed in proposal',
  added: 'Added in proposal',
  changedTrack: 'Changed in proposal',
  unchanged: 'Unchanged',
  separation: 'Stem separation is not supported in this build. Imported audio stays intact as a protected original.',
  engine:
    'Hermes uses your configured model to propose a score; the gateway renders a local sequenced instrumental preview. This is not a trained full-song or vocal generator.',
  backendHint:
    'If unavailable, install and enable the songwriting backend plugin for this conversation’s profile, then refresh.',
  importedSummary: (name: string, bytes: number) =>
    `${name} · ${bytes} bytes · duration not yet measured · audio not transcribed or analyzed`,
  tooLarge: 'Audio imports are limited to 20 MB.',
  notAudio: 'Choose an audio file.',
  submitUnavailable: 'The containing composer is not available. Nothing was shared; try again in this conversation.',
  shared: 'Shared as a visible message in this conversation. Refresh song after Hermes replies.',
  sourceDownload: 'Download original MIDI',
  savedExport: 'WAV exported',
  exportCanceled: 'WAV save canceled',
  refreshed: 'Song refreshed',
  revision: (revision: number) => `Revision ${revision}`,
  kindMidi: 'MIDI score',
  kindAudio: 'Audio',
  originRecorded: 'Recorded',
  originGenerated: 'Agent-proposed',
  originImported: 'Imported original',
  originSeparated: 'Separated',
  noAnalysis: 'Microphone capture records audio only; no inferred notes, tempo or key.',
  sourcePreview: 'Local audio preview',
  mixPreview: 'Selected mix preview',
  sharePrompt: 'Ask Hermes to…',
  saveFirst: 'Save this source first, then review sharing below.',
  preparing: 'Preparing playback'
}
export const SONGWRITING_LOCALES = { en }

export function useSongText() {
  const t = usePluginI18n('songwriting')

  return t
}
