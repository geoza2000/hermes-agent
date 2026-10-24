---
name: in-chat-songwriting
description: Use when writing songs in the current conversation.
version: 0.1.0
author: George / Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [songwriting, midi, audio, desktop]
    category: creative
---

# In-chat Songwriting Skill

Collaborate on songs inside the existing chat. Keep untouched takes and editable instrumental parts; the first engine is this conversation's configured Hermes LLM plus local offline sequenced synthesis, **not a trained waveform music model**, vocal generator, or authentic recorded instrumentalist.

## When to Use

Normal requests to write a song, arrange a take, add parts, record an idea, or revise an existing song in Hermes Desktop. A complete song may be an instrumental arrangement; do not promise generated vocals.

## Prerequisites

The optional songwriting plugin and the Desktop inline card must be enabled before the conversation starts. PCM16 WAV works without a decoder; compressed microphone/imported audio requires local ffmpeg. Never configure another LLM client, upload recordings, call a paid music service, or ask for secrets.

## How to Run

For ordinary songwriting intent, emit this literal marker **on its own paragraph**, outside code fences, in the assistant reply:

::songwriting

Do not create or navigate to an app, page, studio, or project editor. The inline card handles permission, device discovery, explicit recording start, capture, review and players. Recording is quiet event capture, not a hosted live instrument.

## Quick Reference

- `songwriting(action='read')`: current project, revision, protected tracks and capture IDs.
- `songwriting(action='read_capture', captureId='…')`: the actual immutable MIDI take including device metadata, all event bytes/channels/controllers, or original audio metadata. Never invent take contents.
- `songwriting(action='propose', baseRevision=N, brief='…', tracks=[…])`: stage named generated parts, never autoapply.
- `songwriting(action='render', trackIds=['…'])`: one-track or selected-part WAV.
- `songwriting(action='export')`: one actual mixed WAV including retained imported audio.

No session identifier or path argument is accepted: the runtime binds the calling conversation and profile. Apply/reject/undo are human actions in the inline card, not agent tool actions.

## Procedure

1. Open the inline card with the marker. Ask whether the idea is a whole instrumental song, a single part, or an additive layer only when the request does not already say.
2. Read the project and each relevant capture via `songwriting`. Preserve the original performance, timing and backing unless broader rearrangement is requested. Drum note numbers do not establish musical key; label uncertain tempo/harmony rather than asserting it.
3. Write a concise, editable, copyable brief in the reply: intent, approximate tempo/meter if supported, section plan, desired instruments and changes. Do not turn uncertain source analysis into claims of audio transcription.
4. Compose structured symbolic tracks with meaningful stable IDs. Each track is `{id,name,kind:'midi',origin:'generated',protected:false,instrument,notes:[{startMs,durationMs,note,velocity}]}`. Instruments: piano, bass, drums, pad, lead. Note 0..127, velocity 1..127, positive duration, absolute millisecond timing, maximum five minutes. Consider musical density and dynamics; use shorter notes rather than thousands of overlapping sustained notes.
5. Propose only new IDs or named generated track IDs being replaced, with the revision just read. Other parts stay unchanged. Never replace protected recorded/imported sources, silently remove parts, or claim that proposed parts are already audible. The brief is stored with the proposal and becomes active only on apply.
6. Ask the user to review/apply or reject in the same card. On a stale revision, re-read the project, reconsider the exact changes and create a new proposal; never retry with an unreviewed revision blindly.
7. After apply, render actual stems and a mix through `songwriting`, not imagined paths. Attach the returned WAV locally where the host supports file/audio attachments, retaining the score and raw source. State that the engine is local sequenced synthesis and identify imported originals. No source separation or voice preservation beyond retaining the original audio is claimed.

## Pitfalls

- A marker, UI mock, test fixture or edited brief is not a real recording or audio result.
- Symbolic playback derives note-on/off and sustain approximately; raw MIDI channels, program changes, pitch bends and controllers remain intact separately but are not a full GM hardware emulation.
- Imports are mixed at time zero with the score; do not claim automatic tempo alignment, stem separation or transcription.
- Do not use `terminal`, `write_file` or generic file tools to bypass review, overwrite song state, change protected sources or fake an applied proposal.
- Changing the pending proposal invalidates older approval buttons. Capture and apply revisions are fenced; refresh after new takes.

## Verification

Verify the tool returned a real WAV and duration. Distinguish audio rendering, technical verification and human audition: none implies the others. Ask for listening feedback about balance, timing or the chosen part; do not describe the arrangement as musically approved until it has been heard.
