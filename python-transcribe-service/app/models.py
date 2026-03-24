from __future__ import annotations

from typing import Any
from pydantic import BaseModel


class IntakeRequestPayload(BaseModel):
    languageHint: str | None = None


class TranscriptionJobRequest(BaseModel):
    recordingId: str
    dropboxFileId: str
    dropboxPathLower: str | None = None
    fileName: str
    sourceBytes: int | None = None
    client_modified: str | None = None
    server_modified: str | None = None
    callbackUrl: str | None = None
    request: IntakeRequestPayload | None = None


class TranscriptSegment(BaseModel):
    speaker: str
    startMs: int | None = None
    endMs: int | None = None
    text: str


class TranscriptResult(BaseModel):
    fullText: str
    segments: list[TranscriptSegment]
    raw: Any = None


class WorkersCallbackPayload(BaseModel):
    recordingId: str
    dropboxFileId: str
    dropboxPathLower: str | None = None
    fileName: str
    sourceDurationSec: float | None = None
    transcript: TranscriptResult
