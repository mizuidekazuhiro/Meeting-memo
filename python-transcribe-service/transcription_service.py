from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

from openai import OpenAI

from config import SETTINGS
from ffmpeg_utils import ChunkPlanEntry, build_chunk_plan, ffprobe_metadata, run_ffmpeg_chunk, validate_chunk
from logging_utils import get_logger, log_event
from models import TranscriptResult, TranscriptSegment, TranscriptionJobRequest, WorkersCallbackPayload

logger = get_logger()


def should_fallback(status_code: int, error_text: str) -> bool:
    text = error_text.lower()
    return SETTINGS.enable_audio_fallback and 400 <= status_code < 500 and any(token in text for token in ('corrupted', 'unsupported', 'file'))


def parse_transcript_response(payload: dict[str, Any]) -> TranscriptResult:
    segments_raw = payload.get('diarized_segments') or payload.get('segments') or []
    segments: list[TranscriptSegment] = []
    for seg in segments_raw:
        text = (seg.get('text') or '').strip()
        if not text:
            continue
        start_value = seg.get('start_ms') if seg.get('start_ms') is not None else seg.get('start')
        end_value = seg.get('end_ms') if seg.get('end_ms') is not None else seg.get('end')
        start_ms = int(start_value if seg.get('start_ms') is not None else float(start_value or 0) * 1000) if start_value is not None else None
        end_ms = int(end_value if seg.get('end_ms') is not None else float(end_value or 0) * 1000) if end_value is not None else None
        segments.append(TranscriptSegment(
            speaker=str(seg.get('speaker') or seg.get('speaker_label') or seg.get('speaker_id') or 'speaker_unknown'),
            startMs=start_ms,
            endMs=end_ms,
            text=text,
        ))
    full_text = (payload.get('text') or payload.get('transcript') or '').strip() or '\n'.join(f'[{seg.speaker}] {seg.text}' for seg in segments)
    return TranscriptResult(fullText=full_text, segments=segments, raw=payload)


def merge_results(results: list[tuple[ChunkPlanEntry, TranscriptResult]]) -> TranscriptResult:
    ordered = sorted(results, key=lambda item: item[0].chunk_index)
    full_texts: list[str] = []
    merged_segments: list[TranscriptSegment] = []
    raw_parts: list[Any] = []
    for chunk, result in ordered:
        full_texts.append(result.fullText)
        raw_parts.append(result.raw)
        for seg in result.segments:
            merged_segments.append(
                TranscriptSegment(
                    speaker=seg.speaker,
                    startMs=(seg.startMs + chunk.start_offset_ms) if seg.startMs is not None else None,
                    endMs=(seg.endMs + chunk.start_offset_ms) if seg.endMs is not None else None,
                    text=seg.text,
                )
            )
    return TranscriptResult(fullText='\n\n'.join(t.strip() for t in full_texts if t.strip()), segments=merged_segments, raw=raw_parts)


class TranscriptionService:
    def __init__(self) -> None:
        self.openai = OpenAI(api_key=SETTINGS.openai_api_key)

    def transcribe_file(self, file_path: Path, language_hint: str | None) -> TranscriptResult:
        with file_path.open('rb') as handle:
            response = self.openai.audio.transcriptions.create(
                model='gpt-4o-transcribe-diarize',
                file=handle,
                response_format='diarized_json',
                language=language_hint,
            )
        dumped = response.model_dump() if hasattr(response, 'model_dump') else response
        return parse_transcript_response(dumped)

    def process(self, job: TranscriptionJobRequest, source_bytes: bytes) -> WorkersCallbackPayload:
        with tempfile.TemporaryDirectory(dir=SETTINGS.tmp_dir) as tmp_dir:
            source_path = Path(tmp_dir) / job.fileName
            source_path.write_bytes(source_bytes)

            source_meta = ffprobe_metadata(source_path)
            if source_meta.duration_sec <= 0:
                raise RuntimeError('invalid source: duration must be > 0')
            plan = build_chunk_plan(source_meta.duration_sec, job.sourceBytes or len(source_bytes))
            results: list[tuple[ChunkPlanEntry, TranscriptResult]] = []

            for chunk in plan:
                formats = [SETTINGS.primary_audio_format]
                if SETTINGS.enable_audio_fallback and SETTINGS.fallback_audio_format != SETTINGS.primary_audio_format:
                    formats.append(SETTINGS.fallback_audio_format)

                transcribed = False
                for index, fmt in enumerate(formats):
                    ext = 'm4a' if fmt == 'm4a' else 'wav'
                    output = Path(tmp_dir) / f'part-{chunk.chunk_index + 1:03d}.{ext}'
                    run_ffmpeg_chunk(source_path, output, chunk.start_offset_ms / 1000, chunk.estimated_duration_sec, fmt)
                    ok, details = validate_chunk(output, ext)
                    if not ok:
                        raise RuntimeError(f'chunk validation failed: {details}')

                    try:
                        result = self.transcribe_file(output, job.request.languageHint if job.request else None)
                        results.append((chunk, result))
                        transcribed = True
                        break
                    except Exception as exc:  # noqa: BLE001
                        status_code = getattr(exc, 'status_code', 500)
                        error_text = str(exc)
                        log_event(logger, 'error', 'openai transcription failed', chunkIndex=chunk.chunk_index, responseStatus=status_code, responseText=error_text)
                        if index == 0 and fmt == 'm4a' and should_fallback(status_code, error_text):
                            continue
                        raise RuntimeError(f'Transcription request failed for chunk {chunk.chunk_index}: {error_text}') from exc

                if not transcribed:
                    raise RuntimeError(f'Unable to transcribe chunk {chunk.chunk_index}')

            merged = merge_results(results)
            return WorkersCallbackPayload(
                recordingId=job.recordingId,
                dropboxFileId=job.dropboxFileId or '',
                dropboxPathLower=job.dropboxPathLower,
                fileName=job.fileName,
                sourceDurationSec=source_meta.duration_sec,
                transcript=merged,
            )
