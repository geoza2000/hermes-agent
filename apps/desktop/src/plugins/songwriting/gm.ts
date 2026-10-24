/** General MIDI program names, in program order (0–127), grouped by family of eight. */
export const GM_PROGRAMS = [
  'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano',
  'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavinet',
  'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone', 'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
  'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ',
  'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
  'Nylon Guitar', 'Steel Guitar', 'Jazz Guitar', 'Clean Electric Guitar',
  'Muted Guitar', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics',
  'Acoustic Bass', 'Fingered Bass', 'Picked Bass', 'Fretless Bass',
  'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
  'Violin', 'Viola', 'Cello', 'Contrabass', 'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
  'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2',
  'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit',
  'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet', 'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
  'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax', 'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
  'Piccolo', 'Flute', 'Recorder', 'Pan Flute', 'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
  'Square Lead', 'Sawtooth Lead', 'Calliope Lead', 'Chiff Lead',
  'Charang Lead', 'Voice Lead', 'Fifths Lead', 'Bass + Lead',
  'New Age Pad', 'Warm Pad', 'Polysynth Pad', 'Choir Pad', 'Bowed Pad', 'Metallic Pad', 'Halo Pad', 'Sweep Pad',
  'Rain', 'Soundtrack', 'Crystal', 'Atmosphere', 'Brightness', 'Goblins', 'Echoes', 'Sci-fi',
  'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Bagpipe', 'Fiddle', 'Shanai',
  'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock', 'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
  'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet', 'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot'
] as const

export const GM_FAMILIES = [
  'Piano', 'Chromatic percussion', 'Organ', 'Guitar', 'Bass', 'Strings', 'Ensemble', 'Brass',
  'Reed', 'Pipe', 'Synth lead', 'Synth pad', 'Synth effects', 'Ethnic', 'Percussive', 'Sound effects'
] as const

export interface Instrument {
  program: number
  drums: boolean
}

export const DRUM_KIT: Instrument = { program: 0, drums: true }

export function instrumentName(instrument: Instrument): string {
  return instrument.drums ? 'Drum kit' : (GM_PROGRAMS[instrument.program] ?? `Program ${instrument.program}`)
}

/** Quick picks for the Add lane menu: what people reach for first. */
export const COMMON_INSTRUMENTS: readonly { label: string; instrument: Instrument }[] = [
  { label: 'Piano', instrument: { program: 0, drums: false } },
  { label: 'Drums', instrument: DRUM_KIT },
  { label: 'Bass', instrument: { program: 33, drums: false } },
  { label: 'Electric piano', instrument: { program: 4, drums: false } },
  { label: 'Guitar', instrument: { program: 27, drums: false } },
  { label: 'Strings', instrument: { program: 48, drums: false } },
  { label: 'Trumpet', instrument: { program: 56, drums: false } },
  { label: 'Sax', instrument: { program: 65, drums: false } },
  { label: 'Flute', instrument: { program: 73, drums: false } },
  { label: 'Synth lead', instrument: { program: 81, drums: false } },
  { label: 'Pad', instrument: { program: 89, drums: false } },
  { label: 'Choir', instrument: { program: 52, drums: false } }
]
