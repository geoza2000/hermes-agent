"""Bounded, vendor-neutral wire models for the in-chat songwriting plugin."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_DURATION_MS = 300_000
MAX_AUDIO_BYTES = 20 * 1024 * 1024


class Wire(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class Device(Wire):
    id: str = Field(max_length=256)
    name: str = Field(max_length=256)
    manufacturer: str = Field(max_length=256)


class MidiEvent(Wire):
    timeMs: float = Field(ge=0, le=MAX_DURATION_MS)
    data: list[int] = Field(min_length=1, max_length=256)

    @model_validator(mode="after")
    def valid_message(self):
        if any(not 0 <= byte <= 255 for byte in self.data):
            raise ValueError("MIDI bytes must be in 0..255")
        status = self.data[0]
        if status < 128:
            raise ValueError("MIDI messages require a status byte")
        if status < 240:
            size = 2 if status >> 4 in (12, 13) else 3
            if len(self.data) != size or any(b > 127 for b in self.data[1:]):
                raise ValueError("Invalid channel MIDI message")
        return self


class MidiTake(Wire):
    schema_version: Literal[1] = Field(alias="schema")
    kind: Literal["midi"]
    device: Device
    durationMs: float = Field(gt=0, le=MAX_DURATION_MS)
    events: list[MidiEvent] = Field(max_length=20_000)

    @model_validator(mode="after")
    def ordered_events(self):
        previous = 0
        for event in self.events:
            if event.timeMs < previous or event.timeMs > self.durationMs:
                raise ValueError("MIDI events must be ordered and within the take")
            previous = event.timeMs
        return self


class Note(Wire):
    startMs: float = Field(ge=0, le=MAX_DURATION_MS)
    durationMs: float = Field(gt=0, le=MAX_DURATION_MS)
    note: int = Field(ge=0, le=127)
    velocity: int = Field(ge=1, le=127)

    @model_validator(mode="after")
    def bounded_end(self):
        if self.startMs + self.durationMs > MAX_DURATION_MS:
            raise ValueError("Note exceeds maximum song duration")
        return self


class SongTrack(Wire):
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,80}$")
    name: str = Field(min_length=1, max_length=120)
    kind: Literal["midi", "audio"]
    origin: Literal["recorded", "generated", "imported", "separated"]
    protected: bool
    instrument: Literal["piano", "bass", "drums", "pad", "lead"] | None = None
    notes: list[Note] | None = Field(default=None, max_length=5000)
    path: str | None = Field(default=None, max_length=2048)
    durationMs: float | None = Field(default=None, gt=0, le=MAX_DURATION_MS)
    muted: bool = False

    @model_validator(mode="after")
    def has_source(self):
        if self.kind == "midi" and self.notes is None:
            raise ValueError("MIDI tracks require symbolic notes")
        if self.kind == "audio" and (not self.path or self.notes is not None):
            raise ValueError("Audio tracks require a path, not symbolic notes")
        return self


class AudioRequest(Wire):
    name: str = Field(min_length=1, max_length=120)
    mime: str = Field(min_length=1, max_length=128)
    data: str = Field(min_length=1, max_length=(MAX_AUDIO_BYTES + 2) // 3 * 4)


class RenderRequest(Wire):
    trackIds: list[str] | None = Field(default=None, max_length=32)


class ProposalRequest(Wire):
    baseRevision: int = Field(ge=0)
    brief: str = Field(min_length=1, max_length=8000)
    tracks: list[SongTrack] = Field(min_length=1, max_length=32)


class ApplyRequest(Wire):
    proposalId: str = Field(pattern=r"^[a-f0-9]{32}$")
    baseRevision: int = Field(ge=0)


class RejectRequest(Wire):
    proposalId: str = Field(pattern=r"^[a-f0-9]{32}$")


class UndoRequest(Wire):
    baseRevision: int = Field(ge=0)


def symbolic_notes(take: MidiTake) -> list[dict]:
    """Derive playback notes; raw channel/controller messages remain in the immutable take."""
    active, released, pedal, notes = {}, {}, set(), []

    def finish(key, at):
        start, velocity = active.pop(key)
        if at > start:
            notes.append({"startMs": start, "durationMs": at - start,
                          "note": key[1], "velocity": velocity})
        released.pop(key, None)

    for event in take.events:
        status, *data = event.data
        channel, command = status & 15, status >> 4
        if command in (8, 9):
            key = (channel, data[0])
            if command == 9 and data[1]:
                if key in active:
                    finish(key, event.timeMs)
                active[key] = (event.timeMs, data[1])
            elif key in active:
                if channel in pedal:
                    released[key] = True
                else:
                    finish(key, event.timeMs)
        elif command == 11 and data[0] == 64:
            if data[1] >= 64:
                pedal.add(channel)
            else:
                pedal.discard(channel)
                for key in list(released):
                    if key[0] == channel:
                        finish(key, event.timeMs)
        elif command == 11 and data[0] in (120, 123):
            for key in list(active):
                if key[0] == channel:
                    finish(key, event.timeMs)
    for key in list(active):
        finish(key, take.durationMs)
    return sorted(notes, key=lambda n: (n["startMs"], n["note"]))
