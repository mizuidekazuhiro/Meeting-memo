from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, model_validator


class IntakeRequestPayload(BaseModel):
    languageHint: str | None = None


class TranscriptionJobRequest(BaseModel):
    recordingId: str
    dropboxFileId: str | None = None
    dropboxPathLower: str | None = None
    fileName: str
    sourceBytes: int | None = None
    sourceDurationSec: float | None = None
    client_modified: str | None = None
    server_modified: str | None = None
    callbackUrl: str | None = None
    request: IntakeRequestPayload | None = None

    @model_validator(mode='after')
    def validate_dropbox_identity(self) -> 'TranscriptionJobRequest':
        if not self.dropboxFileId and not self.dropboxPathLower:
            raise ValueError('dropboxFileId or dropboxPathLower is required')
        return self


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


class WorkersFailureCallbackPayload(BaseModel):
    recordingId: str
    dropboxFileId: str
    dropboxPathLower: str | None = None
    fileName: str
    status: Literal['failed'] = 'failed'
    failureStage: str
    errorSource: str
    errorMessage: str
    failedChunkIndex: int | None = None
    processingSeconds: float
    qualityReasons: list[str] | None = None
    qualityMetrics: dict[str, Any] | None = None
