# In-chat songwriting backend

Optional native Hermes plugin. It registers the `songwriting` tool and bundled
`songwriting:in-chat-songwriting` skill; its hidden dashboard extension mounts the
REST API without adding a page. Enable it through the normal plugin controls in a
**test profile**, before starting the conversation. This checkout does not modify
any running installation or profile configuration.

## What it stores

A song (schema 2) is lanes plus immutable recordings. A lane has an `id`, `name`, General MIDI
`instrument` (`{program, drums}`), `source` (`midi`, `voice`, `audio` or `hermes`), editable
`notes` (`{startMs, durationMs, note, velocity}`, absolute song time), optional `audio`
(`{captureId, startMs, offsetMs, durationMs, mime}`), `play` (`notes` or `audio`) and mixer state
(`muted`, `solo`, `volume`). Songs written by 0.1 (`tracks`) are migrated on read; their files are
untouched. Desktop renders all sound; the gateway never synthesizes or decodes audio.

## Wire contract

Mount: `/api/plugins/songwriting`. Song routes are relative to `/sessions/{session_id}`.

| Route | Body | Response |
|---|---|---|
| `GET /project` | — | song; an empty song is read-only |
| `POST /settings` | `{title?, tempo?, selectedLaneId?}` | song |
| `POST /lanes` | `{name, instrument, source}` | `{project, lane}` |
| `POST /lanes/{id}` | `{name?, instrument?, muted?, solo?, volume?, play?}` | song |
| `POST /lanes/{id}/delete` | — | song |
| `POST /lanes/{id}/midi` | `{take: MidiTake, startMs}` | `{project, capturePath}` |
| `POST /lanes/{id}/audio` | `{name, mime, data(base64), durationMs, startMs, offsetMs, notes?}` | `{project, capturePath}` |
| `GET /captures/{captureId}/chunks/{n}` | — | `{index, chunks, mime, data}` (4 MiB base64 chunks) |
| `POST /apply` / `POST /reject` | `{proposalId}` | song |
| `POST /undo` | — | song |
| `GET /soundfont`, `POST /soundfont/install`, `GET /soundfont/chunks/{n}` | — | instrument bank status / chunks |

Content changes (lanes, notes, instruments, names, tempo, takes, kept suggestions) snapshot the
previous lanes for Undo (64 deep); mixer state is not history. Suggestions come only from the agent
tool (`propose`); each records a fingerprint of the lanes it touches, and Keep refuses (409) if any of
those lanes changed since, while edits to other lanes leave it valid.

## Session, persistence and safety

- Every request resolves `get_hermes_home()` and validates an **exact** session
  row through `SessionDB(read_only=True)` in that profile. Unknown IDs never
  create a song. Compression continuations share their durable conversation's
  song; forks/subagents do not inherit it.
- The agent tool accepts no session/path argument. It requires the calling
  runtime's `session_id` keyword context, so model arguments cannot redirect a
  write. Its actions are `read`, `read_capture`, `add_lane`, `set_lane`, `set_tempo` and `propose`; it cannot keep or discard suggestions.
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
  16 lanes, 10,000 notes per lane, 20 MiB per audio take,
  a 256 MiB per-song asset-admission budget. This check counts existing session
  regular files (raw takes and SQLite files) plus the
  current transaction's staged bytes before accepting another asset. It is
  **not** a hard limit on later SQLite database/history growth or its memory/page
  cache; there is no automatic source eviction or global quota manager.
  HTTP bodies are streamed and bounded before JSON
  validation (28 MiB audio, 4 MiB other routes), including chunked requests.
- The only download is the instrument bank, on the user's click: one pinned URL, size and SHA-256
  checked before it is published, never a partial file. No music service is called. The configured conversation LLM sees
  source events only when the agent reads them through the tool; audio uploads
  are not transcribed or sent to a secondary service.

## Verification

```sh
scripts/run_tests.sh tests/plugins/test_songwriting_api.py tests/plugins/test_songwriting_storage.py \
  tests/plugins/test_songwriting_tool.py tests/plugins/test_songwriting_soundfont.py
```
