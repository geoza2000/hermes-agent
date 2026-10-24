# In-chat songwriting backend

Optional native Hermes plugin. It registers the `songwriting` tool and bundled
`songwriting:in-chat-songwriting` skill; its hidden dashboard extension mounts the
REST API without adding a page. Enable it through the normal plugin controls in a
**test profile**, before starting the conversation. This checkout does not modify
any running installation or profile configuration.

## Engine and source fidelity

The configured Hermes conversation model writes editable symbolic instrumental
parts. A deterministic local oscillator/percussion sequencer renders them; **this
is sequenced synthesis, not a trained waveform model, vocal generation, stem
separation, or a live hosted instrument**. No additional LLM client, music vendor,
external upload, account, or paid service is used.

Raw MIDI device metadata and event bytes (including channel/controller/system
messages) remain in immutable JSON take files. Playback derives note-on/off,
retrigger, sustain and all-notes-off events; a channel-10-only capture is rendered
as drums, other captures default to piano. Pitch bends, program changes and other
controllers are retained but not emulated. Original uploaded audio bytes remain
untouched beside a decoded PCM playback copy; imports are mixed at time zero,
not automatically transcribed, aligned or separated.

PCM16 mono/stereo WAV is decoded/resampled using Python's standard library.
Other supported audio encodings use local ffmpeg resolved via
`hermes_platform.resolver.locate_command`, with argv (no shell), a forced
container demuxer, file/pipe-only protocols, a profile-scoped scrubbed child
environment, a 30-second timeout and bounded decoded output. Missing/failed
local decoding returns a visible error; no placeholder audio is substituted.

## Stable wire contract

Mount: `/api/plugins/songwriting`.

`SongProject`:

```ts
{
  schema: 1, id: string, title: string, revision: number, brief: string,
  tracks: SongTrack[], captures: CaptureSummary[], proposal?: SongProposal
}
```

`SongTrack` matches Desktop's shared contract:
`{id,name,kind:'midi'|'audio',origin:'recorded'|'generated'|'imported'|'separated',protected,instrument?:'piano'|'bass'|'drums'|'pad'|'lead',notes?:[{startMs,durationMs,note,velocity}],path?,durationMs?,muted?}`.

`CaptureSummary` is `{id,kind,name,path,durationMs,mime?,playbackPath?}`. `path`
always names the immutable raw take/upload; an audio track's `path` names the
owned decoded PCM copy. Optional audio `playbackPath` identifies that same copy.

`SongProposal` is `{id,baseRevision,tracks,brief}`. Pending proposal creation and
rejection leave the project revision unchanged; IDs bind the exact reviewed
proposal. Capture/apply/undo increment the revision monotonically. Capturing a
new source invalidates a pending proposal.

| Endpoint relative to `/sessions/{session_id}` | Body | Response |
|---|---|---|
| `GET /project` | — | `SongProject`; an empty project is read-only |
| `POST /captures` | original `{schema:1,kind:'midi',device:{id,name,manufacturer},durationMs,events:[{timeMs,data:number[]}]}` | `{project,capturePath}` |
| `POST /audio` | `{name,mime,data}`; data is strict base64 | `{project,capturePath}` |
| `POST /proposal` | `{baseRevision,brief,tracks}` | `{project,proposal}` |
| `POST /apply` | `{proposalId,baseRevision}` | `SongProject` |
| `POST /reject` | `{proposalId}` | `SongProject` |
| `POST /undo` | `{baseRevision}` | `SongProject` |
| `POST /render` | `{trackIds?:string[]}` | `{path,mime:'audio/wav',durationMs}` |
| `POST /export` | `{trackIds?:string[]}` | same; **one actual mixed WAV**, not a stem archive |

No essential wire-contract changes. MIME codec parameters from MediaRecorder
are accepted. The endpoints emit 409 for stale revisions or obsolete proposal
IDs; invalid requests emit 400/422, absent sessions 404, inaccessible/corrupt
storage 503. Rendered output is 24 kHz mono PCM16 WAV. A selected single track
is a stem; omit `trackIds` to mix every unmuted track. An empty explicit selection
is invalid rather than silently exporting everything.

Proposals add new IDs or replace only the named, unprotected generated MIDI
tracks. They cannot replace, remove or modify protected recorded/imported
sources. Other tracks remain unchanged. Applying is explicit; the agent tool
cannot apply/reject/undo. Undo removes/restores only the prior proposal's named
generated tracks and brief, retaining any source captured after that apply.
The most recent 32 applied edits can be undone.

## Session, persistence and safety

- Every request resolves `get_hermes_home()` and validates an **exact** session
  row through `SessionDB(read_only=True)` in that profile. Unknown IDs never
  create a song. Compression continuations share their durable conversation's
  song; forks/subagents do not inherit it.
- The agent tool accepts no session/path argument. It requires the calling
  runtime's `session_id` keyword context, so model arguments cannot redirect a
  write. Its actions are `read`, `read_capture`, `propose`, `render`, `export`.
- State lives under `plugin_data_dir('songwriting')/sessions/<durable-id>/`,
  never in the plugin install directory. No home is cached at module import.
- SQLite `BEGIN IMMEDIATE` serializes revision checks, project changes and undo
  history across processes. Both read and write connections use the host's
  tracked SQLite lifecycle so dashboard byte reads cannot cancel POSIX locks.
  Source/render files are fsynced in private staging, then atomically linked
  under unique names after validation, decoding and project serialization.
  An asset mapping commits with the project; a confirmed rollback removes the
  new files. A late commit exception returns success only if the asset rows
  survive rollback, keeping committed sources and returning the export path.
  Unknown outcomes retain staging receipts rather than guessing or deleting
  sources. The next locked write reconciles at most 64 receipts, preserving
  committed assets and removing rolled-back/interrupted publications. Cleanup
  I/O failures log a payload-free warning and retain receipts for retry.
  Session folders are private; assets use mode 0600.
- Symlinked storage/source paths and traversal are refused. Audio playback is
  restricted to that session's registered upload copies. Proposed audio/file
  paths are not accepted. Failures do not echo source payloads, decoder stderr,
  database paths or credentials.
- Maximum: five minutes per take/song, 20,000 MIDI messages, 256 bytes/message,
  32 tracks, 5,000 notes per proposed track, 20 MiB original audio upload,
  a 256 MiB per-song asset-admission budget. This check counts existing session
  regular files (raw sources, PCM copies, mixes and SQLite files) plus the
  current transaction's staged bytes before accepting another asset. It is
  **not** a hard limit on later SQLite database/history growth or its memory/page
  cache; there is no automatic source eviction or global quota manager.
  HTTP bodies are streamed and bounded before JSON
  validation (28 MiB audio, 4 MiB other routes), including chunked requests.
  Synthesis has an 80-million-sample work cap and a 30-second wall-time budget;
  overly dense arrangements fail visibly and can be rendered in smaller groups.
- No network music services are called. The configured conversation LLM sees
  source events only when the agent reads them through the tool; audio uploads
  are not transcribed or sent to a secondary service.

## Verification

Canonical focused tests:

```sh
HERMES_PYTHON=/path/to/isolated/test-env/bin/python \
  scripts/run_tests.sh tests/plugins/test_songwriting_api.py \
  tests/plugins/test_songwriting_audio.py tests/plugins/test_songwriting_tool.py \
  tests/plugins/test_songwriting_storage.py
```

The tests exercise actual native discovery/registration and dashboard mounting,
raw source readback, mono WAV sample checks, real local Opus/WebM decoding when
ffmpeg exists (visible missing-decoder failure otherwise), every synthesizer,
source retention through apply/undo, exact session/profile isolation,
compression continuity, stale/parallel applies, cross-process lock safety,
transaction/crash recovery, empty resampling, limits, symlink refusal, error
redaction and disk corruption. Synthetic MIDI/audio fixtures test the plumbing;
they are not proof of physical hardware capture or musical audition.
