"""Bounded wire models for the songwriting lanes: instruments, takes and reviewed edits."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_DURATION_MS = 300_000
MAX_AUDIO_BYTES = 20 * 1024 * 1024
HIT_MS = 100


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


LANE_ID = r"^[a-zA-Z0-9_-]{1,80}$"
MAX_LANES = 16  # One MIDI channel per lane; drum lanes share the GM drum channel.
MAX_NOTES = 10_000


class Instrument(Wire):
    """A General MIDI program, or the drum kit when ``drums`` is set."""
    program: int = Field(ge=0, le=127)
    drums: bool = False


class LaneChange(Wire):
    """One reviewed edit: rewrite an existing lane, add a new one, or remove one."""
    laneId: str = Field(pattern=LANE_ID)
    name: str | None = Field(default=None, min_length=1, max_length=80)
    instrument: Instrument | None = None
    notes: list[Note] | None = Field(default=None, max_length=MAX_NOTES)
    remove: bool = False

    @model_validator(mode="after")
    def says_something(self):
        if self.remove and (self.notes is not None or self.instrument or self.name):
            raise ValueError("A removal carries no other changes")
        if not self.remove and self.notes is None and self.instrument is None and self.name is None:
            raise ValueError("A lane change needs notes, an instrument or a name")
        return self


class AddLaneRequest(Wire):
    name: str = Field(min_length=1, max_length=80)
    instrument: Instrument
    source: Literal["midi", "voice", "audio"]


class UpdateLaneRequest(Wire):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    instrument: Instrument | None = None
    muted: bool | None = None
    solo: bool | None = None
    volume: float | None = Field(default=None, ge=0, le=1)
    play: Literal["notes", "audio"] | None = None


class MidiTakeRequest(Wire):
    take: MidiTake
    # Where the take starts on the song timeline, so overdubs line up with the other lanes.
    startMs: float = Field(default=0, ge=0, le=MAX_DURATION_MS)


class AudioTakeRequest(Wire):
    name: str = Field(min_length=1, max_length=120)
    mime: str = Field(min_length=1, max_length=128)
    data: str = Field(min_length=1, max_length=(MAX_AUDIO_BYTES + 2) // 3 * 4)
    durationMs: float = Field(gt=0, le=MAX_DURATION_MS)
    startMs: float = Field(default=0, ge=0, le=MAX_DURATION_MS)
    # Where in the file the song-aligned audio begins: a take records through the count-in.
    offsetMs: float = Field(default=0, ge=0, le=MAX_DURATION_MS)
    # Pitch-tracked notes from Desktop; the recording itself stays the immutable source.
    notes: list[Note] | None = Field(default=None, max_length=MAX_NOTES)


class SongSettingsRequest(Wire):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    tempo: int | None = Field(default=None, ge=40, le=240)
    selectedLaneId: str | None = Field(default=None, pattern=LANE_ID)


class ProposalRequest(Wire):
    brief: str = Field(min_length=1, max_length=8000)
    changes: list[LaneChange] = Field(min_length=1, max_length=MAX_LANES)


class ApplyRequest(Wire):
    proposalId: str = Field(pattern=r"^[a-f0-9]{32}$")


class RejectRequest(Wire):
    proposalId: str = Field(pattern=r"^[a-f0-9]{32}$")


def symbolic_notes(take: MidiTake) -> list[dict]:
    """Derive playback notes; raw channel/controller messages remain in the immutable take."""
    active, released, pedal, notes = {}, {}, set(), []

    def finish(key, at):
        start, velocity = active.pop(key)
        # Drum pads send note-off in the same instant as note-on; a hit still has a sound.
        duration = min(at - start if at > start else HIT_MS, MAX_DURATION_MS - start)
        if duration > 0:
            notes.append({"startMs": start, "durationMs": duration, "note": key[1], "velocity": velocity})
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
