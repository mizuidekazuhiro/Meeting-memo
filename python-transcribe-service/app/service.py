from __future__ import annotations

import json
import logging
import math
import os
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
from openai import OpenAI

from .config import (
    ENABLE_AUDIO_FALLBACK,
    FALLBACK_AUDIO_FORMAT,
    FFMPEG_PATH,
    FFPROBE_PATH,
    DIARIZATION_CHUNKING_STRATEGY,
    MAX_TRANSCRIBE_DURATION_SEC,
    PRIMARY_AUDIO_FORMAT,
    TARGET_CHUNK_DURATION_SEC,
    TMP_DIR,
    WORKERS_CALLBACK_TOKEN,
    WORKERS_CALLBACK_URL,
)
from .models import TranscriptResult, TranscriptSegment, TranscriptionJobRequest, WorkersCallbackPayload

logger = logging.getLogger('python-transcribe-service')
DIARIZATION_MODEL = 'gpt-4o-transcribe-diarize'
DIARIZED_RESPONSE_FORMAT = 'diarized_json'


class UpstreamParseError(RuntimeError):
    """Raised when upstream API succeeded but the response payload cannot be interpreted."""


class InputValidationError(RuntimeError):
    """Raised for invalid input payloads or generated artifacts."""


@dataclass
class SourceMetadata:
    duration_sec: float
    codec: str
    sample_rate: int | None
    channels: int | None
    container: str


@dataclass
class ChunkPlanEntry:
    chunk_index: int
    chunk_count: int
    start_offset_ms: int
    end_offset_ms: int
    estimated_duration_sec: float


@dataclass
class ChunkArtifact:
    path: Path
    extension: str
    mime_type: str
    bytes: int
    codec: str
    container: str
    sample_rate: int | None
    channels: int | None
    strategy: str
    validation_passed: bool
    chunk: ChunkPlanEntry


def build_chunk_plan(duration_sec: float, source_bytes: int) -> list[ChunkPlanEntry]:
    effective_target_duration = min(TARGET_CHUNK_DURATION_SEC, MAX_TRANSCRIBE_DURATION_SEC)
    chunk_count = max(
        1,
        math.ceil(duration_sec / effective_target_duration),
        math.ceil(source_bytes / (24 * 1024 * 1024)),
    )
    if chunk_count == 1:
        return [ChunkPlanEntry(0, 1, 0, math.ceil(duration_sec * 1000), duration_sec)]
    duration_ms = math.ceil(duration_sec * 1000)
    out: list[ChunkPlanEntry] = []
    for idx in range(chunk_count):
        start = math.floor(duration_ms * idx / chunk_count)
        end = duration_ms if idx == chunk_count - 1 else math.floor(duration_ms * (idx + 1) / chunk_count)
        out.append(ChunkPlanEntry(idx, chunk_count, start, end, max(0.001, (end - start) / 1000)))
    return out


def ffprobe_metadata(path: Path) -> SourceMetadata:
    cmd = [FFPROBE_PATH, '-v', 'error', '-show_entries', 'format=duration:stream=codec_name,sample_rate,channels', '-of', 'json', str(path)]
    result = subprocess.run(cmd, check=True, capture_output=True, text=True)
    payload = json.loads(result.stdout)
    stream = (payload.get('streams') or [{}])[0]
    duration = float((payload.get('format') or {}).get('duration') or 0)
    container = path.suffix.replace('.', '').lower() or 'unknown'
    return SourceMetadata(duration_sec=duration, codec=stream.get('codec_name') or 'unknown', sample_rate=int(stream['sample_rate']) if stream.get('sample_rate') else None, channels=stream.get('channels'), container=container)


def run_ffmpeg_chunk(source: Path, output: Path, start_offset_sec: float, duration_sec: float, fmt: str) -> None:
    if fmt == 'm4a':
        args = ['-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart']
    else:
        args = ['-c:a', 'pcm_s16le']
    cmd = [FFMPEG_PATH, '-y', '-ss', str(start_offset_sec), '-i', str(source), '-t', str(duration_sec), *args, str(output)]
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def validate_chunk(path: Path, expected_ext: str) -> tuple[bool, dict[str, Any]]:
    if not path.exists() or path.stat().st_size <= 0:
        return False, {'error': 'bytes must be > 0'}
    meta = ffprobe_metadata(path)
    if meta.duration_sec <= 0:
        return False, {'error': 'duration must be > 0'}
    ext = path.suffix.replace('.', '')
    if ext != expected_ext:
        return False, {'error': 'extension mismatch', 'extension': ext, 'expected': expected_ext}
    mime = 'audio/mp4' if expected_ext == 'm4a' else 'audio/wav'
    return True, {'duration': meta.duration_sec, 'codec': meta.codec, 'container': meta.container, 'sample_rate': meta.sample_rate, 'channels': meta.channels, 'mime_type': mime}


def parse_transcript_response(payload: dict[str, Any]) -> TranscriptResult:
    segments_raw = payload.get('diarized_segments') or payload.get('segments') or []
    segments = [
        TranscriptSegment(
            speaker=str(seg.get('speaker') or seg.get('speaker_label') or seg.get('speaker_id') or 'speaker_unknown'),
            startMs=int((seg.get('start_ms') or seg.get('start') or 0) * (1 if (seg.get('start_ms') or 0) >= 1000 else 1000)) if (seg.get('start_ms') or seg.get('start')) is not None else None,
            endMs=int((seg.get('end_ms') or seg.get('end') or 0) * (1 if (seg.get('end_ms') or 0) >= 1000 else 1000)) if (seg.get('end_ms') or seg.get('end')) is not None else None,
            text=(seg.get('text') or '').strip(),
        )
        for seg in segments_raw
        if (seg.get('text') or '').strip()
    ]
    full = (payload.get('text') or payload.get('transcript') or '').strip() or '\n'.join([f"[{s.speaker}] {s.text}" for s in segments])
    return TranscriptResult(fullText=full, segments=segments, raw=payload)


def normalize_transcription_response(response: Any) -> dict[str, Any]:
    if isinstance(response, dict):
        return response

    if hasattr(response, 'model_dump'):
        dumped = response.model_dump()
    else:
        dumped = response

    if isinstance(dumped, dict):
        return dumped

    if isinstance(dumped, str):
        try:
            parsed = json.loads(dumped)
        except json.JSONDecodeError as exc:
            raise UpstreamParseError(f'Failed to parse transcription response string as JSON: {exc}') from exc
        if not isinstance(parsed, dict):
            raise UpstreamParseError(
                f'Expected transcription response JSON object, got {type(parsed).__name__}'
            )
        return parsed

    raise UpstreamParseError(
        f'Unexpected transcription response type: {type(response).__name__} '
        f'(dumped={type(dumped).__name__})'
    )


def should_fallback(status_code: int, error_text: str) -> bool:
    return ENABLE_AUDIO_FALLBACK and 400 <= status_code < 500 and ('corrupted' in error_text.lower() or 'unsupported' in error_text.lower() or 'file' in error_text.lower())


def merge_results(results: list[tuple[ChunkPlanEntry, TranscriptResult]]) -> TranscriptResult:
    ordered = sorted(results, key=lambda item: item[0].chunk_index)
    segments: list[TranscriptSegment] = []
    full_texts: list[str] = []
    raw_parts: list[Any] = []
    for chunk, transcript in ordered:
        full_texts.append(transcript.fullText.strip())
        raw_parts.append(transcript.raw)
        for seg in transcript.segments:
            segments.append(TranscriptSegment(
                speaker=seg.speaker,
                startMs=(seg.startMs + chunk.start_offset_ms) if seg.startMs is not None else None,
                endMs=(seg.endMs + chunk.start_offset_ms) if seg.endMs is not None else None,
                text=seg.text,
            ))
    return TranscriptResult(fullText='\n\n'.join([t for t in full_texts if t]), segments=segments, raw=raw_parts)


class PipelineService:
    def __init__(self) -> None:
        self.openai = OpenAI(api_key=os.environ.get('OPENAI_API_KEY'))

    def transcribe_file(self, file_path: Path, language_hint: str | None) -> TranscriptResult:
        with file_path.open('rb') as fh:
            response = self.openai.audio.transcriptions.create(
                model=DIARIZATION_MODEL,
                file=fh,
                response_format=DIARIZED_RESPONSE_FORMAT,
                language=language_hint,
                chunking_strategy=DIARIZATION_CHUNKING_STRATEGY,
            )

        dumped = response.model_dump() if hasattr(response, 'model_dump') else response
        dumped_preview = dumped if isinstance(dumped, str) else repr(dumped)
        logger.info(
            'openai transcription response received',
            extra={
                'details': {
                    'model': DIARIZATION_MODEL,
                    'response_format': DIARIZED_RESPONSE_FORMAT,
                    'chunking_strategy': DIARIZATION_CHUNKING_STRATEGY,
                    'response_type': type(response).__name__,
                    'has_model_dump': hasattr(response, 'model_dump'),
                    'dumped_type': type(dumped).__name__,
                    'dumped_preview': dumped_preview[:500],
                }
            },
        )
        payload = normalize_transcription_response(response)
        return parse_transcript_response(payload)

    def callback_workers(self, payload: WorkersCallbackPayload, callback_url: str | None = None) -> None:
        final_url = callback_url or WORKERS_CALLBACK_URL
        if not final_url:
            raise RuntimeError('WORKERS_CALLBACK_URL is not configured')
        resp = httpx.post(final_url, json=payload.model_dump(), headers={'x-webhook-secret': WORKERS_CALLBACK_TOKEN}, timeout=60)
        resp.raise_for_status()

    def process(self, job: TranscriptionJobRequest, dropbox_fetcher) -> WorkersCallbackPayload:
        with tempfile.TemporaryDirectory(dir=TMP_DIR) as tmp:
            source = Path(tmp) / job.fileName
            source.write_bytes(dropbox_fetcher(job))
            source_meta = ffprobe_metadata(source)
            logger.info('source inspection', extra={'recordingId': job.recordingId, 'dropboxFileId': job.dropboxFileId, 'fileName': job.fileName, 'details': source_meta.__dict__})
            plan = build_chunk_plan(source_meta.duration_sec, job.sourceBytes or source.stat().st_size)
            results: list[tuple[ChunkPlanEntry, TranscriptResult]] = []
            for entry in plan:
                preferred_formats = [PRIMARY_AUDIO_FORMAT]
                if ENABLE_AUDIO_FALLBACK and FALLBACK_AUDIO_FORMAT != PRIMARY_AUDIO_FORMAT:
                    preferred_formats.append(FALLBACK_AUDIO_FORMAT)
                last_error: Exception | None = None
                for idx, fmt in enumerate(preferred_formats):
                    ext = 'm4a' if fmt == 'm4a' else 'wav'
                    out = Path(tmp) / f"part-{entry.chunk_index + 1:03d}.{ext}"
                    run_ffmpeg_chunk(source, out, entry.start_offset_ms / 1000, entry.estimated_duration_sec, fmt)
                    ok, details = validate_chunk(out, ext)
                    logger.info('chunk prepared', extra={'recordingId': job.recordingId, 'dropboxFileId': job.dropboxFileId, 'fileName': job.fileName, 'details': {'chunkIndex': entry.chunk_index + 1, 'chunkCount': entry.chunk_count, 'startOffsetMs': entry.start_offset_ms, 'estimatedDurationSec': entry.estimated_duration_sec, 'bytes': out.stat().st_size, 'extension': f'.{ext}', 'mimeType': details.get('mime_type'), 'codec': details.get('codec'), 'container': details.get('container'), 'sampleRate': details.get('sample_rate'), 'channels': details.get('channels'), 'strategy': 'reencoded-aac-m4a' if ext == 'm4a' else 'fallback-pcm-wav', 'validationPassed': ok}})
                    if not ok:
                        raise InputValidationError(f"chunk validation failed: {details}")
                    try:
                        transcript = self.transcribe_file(out, job.request.languageHint if job.request else None)
                        results.append((entry, transcript))
                        last_error = None
                        break
                    except Exception as exc:  # noqa: BLE001
                        last_error = exc
                        if idx == 0 and ext == 'm4a':
                            status = getattr(exc, 'status_code', 500)
                            error_text = str(exc)
                            if should_fallback(status, error_text):
                                continue
                        raise
                if last_error:
                    raise last_error

            merged = merge_results(results)
            return WorkersCallbackPayload(
                recordingId=job.recordingId,
                dropboxFileId=job.dropboxFileId,
                dropboxPathLower=job.dropboxPathLower,
                fileName=job.fileName,
                sourceDurationSec=source_meta.duration_sec,
                transcript=merged,
            )
