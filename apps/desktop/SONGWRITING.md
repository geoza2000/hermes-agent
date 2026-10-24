# Songwriting lanes (experimental)

A GarageBand-style multitrack in a pane beside the chat. Each chat has its own song. Each lane is an
instrument; you fill it by playing a MIDI keyboard, humming or singing (turned into notes for the
lane's instrument), recording or importing audio, or by asking Hermes in the chat.

## Try this branch

From a source checkout of `feat/in-chat-songwriting`, in Bash, with a separate data home so the
experiment never touches your real one:

```sh
export HERMES_HOME="$HOME/hermes-songwriting-test"
export HERMES_RUNTIME_DIR="$HERMES_HOME/tools"
source ./activate
hermes setup
hermes plugins enable songwriting
HERMES_DESKTOP_USER_DATA_DIR="$HERMES_HOME/desktop-user-data" \
HERMES_DESKTOP_APP_NAME=HermesSongwritingTest \
HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION=1 \
hermes desktop --source --force-build --hermes-root "$PWD"
```

Do not use `hermes update` for this branch. Enable **Songwriting** in **Settings → Plugins**, then
start a new chat so Hermes sees the songwriting tool and skill.

## Using it

1. Ask Hermes to start a song, then press **Open in Songwriting** in its reply. The pane opens only
   when you click.
2. The first time, the pane asks to download the instruments: GeneralUser GS v2.0.3 (32 MB, free to
   use for your own music, private or commercial). The gateway fetches it once per profile and
   verifies it against a pinned SHA-256; Desktop caches it locally.
3. **Add lane**: pick *Play an instrument (MIDI)* or *Hum or sing → instrument*, then an instrument.
   *Audio recording* keeps a plain recording. Any lane's instrument can be changed later (all 128
   General MIDI instruments plus a drum kit).
4. Click a lane to select it. Your keyboard now plays that lane's instrument live, **Record** records
   onto it after a one-bar count-in with the other lanes playing, and "this lane" in the chat means
   it.
5. Voice lanes: your recording is pitch-tracked into notes (one note at a time works best) and plays
   as the lane's instrument. **Hear voice** / **Hear instrument** switches between your recording and
   the instrument.
6. Ask Hermes things like "add a bass lane, I'll play it", "make this a cello", or "write a string
   pad under the chorus". Lane setup happens directly; note changes arrive as a suggestion you
   **Preview**, then **Keep** or **Discard**. **Undo** reverts the last content change.

## How it works

- Desktop plays everything with SpessaSynth (Apache-2.0) and Web Audio: sampled instruments, live
  play-through, lookahead scheduling against the audio clock, metronome and count-in.
- The gateway stores lanes, recordings (immutable files) and suggestions per chat, and serves large
  files to Desktop as base64 chunks. It never renders audio.
- Hermes uses only the conversation's configured model and the `songwriting` tool; it cannot keep
  its own suggestions.

## Known limits

- No WAV export yet, no piano-roll editing, no quantize button, and no recording-latency
  compensation (MIDI and mic takes can land a few milliseconds late).
- Pitch tracking is monophonic and runs on the main thread (roughly 30 ms per second of audio).
- Up to 16 lanes; drum lanes share the General MIDI drum channel.
- For a public release, the instrument bank should be served from Nous-owned storage; its author
  asks that his download files not be hot-linked.

## Verified so far

Backend: 48 tests (lanes, recordings, suggestions, undo, session/profile isolation, crash-safe
storage, pinned instrument download). Desktop: 41 unit tests (client, pitch tracking, pane flows with
a fake engine, MIDI permission). In real Electron: the built app ships the synth worklet, and the
pinned bank loads and sounds (trumpet and drum notes measured non-silent). The Electron end-to-end
spec (`e2e/songwriting.spec.ts`, needs `HERMES_SONGWRITING_SF2`) could not run locally because its
sandboxed backend fails to start on this machine; real MIDI hardware, a real microphone and listening
have not been tested.
