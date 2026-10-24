# Experimental in-chat songwriting

This feature lives in the existing Hermes Desktop conversation. It does not add a music page, studio tab, separate application or live MIDI instrument.

## Enable the test build

Use a source checkout of `feat/in-chat-songwriting`. Build and launch the Desktop client from that checkout, not an already installed stable client. Use a separate Hermes data home while testing if you do not want experimental code to open existing user data. Do not run `hermes update` to install this branch: it is not the stable update channel.

For an isolated macOS source test, open a Bash shell (`bash`), then run:

```sh
git clone --branch feat/in-chat-songwriting https://github.com/geoza2000/hermes-agent.git hermes-songwriting
cd hermes-songwriting
export HERMES_HOME="$HOME/hermes-songwriting-test"
export HERMES_RUNTIME_DIR="$HERMES_HOME/tools"
source ./activate
hermes setup
hermes plugins enable songwriting
HERMES_DESKTOP_USER_DATA_DIR="$HERMES_HOME/desktop-user-data" \
HERMES_DESKTOP_APP_NAME=HermesSongwritingTest \
HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION=1 \
hermes desktop --source --hermes-root "$PWD"
```

`activate` uses Bash syntax; use Bash for that step. Setup configures the model through the normal secure local workflow. The explicit `--hermes-root` prevents accidentally pairing the experimental client with an older installed backend. The separate home and Desktop data directory keep the test independent of an existing installation; the protocol-registration flag prevents changing the normal `hermes://` handler. These are process-local development overrides, not production configuration.

The Desktop launcher prepares/builds source dependencies. This is a source-test procedure, not a signed/notarized installer or a stable-channel update.

Enable the backend plugin with the normal plugin command:

```sh
hermes plugins enable songwriting
```

Enable **Songwriting** in Desktop **Settings → Plugins**, then start a new conversation so the agent sees the plugin tool and skill without changing a cached conversation prompt.

Tell Hermes that you want to write a song from a MIDI take or microphone recording. The agent can embed its controls in a normal assistant reply:

```text
::songwriting
```

The directive is a small inline chat component, not navigation to another destination.

## Capture and sharing

- Choose an actual MIDI input and explicitly start recording. MIDI input produces visual acknowledgement only. Hermes does not open a MIDI output or monitor a virtual instrument.
- Keep the take, retake it or continue with a partial take after a device disconnects. Timing, note releases, velocity and controller messages remain in the original event data. MIDI capture stops locally at 20,000 messages or five minutes and keeps the bounded partial take, matching the gateway's save limits.
- When MIDI is absent or unavailable, use the microphone sampler or import an audio file. Microphone capture needs permission and an explicit start. A recording is audio, not a promise of accurate note or harmony extraction.
- Saving to a connected remote gateway is a network upload. Review the destination before saving. Sharing a saved take with the configured Hermes model is a separate explicit action.
- Device labels, imported metadata and raw musical input are data, not instructions to the agent.

## Default composition engine

The first implementation uses the **configured Hermes model to propose an editable symbolic instrumental arrangement**, followed by **local offline synthesized audio rendering**. It does not open another model client or require a second AI music subscription.

The agent reads the captured device name and events, discusses an editable brief in the conversation and proposes separate instrumental tracks. A drum rhythm can inform a keys part, but does not prove a key, chord progression or melody. A full song here means an instrumental arrangement, not generated singing or a licensed commercial waveform model.

The local patches are intentionally a lightweight sequencing engine. They are not a sampled concert piano, a live performance or evidence of commercial music-generation quality. Exact source events and editable note data are retained separately from the rendered audio.

External text-to-audio services remain a separate integration decision. They must not be presented as exact MIDI conditioning, guaranteed isolated instruments or automatic stems. Check current API capabilities, retention, cost and distribution licensing before adding one. No external audio service, paid call or model-weight download is implicit in this feature.

## Collaborate and listen

Use the chat to request a full arrangement, a single part or revisions to named tracks. The agent returns a scoped proposal, not an automatic overwrite. Review the proposed change, apply or reject it and undo an accepted revision. Original recorded/imported tracks stay protected.

The inline component provides per-track/mix playback and a single WAV export. Preserve the edit-ready project and original takes when exporting. Imported audio and synthesized MIDI parts have different provenance; a mixed import is not automatically an isolated instrument.

If a format needs FFmpeg and it is not available, decoding must fail visibly rather than inventing a track or reporting a successful export. Native WAV paths do not require a music-generation service. Separate pretrained stem extraction is not part of the initial local symbolic engine.

## Verification boundaries

Local development verification passed 68 backend/storage checks, 69 focused Desktop unit checks and two isolated Electron end-to-end cases, including persisted MIDI data, microphone decoding, reviewed Apply, mix rendering and native WAV export. The Desktop build, type checks, targeted lint and code-health checks also passed. Independent reviewers rechecked the backend storage and Desktop consent/lifecycle fixes.

The full Desktop unit suite is **not certified clean** by this handoff. Its local run exceeded five minutes and reported native/runtime harness failures, including missing `uv` on subprocess PATH and filesystem/native-helper cases. These are not replaced by the focused passing results.

Automated tests can exercise MIDI event handling with synthetic device input, session/profile isolation, stale revisions, protected takes and decoding of real rendered files. They do not establish real-device behavior, packaged macOS permission prompts or musical quality.

For hardware acceptance, connect your MIDI device and check discovery, note-on/off, controllers, disconnect recovery and capture fidelity. Test the microphone permission-denied path and another take after stopping. Audition mix and individual parts, then verify a downloaded WAV in another player. Report hardware, rendering, technical checks and listening as separate results.
